// Bridge cables, stays and hangers drawn as smooth 3D tubes, part of the roads layer's bridges
// (infralayer.js, nvdbbridges.js). MapLibre's own 3D shapes (fill-extrusion) are flat-topped boxes,
// so a sloping cable built of them is a staircase; here each cable is a tube along a smooth curve
// through its points, drawn with three.js in a MapLibre custom layer sharing the map's WebGL context
// (as the 3D ships are, shipmodels.js). three.js is loaded the first time a cable is shown.
//
// Heights are in metres above what the map draws at sea level: with land heights on, the caller has
// already raised them as the land is (times the exaggeration); the world is lowered with the land
// under the middle of the view, as MapLibre does (Transform.elevation).

export const CABLE_LAYER = 'infra-bridge-cables';

/** [lon, lat, h] to metres east, up and south of the origin [lon0, lat0] (fine over a few kilometres). */
export function toWorld([lon, lat, h], [lon0, lat0]) {
  const R = 6371008.8, k = Math.PI / 180;
  return [(lon - lon0) * k * R * Math.cos(lat0 * k), h, -(lat - lat0) * k * R];
}

export function createBridgeCables(map) {
  let lib = null, loading = null;
  let scene = null, camera = null, renderer = null, group = null;
  let origin = null; // [lon, lat] the tubes are built around
  let wanted = [];
  let built = '';

  async function load() {
    loading ??= import('./vendor/three.js').then((THREE) => { lib = THREE; });
    return loading;
  }

  const layer = {
    id: CABLE_LAYER,
    type: 'custom',
    renderingMode: '3d',
    onAdd(m, gl) {
      const THREE = lib;
      scene = new THREE.Scene();
      camera = new THREE.Camera();
      scene.add(new THREE.HemisphereLight(0xffffff, 0x404850, 2.4));
      const sun = new THREE.DirectionalLight(0xffffff, 1.6);
      sun.position.set(-0.4, 1, 0.6);
      scene.add(sun);
      group = new THREE.Group();
      scene.add(group);
      renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
      rebuild();
    },
    render(gl, arg) {
      if (!renderer || !origin || !group.children.length) return;
      const THREE = lib;
      const matrix = arg?.defaultProjectionData?.mainMatrix ?? arg;
      const o = maplibregl.MercatorCoordinate.fromLngLat(origin, 0);
      const s = o.meterInMercatorCoordinateUnits();
      // x east, y up, z south (metres) from the origin; the world lowered with the land under the
      // middle of the view when land heights are on, as MapLibre lowers its own.
      const elevation = map.transform.elevation ?? 0;
      const frame = new THREE.Matrix4().makeTranslation(o.x, o.y, -elevation * s)
        .scale(new THREE.Vector3(s, -s, s))
        .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
      camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix).multiply(frame);
      renderer.resetState();
      renderer.render(scene, camera);
    },
    onRemove() {
      clear();
      renderer?.dispose();
      renderer = null;
    },
  };

  function clear() {
    if (!group) return;
    for (const m of [...group.children]) { m.geometry.dispose(); m.material.dispose(); group.remove(m); }
  }

  /** Build the tubes for `wanted`: each a smooth curve through its points. */
  function rebuild() {
    if (!lib || !group) return;
    const key = JSON.stringify(wanted.map((l) => [l.r, l.coordinates.length, l.coordinates[0], l.coordinates[l.coordinates.length - 1]]));
    if (key === built) return;
    built = key;
    clear();
    if (!wanted.length) { map.triggerRepaint(); return; }
    const THREE = lib;
    origin = wanted[0].coordinates[0].slice(0, 2);
    const mats = new Map();
    for (const l of wanted) {
      const pts = l.coordinates.map((c) => new THREE.Vector3(...toWorld(c, origin)));
      if (pts.length < 2) continue;
      const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
      const len = curve.getLength();
      const geom = new THREE.TubeGeometry(curve, Math.min(600, Math.max(8, Math.ceil(len / 2))), Math.max(0.15, l.r), 6, false);
      if (!mats.has(l.color)) mats.set(l.color, new THREE.MeshStandardMaterial({ color: l.color, roughness: 0.6, metalness: 0.3 }));
      group.add(new THREE.Mesh(geom, mats.get(l.color).clone()));
    }
    map.triggerRepaint();
  }

  return {
    /** Draw these cables: [{ coordinates: [[lon, lat, h], ...], r, color }] (empty to draw none). */
    async setCables(lines) {
      wanted = lines;
      if (!lines.length && !map.getLayer(CABLE_LAYER)) return;
      await load();
      if (!map.getLayer(CABLE_LAYER)) {
        try { map.addLayer(layer); } catch { return; } // the style is busy: next time
      }
      rebuild();
    },
    remove() {
      wanted = [];
      if (map.getLayer(CABLE_LAYER)) map.removeLayer(CABLE_LAYER);
      built = '';
    },
  };
}
