// The far view from a ship's bridge: land and sea beyond what MapLibre draws.
//
// MapLibre 4 stops drawing the ground a little below the horizon (Transform.getHorizon and the far
// plane in _calcMatrices). From a bridge some 15 m above the water that is only a kilometre or so,
// so a fjord's far shore and the mountains up ahead were missing. This layer draws them with three.js,
// first, under everything else: the land as a mesh of Kartverket's terrain model for 20 km around
// the ship (one height grid from the same elevation service as the 3D land heights, terrain.js), and
// the sea as a plane out to 40 km. Its camera is MapLibre's with the far plane moved out to 60 km.
// MapLibre then draws the near chart, terrain and ships over it as usual.
//
// Only used from the bridge (pov.js). The land is drawn only while the land heights are switched on;
// the sea always, so the chart no longer ends in sky a kilometre away.

import { demUrl, parseGeoTiff, cleanHeights } from './terrain.js';

export const RADIUS_M = 20_000; // land around the ship
export const SEA_RADIUS_M = 40_000;
export const FAR_M = 60_000; // how far the camera sees
export const GRID = 384; // height samples per side: about 105 m apart
export const REFETCH_M = 6_000; // a new grid when the ship has gone this far from the last one's middle
export const LAND_M = 0.3; // heights below this are sea
const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** The [west, south, east, north] box `radius` metres around a point. */
export function boxAround(lat, lon, radius = RADIUS_M) {
  const dLat = deg(radius / R), dLon = deg(radius / (R * Math.cos(rad(lat))));
  return { west: lon - dLon, south: lat - dLat, east: lon + dLon, north: lat + dLat };
}

/**
 * A copy of MapLibre's camera matrix (column-major, perspective P from near..far times the rest of
 * the camera X) seeing out to `far2` instead: only P's depth row changes, so it is rebuilt from the
 * matrix's own rows. Same units as near and far (MapLibre's "Z units").
 */
export function extendFar(m, near, far, far2) {
  const A = (far + near) / (near - far), B = (2 * far * near) / (near - far);
  const A2 = (far2 + near) / (near - far2), B2 = (2 * far2 * near) / (near - far2);
  const out = Array.from(m);
  for (let c = 0; c < 4; c++) {
    const r2 = m[c * 4 + 2], r3 = m[c * 4 + 3];
    // X's depth row is -row3; X's last row is (row2 - A * X_row2) / B.
    const x2 = -r3, x3 = (r2 - A * x2) / B;
    out[c * 4 + 2] = A2 * x2 + B2 * x3;
  }
  return out;
}

/** Colour of land at a height: green slopes, grey rock, snow on the tops. */
export function landColor(h) {
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * Math.min(1, Math.max(0, t)));
  if (h < 250) return mix([0.42, 0.5, 0.33], [0.46, 0.49, 0.38], h / 250);
  if (h < 800) return mix([0.46, 0.49, 0.38], [0.55, 0.53, 0.5], (h - 250) / 550);
  return mix([0.55, 0.53, 0.5], [0.93, 0.94, 0.95], (h - 800) / 400);
}

/**
 * The land as triangles, in metres east (x), up (y) and south (z) of the grid's middle. Heights come
 * north row first (as the elevation service sends them). Only cells with land in them are kept.
 */
export function landMesh(heights, w, h, box) {
  const midLat = (box.north + box.south) / 2;
  const mPerLon = rad(1) * R * Math.cos(rad(midLat)), mPerLat = rad(1) * R;
  const positions = new Float32Array(w * h * 3), colors = new Float32Array(w * h * 3);
  for (let j = 0; j < h; j++) {
    const lat = box.north - ((j + 0.5) / h) * (box.north - box.south);
    for (let i = 0; i < w; i++) {
      const lon = box.west + ((i + 0.5) / w) * (box.east - box.west);
      const k = j * w + i, v = heights[k];
      positions[3 * k] = (lon - (box.west + box.east) / 2) * mPerLon;
      positions[3 * k + 1] = Math.max(0, v);
      positions[3 * k + 2] = -(lat - midLat) * mPerLat;
      const c = landColor(v);
      colors.set(c, 3 * k);
    }
  }
  const index = [];
  for (let j = 0; j < h - 1; j++) {
    for (let i = 0; i < w - 1; i++) {
      const a = j * w + i, b = a + 1, c = a + w, d = c + 1;
      if (Math.max(heights[a], heights[b], heights[c], heights[d]) < LAND_M) continue;
      index.push(a, c, b, b, c, d);
    }
  }
  return { positions, colors, index: index.length > 65535 ? new Uint32Array(index) : new Uint16Array(index) };
}

/**
 * The far view layer for `map`. `start()` adds it (under every other layer), `update(lat, lon)` moves
 * it with the ship and fetches new land when needed, `setLand(on)` shows or hides the land, `stop()`
 * removes it.
 */
