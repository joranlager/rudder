// AIS ships as 3D models on the chart, once the scale bar reads 200 m or less (scalebar.js).
//
// A MapLibre custom layer draws them with three.js in the map's own WebGL context, so they sit on the
// chart, turn and tilt with it, and are hidden by nothing but each other. Each ship is built by the
// ship inspector's builder (ships/ship.js) from its AIS report, as "Open 3D model" does, and kept
// until it leaves the view. Only the part above the waterline is drawn: the chart is the sea.
//
// The ships move by themselves: every frame each model is placed where dead reckoning from its last
// AIS report puts it (motion.js), and new reports are eased in. While any ship is under way the map
// is redrawn about 30 times a second; when all lie still, it is redrawn only when needed.
//
// three.js (about 0.7 MB) and the builder are loaded the first time models are needed.

import { drawHeading, vesselSize, hullFromAis } from './ais.js';
import { createMotion, hitsShip, bowAndStern } from './motion.js';

export const MAX_MODELS = 40;
const FRAME_MS = 33; // about 30 frames a second while ships move: smooth, and kind to the battery // nearest to the middle of the view; a harbour seldom has more in view
const LAYER_ID = 'ais-models';

/**
 * Where and how a ship's model goes, in the layer's frame: x east, y up, z south (metres), with the
 * model's own frame bow +x, starboard +z, waterline y = 0. null when the heading or size is unknown.
 * - rotationY turns the bow from +x to the heading (clockwise from north);
 * - antenna is the GPS antenna's place in the model, which is put on the reported position.
 */
export function modelPlacement(v) {
  const hdg = drawHeading(v);
  const { length, beam, toBow, toPort } = vesselSize(v);
  if (hdg === null || !(length > 2) || !(beam > 1)) return null;
  return {
    heading: hdg,
    rotationY: Math.PI / 2 - (hdg * Math.PI) / 180,
    antenna: { x: length / 2 - toBow, z: -beam / 2 + toPort },
  };
}

export const MAP_TEXTURE_PX = 1024;

