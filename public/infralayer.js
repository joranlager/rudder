// Roads, bridges and buildings on the map (infra.js), switched in the layers panel and remembered.
// The vector tiles come from OpenFreeMap; the 3D bridges are built from the bridge roads in the tiles
// loaded, again whenever the map stops moving or new tiles arrive.

import { styleReady, whenStyleReady } from './mapready.js';
import { TILEJSON, ATTRIBUTION, SOURCE, BRIDGE_SOURCE, BRIDGE_MIN_ZOOM, PREFIX, infraLayers, buildBridges } from './infra.js';
import { bridgesUrl, roadsUrl, bridgeFromNvdb, roadsFromNvdb, buildNvdbBridge, onBridge, groundPoints, parseGround, deckProfile, deckHeight, groundAt, CLIENT, ATTRIBUTION as NVDB_ATTRIBUTION } from './nvdbbridges.js';
import { seabedUrl } from './contact.js';
import { createBridgeCables } from './bridgecables.js';

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

/**
 * NVDB's bridges around the view, each ready to raise the road layer's road over it: { br, pf (its
 * deck's line and heights), top(lonlat) (the deck's top there, as MapLibre should extrude it), parts
 * (its towers, cables, arch or piers, and a deck of its own for when the road layer has no road on it) }.
 * `terrain` { exaggeration, elevation(lngLat) } while land heights are on: heights are then raised as
 * the land is (true heights times the exaggeration) and stand on the terrain MapLibre draws, so the
 * ends meet the land as drawn; without, on Kartverket's ground under them (the map is flat).
 */
async function nvdbBridges(map, { terrain = null } = {}) {
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
  const lift = (p, T) => {
    // a cable (a 3D line, drawn above the sea level of the map): its heights exaggerated like the land
    if (p.geometry.type === 'LineString') return { ...p, geometry: { ...p.geometry, coordinates: p.geometry.coordinates.map(([x, y, h]) => [x, y, h * terrain.exaggeration]) } };
    // a part above the sea, as MapLibre should draw it: exaggerated like the land, less the land drawn under it
    const base = Math.max(0, p.properties.base * terrain.exaggeration - T);
    return { ...p, properties: { ...p.properties, base, top: Math.max(base + 0.2, p.properties.top * terrain.exaggeration - T) } };
  };
  const centre = (p) => { const r = p.geometry.coordinates[0]; return [r.reduce((a, q) => a + q[0], 0) / r.length, r.reduce((a, q) => a + q[1], 0) / r.length]; };
  const out = [];
  await Promise.all([...byId.values()].map(async (br) => {
    const pts = groundPoints(br, roads);
    if (!pts) return;
    const ground = await groundOf(br.id, pts);
    if (!ground) return; // OpenStreetMap's estimate stands in for it
    const g = ground.map((x) => x ?? 0);
    const pf = deckProfile(br, roads);
    const build = (deck) => (terrain
      ? buildNvdbBridge(br, roads, null, { deck }).map((p) => lift(p, p.geometry.type === 'LineString' ? 0 : terrain.elevation(centre(p)) ?? 0))
      : buildNvdbBridge(br, roads, g, { deck }));
    const top = (ll) => {
      const { t, z } = deckHeight(pf, ll);
      return terrain ? z * terrain.exaggeration - (terrain.elevation(ll) ?? 0) : z - groundAt(g, t);
    };
    out.push({ br, pf, top, parts: build(false), deckParts: () => build(true).filter((p) => p.properties.part === 'deck') });
  }));
  return out;
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
  const cables = createBridgeCables(map);

  function rebuild() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const src = map.getSource(BRIDGE_SOURCE);
      if (!on || !src) return;
      if (map.getZoom() < BRIDGE_MIN_ZOOM - 0.5) { src.setData(EMPTY); cables.setCables([]); return; }
      const feats = map.querySourceFeatures(SOURCE, { sourceLayer: 'transportation', filter: ['==', ['get', 'brunnel'], 'bridge'] });
      const mine = ++seq;
      const draw = (list) => {
        // The road layer's bridge roads, raised: where NVDB knows the bridge, at the road's real heights,
        // with its towers, cables or piers; NVDB's own deck only where the road layer has no road on it.
        const ctxOf = (lines) => {
          const l = lines[0];
          const mid = l[Math.floor(l.length / 2)];
          // (twin carriageways can lie well apart, either side of NVDB's narrow outline)
          return list?.find((x) => onBridge(mid, [x.br], 16)) ?? null;
        };
        const used = new Set();
        const heightFor = (lines) => {
          const ctx = ctxOf(lines);
          if (!ctx) return null;
          used.add(ctx);
          return ctx.top;
        };
        const roadsOnly = buildBridges(feats, [], { heightFor });
        const extra = [];
        for (const x of list ?? []) extra.push(...x.parts, ...(used.has(x) ? [] : x.deckParts()));
        // cables and stays as smooth tubes (bridgecables.js); the rest as MapLibre's 3D shapes
        cables.setCables(extra.filter((f) => f.geometry.type === 'LineString')
          .map((f) => ({ coordinates: f.geometry.coordinates, r: f.properties.r, color: f.properties.color })));
        return { type: 'FeatureCollection', features: [...extra.filter((f) => f.geometry.type !== 'LineString'), ...roadsOnly.features] };
      };
      src.setData(draw(nvdb));
      const t = map.getTerrain?.();
      const terrain = t ? {
        exaggeration: t.exaggeration ?? 1,
        // the land's height as drawn there (exaggerated): MapLibre's own, from the middle of the view
        elevation: (ll) => { const e = map.queryTerrainElevation?.(ll); return e == null ? null : e + (map.transform.elevation ?? 0); },
      } : null;
      nvdbBridges(map, { terrain }).then((list) => {
        if (mine !== seq || !on) return;
        nvdb = list;
        map.getSource(BRIDGE_SOURCE)?.setData(draw(list));
      });
    }, 150);
  }
  // New vector tiles, new terrain tiles (land heights: the bridges stand on them), land heights on or off.
  const onData = (e) => { if ((e.sourceId === SOURCE || e.sourceId === 'terrain-dem') && e.isSourceLoaded) rebuild(); };
  map.on('terrain', () => { if (on) rebuild(); });

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
      cables.remove();
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