export function createFarView(map) {
  const ID = 'far-view';
  let THREE = null, scene = null, camera = null, renderer = null;
  let land = null, sea = null;
  let anchor = null; // { lat, lon } of the land grid's middle
  let fetching = null;
  let showLand = false;
  let patched = false;
  let ship = null; // { lat, lng } where the ship is now

  const layer = {
    id: ID, type: 'custom', renderingMode: '3d',
    onAdd(m, gl) {
      scene = new THREE.Scene();
      camera = new THREE.Camera();
      scene.add(new THREE.HemisphereLight(0xe8f2ff, 0x4a5a3a, 1.6));
      const sun = new THREE.DirectionalLight(0xffffff, 1.6);
      sun.position.set(-0.5, 0.8, 0.4);
      scene.add(sun);
      sea = new THREE.Mesh(new THREE.CircleGeometry(SEA_RADIUS_M, 96), new THREE.MeshBasicMaterial({ color: 0x9ec3dc }));
      sea.rotation.x = -Math.PI / 2; // lying on the water, facing up
      sea.position.y = -0.5; // just under the chart and the land's shore
      scene.add(sea);
      renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
    },
    render(gl, matrix, opts) {
      if (!renderer) return;
      const near = opts?.nearZ ?? map.transform.nearZ, far = opts?.farZ ?? map.transform.farZ;
      const c = map.getCenter();
      const o = maplibregl.MercatorCoordinate.fromLngLat(c, 0);
      const s = o.meterInMercatorCoordinateUnits();
      const ppm = map.transform._pixelPerMeter ?? 1;
      const m = extendFar(matrix, near, far, Math.max(far, FAR_M * ppm));
      const elevation = map.transform.elevation ?? 0;
      const frame = new THREE.Matrix4().makeTranslation(o.x, o.y, -elevation * s)
        .scale(new THREE.Vector3(s, -s, s)).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
      camera.projectionMatrix = new THREE.Matrix4().fromArray(m).multiply(frame);
      // The sea around the ship, the land where it was fetched; both relative to the middle of the view.
      const at = ship ?? { lat: c.lat, lng: c.lng };
      sea.position.x = (at.lng - c.lng) * rad(1) * R * Math.cos(rad(c.lat));
      sea.position.z = -(at.lat - c.lat) * rad(1) * R;
      if (land && anchor) {
        land.visible = showLand;
        land.position.x = (anchor.lon - c.lng) * rad(1) * R * Math.cos(rad(c.lat));
        land.position.z = -(anchor.lat - c.lat) * rad(1) * R;
      }
      renderer.resetState();
      renderer.clear(false, true, false);
      renderer.render(scene, camera);
      // MapLibre's own layers have their own depth: they draw over this layer wherever they reach.
      gl.clear(gl.DEPTH_BUFFER_BIT);
    },
    onRemove() { renderer?.dispose(); renderer = null; },
  };

  async function fetchLand(lat, lon) {
    const box = boxAround(lat, lon);
    const res = await fetch(demUrl(box, GRID));
    if (!res.ok) throw new Error(`the elevation service answered ${res.status}`);
    const tiff = parseGeoTiff(await res.arrayBuffer());
    const heights = cleanHeights(tiff.data);
    const mesh = landMesh(heights, tiff.width, tiff.height, box);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    g.setAttribute('color', new THREE.BufferAttribute(mesh.colors, 3));
    g.setIndex(new THREE.BufferAttribute(mesh.index, 1));
    g.computeVertexNormals();
    const next = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
    if (land) { scene.remove(land); land.geometry.dispose(); land.material.dispose(); }
    land = next;
    scene.add(land);
    anchor = { lat: (box.north + box.south) / 2, lon: (box.west + box.east) / 2 };
    map.triggerRepaint();
  }

  return {
    async start() {
      THREE ??= await import('./vendor/three.js');
      if (!map.getLayer(ID)) map.addLayer(layer, map.getStyle().layers[0]?.id);
      // Draw MapLibre's own ground nearer to the true horizon (it stops at 85% of the way).
      patched = true;
      map.transform.getHorizon = function getHorizon() { return Math.tan(Math.PI / 2 - this._pitch) * this.cameraToCenterDistance * 0.995; };
    },
    /** The ship is here: move the sea with it, and fetch land around it when needed. */
    update(lat, lon) {
      ship = { lat, lng: lon };
      if (!showLand || !scene || fetching) return;
      const far = anchor ? Math.hypot(rad(lat - anchor.lat) * R, rad(lon - anchor.lon) * R * Math.cos(rad(lat))) : Infinity;
      if (far < REFETCH_M) return;
      fetching = fetchLand(lat, lon).catch((e) => console.warn('far land:', e.message)).finally(() => { fetching = null; });
    },
    setLand(on) { showLand = on; map.triggerRepaint(); },
    stop() {
      if (map.getLayer(ID)) map.removeLayer(ID);
      if (patched) { delete map.transform.getHorizon; patched = false; } // back to MapLibre's own (on its prototype)
      if (land) { land.geometry.dispose(); land.material.dispose(); land = null; }
      anchor = null;
      scene = null;
      ship = null;
    },
  };
}