/** Size of a painted texture for the chart: at most MAP_TEXTURE_PX on its longer side. */
export function mapTextureSize(w, h, max = MAP_TEXTURE_PX) {
  const k = Math.min(1, max / Math.max(w, h));
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

/**
 * The inspector paints hulls 4096 px wide for close-ups; on the chart a ship is a few hundred pixels
 * long at most, so a smaller copy looks the same and keeps dozens of ships within GPU memory.
 */
function shrinkTexture(THREE, material) {
  const src = material?.map?.image;
  if (!src?.width) return;
  const [w, h] = mapTextureSize(src.width, src.height);
  if (w === src.width && h === src.height) return;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(src, 0, 0, w, h);
  const old = material.map;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = old.colorSpace;
  tex.anisotropy = 4;
  material.map = tex;
  old.dispose();
  src.width = src.height = 0; // let the big canvas go
}

/** A model is rebuilt only when what it is built from changes, not when the ship moves. */
export function modelKey(v) {
  const { params } = hullFromAis(v);
  return [params.kind, params.length, params.beam, params.draft, (v.name || '').trim()].join('|');
}

/** The ships to model: placeable, in (or near) the view, nearest the middle first, at most `max`. */
export function pickShips(vessels, [w, s, e, n], [cx, cy], max = MAX_MODELS) {
  const out = [];
  for (const v of vessels) {
    if (v.longitude < w || v.longitude > e || v.latitude < s || v.latitude > n) continue;
    if (!modelPlacement(v)) continue;
    const dx = (v.longitude - cx) * Math.cos((cy * Math.PI) / 180), dy = v.latitude - cy;
    out.push([dx * dx + dy * dy, v]);
  }
  return out.sort((a, b) => a[0] - b[0]).slice(0, max).map(([, v]) => v);
}

/**
 * The model layer. `setShips(list)` gives the vessels to show (empty to show none); models are made
 * a few per frame, within a time budget, so a busy harbour does not freeze the map.
 */
export function createShipModels(map) {
  let lib = null; // { THREE, buildShip, DEFAULT_LIVERY, HULL_FONTS } once loaded
  let loading = null;
  let scene = null, camera = null, renderer = null;
  const models = new Map(); // mmsi -> { key, root, model, v, place, shown }
  const motion = createMotion();
  let frameTimer = 0;
  let wanted = []; // vessels to show
  let building = false, dirty = false;

  async function load() {
    loading ??= Promise.all([
      import('./vendor/three.js'), import('./ships/ship.js'), import('./ships/presets.js'), import('./ships/hullText.js'),
    ]).then(([THREE, ship, presets, text]) => {
      lib = { THREE, buildShip: ship.buildShip, DEFAULT_LIVERY: presets.DEFAULT_LIVERY, HULL_FONTS: text.HULL_FONTS };
    });
    return loading;
  }

  const layer = {
    id: LAYER_ID,
    type: 'custom',
    renderingMode: '3d',
    onAdd(m, gl) {
      const { THREE } = lib;
      scene = new THREE.Scene();
      camera = new THREE.Camera();
      scene.add(new THREE.HemisphereLight(0xffffff, 0x5a7080, 2.2));
      const sun = new THREE.DirectionalLight(0xffffff, 2.4);
      sun.position.set(-0.4, 1, 0.6); // from the south-west and high, as on a chart's hillshade
      scene.add(sun);
      renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
      // Keep only what is above the waterline (y >= 0): below it is the sea, which is the chart.
      renderer.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)];
    },
    render(gl, arg) {
      if (!renderer || !models.size) return;
      const { THREE } = lib;
      // MapLibre 4 passes the matrix itself; 5 passes { defaultProjectionData: { mainMatrix } }.
      const matrix = arg?.defaultProjectionData?.mainMatrix ?? arg;
      // The layer's frame: metres east (x), up (y) and south (z) from the middle of the view, so the
      // numbers stay small and precise; the origin is folded into the camera in double precision.
      const c = map.getCenter();
      const o = maplibregl.MercatorCoordinate.fromLngLat(c, 0);
      const s = o.meterInMercatorCoordinateUnits();
      // Where each ship is now, moved on from its last report.
      const now = Date.now();
      let moving = false;
      for (const m of models.values()) {
        const at = motion.show(m.v, now);
        m.shown = at;
        moving ||= at.moving;
        const merc = maplibregl.MercatorCoordinate.fromLngLat([at.lon, at.lat], 0);
        m.root.position.set((merc.x - o.x) / s, 0, (merc.y - o.y) / s);
        const heading = at.heading ?? m.place.heading;
        m.root.rotation.y = Math.PI / 2 - (heading * Math.PI) / 180;
      }
      const frame = new THREE.Matrix4().makeTranslation(o.x, o.y, o.z)
        .scale(new THREE.Vector3(s, -s, s))
        .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
      camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix).multiply(frame);
      renderer.resetState();
      renderer.render(scene, camera);
      // Keep the ships moving: ask for the next frame (MapLibre draws only when asked).
      if (moving && !frameTimer) frameTimer = setTimeout(() => { frameTimer = 0; map.triggerRepaint(); }, FRAME_MS);
    },
    onRemove() {
      for (const mmsi of [...models.keys()]) drop(mmsi);
      renderer?.dispose();
      renderer = null;
    },
  };

  function drop(mmsi) {
    const m = models.get(mmsi);
    if (!m) return;
    scene?.remove(m.root);
    m.model.dispose();
    models.delete(mmsi);
    motion.forget(mmsi);
  }

  /** Build (when new or changed) or move one ship's model. */
  function place(v) {
    const { THREE, buildShip, DEFAULT_LIVERY, HULL_FONTS } = lib;
    const p = modelPlacement(v);
    if (!p) { drop(v.mmsi); return false; }
    const key = modelKey(v);
    let m = models.get(v.mmsi);
    if (!m || m.key !== key) {
      drop(v.mmsi);
      const { params } = hullFromAis(v);
      const text = {
        name: ((v.name || '').trim() || '').toUpperCase(), port: '', banner: '', imo: v.imoNumber ? String(v.imoNumber) : '',
        font: HULL_FONTS[0], showDraftMarks: false, showPlimsoll: false, showStripe: true, nameScale: 1, bannerScale: 1,
      };
      const model = buildShip(params, { ...DEFAULT_LIVERY[params.kind] }, text);
      shrinkTexture(THREE, model.materials.hull);
      shrinkTexture(THREE, model.materials.transom);
      const root = new THREE.Group();
      root.add(model.group);
      scene.add(root);
      m = { key, root, model };
      models.set(v.mmsi, m);
    }
    // The newest report; the position and heading are worked out each frame from it (render).
    m.v = v;
    m.place = p;
    m.model.group.position.set(-p.antenna.x, 0, -p.antenna.z); // the antenna on the ship's position
  }

  /** Bring the models in line with `wanted`, building a few new models per frame. */
  function sync() {
    if (!lib || !scene) return;
    if (building) { dirty = true; return; } // run again when the current round is done
    dirty = false;
    const keep = new Set(wanted.map((v) => v.mmsi));
    for (const mmsi of [...models.keys()]) if (!keep.has(mmsi)) drop(mmsi);
    const queue = [...wanted];
    building = true;
    const step = () => {
      // Moving a model is cheap; building one takes 5-15 ms, so build until ~20 ms of this frame are used.
      const t0 = performance.now();
      while (queue.length && performance.now() - t0 < 20) {
        const v = queue.shift();
        try { place(v); } catch (e) { console.warn('ship model', v.mmsi, e); }
      }
      map.triggerRepaint();
      if (queue.length) return requestAnimationFrame(step);
      building = false;
      if (dirty) sync();
    };
    step();
  }

  return {
    /** Show models for these vessels (already picked: in view, placeable, nearest first). */
    async setShips(list) {
      wanted = list;
      if (!list.length) {
        for (const mmsi of [...models.keys()]) drop(mmsi);
        map.triggerRepaint();
        return;
      }
      await load();
      if (!map.getLayer(LAYER_ID)) {
        try {
          map.addLayer(layer);
        } catch {
          // The style is still loading: try again when the map has settled.
          map.once('idle', () => { if (wanted === list) this.setShips(list); });
          return;
        }
      }
      sync();
    },
    get count() { return models.size; },
    /** The modelled ship drawn under a screen point (where it is shown now, not where it last reported), or null. */
    vesselAt(point) {
      const now = Date.now();
      for (const m of models.values()) {
        const at = m.shown ?? motion.show(m.v, now);
        const { length, beam, toBow } = vesselSize(m.v);
        const { bow, stern } = bowAndStern(at.lat, at.lon, at.heading ?? m.place.heading, toBow, length);
        const b = map.project([bow[1], bow[0]]), st = map.project([stern[1], stern[0]]);
        const pxPerM = Math.hypot(b.x - st.x, b.y - st.y) / length;
        if (hitsShip(point, b, st, (beam / 2) * pxPerM)) return m.v;
      }
      return null;
    },
  };
}
