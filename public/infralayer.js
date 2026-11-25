// Roads, bridges and buildings on the map (infra.js), switched in the layers panel and remembered.
// The vector tiles come from OpenFreeMap; the 3D bridges are built from the bridge roads in the tiles
// loaded, again whenever the map stops moving or new tiles arrive.

import { styleReady, whenStyleReady } from './mapready.js';
import { TILEJSON, ATTRIBUTION, SOURCE, BRIDGE_SOURCE, BRIDGE_MIN_ZOOM, PREFIX, infraLayers, buildBridges } from './infra.js';
import { bridgesUrl, roadsUrl, bridgeFromNvdb, roadsFromNvdb, buildNvdbBridge, onBridge, groundPoints, parseGround, CLIENT, ATTRIBUTION as NVDB_ATTRIBUTION } from './nvdbbridges.js';
import { seabedUrl } from './contact.js';

// The ground under each NVDB bridge (Kartverket's terrain model), asked once per bridge.
const grounds = new Map(); // bridge id -> Promise<number[] | null>
function groundOf(id, points) {
  if (!grounds.has(id)) {
    grounds.set(id, fetch(seabedUrl(points))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`heights ${r.status}`))))
      .then((j) => { const g = parseGround(j); return g.length === points.length ? g : null; })
      .catch((e) => { console.warn('ground under bridge', id, e.message); grounds.delete(id); return null; }));
  }
  return grounds.get(id);
}

// NVDB's bridges and roads are asked for in cells of the map (about 1 x 1 km), each once a visit.
const CELL_LON = 0.02, CELL_LAT = 0.01, MAX_CELLS = 24;
const cells = new Map(); // "i,j" -> Promise<{ bridges, roads }>
function cell(i, j) {
  const key = `${i},${j}`;
  if (!cells.has(key)) {
    const box = [i * CELL_LON, j * CELL_LAT, (i + 1) * CELL_LON, (j + 1) * CELL_LAT];
    const get = (url) => fetch(url, { headers: { 'X-Client': CLIENT, Accept: 'application/json' } }).then((r) => { if (!r.ok) throw new Error(`NVDB ${r.status}`); return r.json(); });
    cells.set(key, Promise.all([get(bridgesUrl(box)), get(roadsUrl(box))])
      .then(([b, r]) => ({ bridges: (b.objekter ?? []).map(bridgeFromNvdb).filter(Boolean), roads: roadsFromNvdb(r) }))
      .catch((e) => { console.warn('NVDB', e.message); cells.delete(key); return { bridges: [], roads: [] }; }));
  }
  return cells.get(key);
}

/** NVDB's bridges built in 3D around the view, and those bridges (to leave out of OpenStreetMap's). */
async function nvdbBridges(map) {
  const b = map.getBounds();
  const c = map.getCenter();
  // the view, but not more than a few kilometres of it (a tilted view reaches far)
  const w = Math.max(b.getWest(), c.lng - 0.06), e = Math.min(b.getEast(), c.lng + 0.06);
  const s = Math.max(b.getSouth(), c.lat - 0.03), n = Math.min(b.getNorth(), c.lat + 0.03);
  const keys = [];
  for (let i = Math.floor(w / CELL_LON); i <= Math.floor(e / CELL_LON); i++) for (let j = Math.floor(s / CELL_LAT); j <= Math.floor(n / CELL_LAT); j++) keys.push([i, j]);
  const got = await Promise.all(keys.slice(0, MAX_CELLS).map(([i, j]) => cell(i, j)));
  const byId = new Map(), roads = [];
  for (const g of got) { for (const br of g.bridges) byId.set(br.id, br); roads.push(...g.roads); }
  const built = [], parts = [];
  await Promise.all([...byId.values()].map(async (br) => {
    const pts = groundPoints(br, roads);
    if (!pts) return;
    // Built on the ground under it: without, a bridge over a street on a hill would stand a hill too high.
    const ground = await groundOf(br.id, pts);
    if (!ground) return; // OpenStreetMap's estimate stands in for it
    const f = buildNvdbBridge(br, roads, ground.map((g) => g ?? 0));
    if (f.length) { built.push(br); parts.push(...f); }
  }));
  return { built, parts };
}

const EMPTY = { type: 'FeatureCollection', features: [] };

/** The first layer drawn above the works: the first that is not a background, overlay, hillshade or ours. */
export function infraBefore(layers, belowIds) {
  return layers.find((l) => l.type !== 'background' && !belowIds.includes(l.id) && l.id !== 'hillshade' && !l.id.startsWith(PREFIX))?.id;
}

export function createInfra(map, { belowIds = [], onError = () => {} } = {}) {
  let on = false;
  let timer = 0;
  let errors = 0;
  let seq = 0, nvdb = null;
  /** An OpenStreetMap bridge piece lying on one of NVDB's bridges (its middle within the outline). */
  const onNvdb = (f, built) => {
    const c = f.geometry?.type === 'LineString' ? f.geometry.coordinates : f.geometry?.coordinates?.[0];
    return Boolean(c?.length) && onBridge(c[Math.floor(c.length / 2)], built);
  };

  function rebuild() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const src = map.getSource(BRIDGE_SOURCE);
      if (!on || !src) return;
      if (map.getZoom() < BRIDGE_MIN_ZOOM - 0.5) { src.setData(EMPTY); return; }
      const feats = map.querySourceFeatures(SOURCE, { sourceLayer: 'transportation', filter: ['==', ['get', 'brunnel'], 'bridge'] });
      const mine = ++seq;
      // OpenStreetMap's at once; NVDB's road bridges (real heights and types) when they come, in their place.
      src.setData(buildBridges(nvdb ? feats.filter((f) => !onNvdb(f, nvdb.built)) : feats, nvdb?.parts));
      nvdbBridges(map).then((r) => {
        if (mine !== seq || !on) return;
        nvdb = r;
        map.getSource(BRIDGE_SOURCE)?.setData(buildBridges(feats.filter((f) => !onNvdb(f, r.built)), r.parts));
      });
    }, 150);
  }
  const onData = (e) => { if (e.sourceId === SOURCE && e.isSourceLoaded) rebuild(); };

  function apply() {
    if (!styleReady(map)) { whenStyleReady(map, apply); return; } // not isStyleLoaded(): mapready.js
    if (on) {
      if (!map.getSource(SOURCE)) map.addSource(SOURCE, { type: 'vector', url: TILEJSON, attribution: ATTRIBUTION });
      if (!map.getSource(BRIDGE_SOURCE)) map.addSource(BRIDGE_SOURCE, { type: 'geojson', data: EMPTY, attribution: NVDB_ATTRIBUTION });
      const before = infraBefore(map.getStyle().layers, belowIds);
      for (const l of infraLayers()) if (!map.getLayer(l.id)) map.addLayer(l, before);
      map.on('sourcedata', onData);
      map.on('moveend', rebuild);
      rebuild();
    } else {
      map.off('sourcedata', onData);
      map.off('moveend', rebuild);
      for (const l of infraLayers()) if (map.getLayer(l.id)) map.removeLayer(l.id);
      for (const s of [BRIDGE_SOURCE, SOURCE]) if (map.getSource(s)) map.removeSource(s);
    }
  }

  map.on('error', (e) => { if (e.sourceId === SOURCE && ++errors === 1) onError('Some roads and buildings could not be loaded.'); });

  return {
    get on() { return on; },
    setOn(value) {
      on = Boolean(value);
      errors = 0;
      apply();
    },
  };
}
