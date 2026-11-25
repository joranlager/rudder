// Roads, bridges, buildings and other works on land, from OpenStreetMap (OpenFreeMap's vector tiles,
// OpenMapTiles schema), drawn over the chart or the satellite picture: roads and railways by class,
// buildings raised to their height, and bridges built in 3D: a deck standing over the water on piers,
// rising from its ends, with towers on long spans.
//
// OpenStreetMap does not say how high a bridge is, so the deck's height is estimated from its length
// (bridgeClearance). Pure (no MapLibre), so the styling and the bridge building are unit tested;
// infralayer.js puts them on the map. Checked against tiles.openfreemap.org on 2026-11-25.

export const TILEJSON = 'https://tiles.openfreemap.org/planet';
export const ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> Data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
export const SOURCE = 'infra';
export const BRIDGE_SOURCE = 'infra-bridges';
export const BRIDGE_MIN_ZOOM = 13; // decks are built from here; below, bridges are drawn as roads
export const PREFIX = 'infra-';

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;

/** Width of the carriageway in metres, by OpenMapTiles transportation class. */
export const ROAD_WIDTH = {
  motorway: 14, trunk: 11, primary: 9, secondary: 8, tertiary: 7, minor: 6, service: 4, track: 3,
  path: 2.5, rail: 5, transit: 5, busway: 6, raceway: 8, pier: 4,
};
const ROAD_COLOR = {
  motorway: '#e892a2', trunk: '#f9b29c', primary: '#fcd6a4', secondary: '#f7fabf', tertiary: '#ffffff', minor: '#ffffff',
  service: '#ffffff', track: '#c9a76a', path: '#f2efe9', busway: '#ffffff', raceway: '#ffc0cb',
};
const MAJOR = ['motorway', 'trunk', 'primary', 'secondary'];

// Width in pixels for a road `m` metres wide: true to scale from zoom 15, never thinner than a hairline.
const widthExpr = (m, minPx = 0.6) => [
  'interpolate', ['exponential', 2], ['zoom'],
  8, minPx, 12, Math.max(minPx, m * 0.12), 15, Math.max(1.5, m * 0.42), 19, m * 6.7,
];
/**
 * A road being built is drawn as the road it becomes: OpenMapTiles marks it `motorway_construction`
 * and so on (the E18 over Grenlandsbrua is, while NVDB has it as a bridge in use).
 */
export const baseClass = (cls) => String(cls ?? '').replace(/_construction$/, '');
const withBuilding = (table) => Object.fromEntries(Object.entries(table).flatMap(([k, v]) => [[k, v], [`${k}_construction`, v]]));
const MAJOR_ALL = [...MAJOR, ...MAJOR.map((m) => `${m}_construction`)];
const byClass = (table, fallback) => ['match', ['get', 'class'], ...Object.entries(withBuilding(table)).flat(), fallback];

/**
 * The map layers over the background, in drawing order, each id starting with PREFIX. Bridges are
 * drawn as roads below BRIDGE_MIN_ZOOM and as built decks (BRIDGE_SOURCE) from it.
 */
export function infraLayers() {
  const roads = ['all', ['==', ['geometry-type'], 'LineString'], ['match', ['get', 'class'], Object.keys(withBuilding(ROAD_COLOR)), true, false]];
  const notTunnel = ['!=', ['get', 'brunnel'], 'tunnel'];
  const flatBridge = ['any', ['!=', ['get', 'brunnel'], 'bridge'], ['<', ['zoom'], BRIDGE_MIN_ZOOM]];
  const width = (k = 1) => ['*', k, byClass(Object.fromEntries(Object.entries(ROAD_WIDTH)), 5)];
  const w = (k) => [
    'interpolate', ['exponential', 2], ['zoom'],
    8, ['*', k, ['case', ['in', ['get', 'class'], ['literal', MAJOR_ALL]], 1, 0.4]],
    12, ['*', k, ['max', 0.8, ['*', 0.15, width()]]],
    15, ['*', k, ['max', 1.5, ['*', 0.42, width()]]],
    19, ['*', k, ['*', 6.7, width()]],
  ];
  return [
    { id: `${PREFIX}runway`, type: 'fill', source: SOURCE, 'source-layer': 'aeroway', minzoom: 10,
      filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['match', ['get', 'class'], ['runway', 'taxiway', 'apron'], true, false]],
      paint: { 'fill-color': '#9aa0a6', 'fill-opacity': 0.85 } },
    { id: `${PREFIX}runway-line`, type: 'line', source: SOURCE, 'source-layer': 'aeroway', minzoom: 10,
      filter: ['all', ['==', ['geometry-type'], 'LineString'], ['match', ['get', 'class'], ['runway', 'taxiway'], true, false]],
      paint: { 'line-color': '#9aa0a6', 'line-width': ['interpolate', ['exponential', 2], ['zoom'], 10, 1, 15, 12, 19, 180] } },
    { id: `${PREFIX}pier`, type: 'fill', source: SOURCE, 'source-layer': 'transportation', minzoom: 12,
      filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['==', ['get', 'class'], 'pier']],
      paint: { 'fill-color': '#d8cfc0', 'fill-outline-color': '#8a8170' } },
    { id: `${PREFIX}pier-line`, type: 'line', source: SOURCE, 'source-layer': 'transportation', minzoom: 13,
      filter: ['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'class'], 'pier']],
      paint: { 'line-color': '#d8cfc0', 'line-width': widthExpr(ROAD_WIDTH.pier) } },
    { id: `${PREFIX}ferry`, type: 'line', source: SOURCE, 'source-layer': 'transportation', minzoom: 7,
      filter: ['==', ['get', 'class'], 'ferry'],
      paint: { 'line-color': '#3c6fb4', 'line-width': 1.2, 'line-dasharray': [3, 2], 'line-opacity': 0.8 } },
    { id: `${PREFIX}tunnel`, type: 'line', source: SOURCE, 'source-layer': 'transportation', minzoom: 11,
      filter: ['all', roads, ['==', ['get', 'brunnel'], 'tunnel']],
      layout: { 'line-cap': 'butt' },
      paint: { 'line-color': '#6b6b6b', 'line-width': w(1), 'line-dasharray': [1, 1.2], 'line-opacity': 0.55 } },
    { id: `${PREFIX}road-casing`, type: 'line', source: SOURCE, 'source-layer': 'transportation', minzoom: 8,
      filter: ['all', roads, notTunnel, flatBridge, ['any', ['>=', ['zoom'], 12], ['in', ['get', 'class'], ['literal', MAJOR_ALL]]]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#5b5146', 'line-width': w(1.35), 'line-opacity': 0.85 } },
    { id: `${PREFIX}road`, type: 'line', source: SOURCE, 'source-layer': 'transportation', minzoom: 8,
      filter: ['all', roads, notTunnel, flatBridge, ['any', ['>=', ['zoom'], 12], ['in', ['get', 'class'], ['literal', MAJOR_ALL]]]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': byClass(ROAD_COLOR, '#ffffff'), 'line-width': w(1) } },
    { id: `${PREFIX}rail`, type: 'line', source: SOURCE, 'source-layer': 'transportation', minzoom: 9,
      filter: ['all', ['match', ['get', 'class'], ['rail', 'transit'], true, false], notTunnel, flatBridge],
      paint: { 'line-color': '#4a4a4a', 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1, 15, 3, 19, 8] } },
    { id: `${PREFIX}rail-ties`, type: 'line', source: SOURCE, 'source-layer': 'transportation', minzoom: 13,
      filter: ['all', ['match', ['get', 'class'], ['rail', 'transit'], true, false], notTunnel, flatBridge],
      paint: { 'line-color': '#f2f2f2', 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.8, 19, 4], 'line-dasharray': [2, 3] } },
    { id: `${PREFIX}building`, type: 'fill-extrusion', source: SOURCE, 'source-layer': 'building', minzoom: 13,
      paint: {
        'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 6], 0, '#d9d0c3', 20, '#c9bfb2', 60, '#aeb6c0'],
        'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 13, 0, 14, ['coalesce', ['get', 'render_height'], 6]],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
        'fill-extrusion-opacity': 0.9,
      } },
    // Bridges built in 3D (buildBridges): decks, piers and towers, each with its own base and top.
    { id: `${PREFIX}bridge-3d`, type: 'fill-extrusion', source: BRIDGE_SOURCE, minzoom: BRIDGE_MIN_ZOOM,
      paint: {
        'fill-extrusion-color': ['get', 'color'],
        'fill-extrusion-base': ['get', 'base'],
        'fill-extrusion-height': ['get', 'top'],
        'fill-extrusion-opacity': 1,
        'fill-extrusion-vertical-gradient': true,
      } },
  ];
}

// ---------- building bridges ----------

/**
 * A way's pieces that touch (ends within 30 m) make one bridge; pieces apart are separate bridges.
 * (A tile can hold one feature with two bridges far apart, and a bridge cut by tiles comes in pieces.)
 */
export function splitWays(ways) {
  const out = [];
  for (const w of ways) {
    const groups = [];
    for (const line of w.lines) {
      const near = (g) => g.some((l) => [l[0], l[l.length - 1]].some((e) => [line[0], line[line.length - 1]].some((p) => Math.hypot(...toLocal(e, p)) < 30)));
      const hits = groups.filter(near);
      const merged = [line, ...hits.flat()];
      for (const h of hits) groups.splice(groups.indexOf(h), 1);
      groups.push(merged);
    }
    for (const g of groups) out.push({ ...w, lines: g });
  }
  return out;
}

/** Metres east and north of (lon0, lat0), and back: flat enough for a bridge. */
export function toLocal([lon, lat], [lon0, lat0]) {
  return [rad(lon - lon0) * R * Math.cos(rad(lat0)), rad(lat - lat0) * R];
}
export function toLonLat([x, y], [lon0, lat0]) {
  return [lon0 + (x / (R * Math.cos(rad(lat0)))) * (180 / Math.PI), lat0 + (y / R) * (180 / Math.PI)];
}

/**
 * How high a bridge's deck stands at its highest, in metres, from its length: footbridges and short
 * road bridges a few metres, long fjord crossings tens of metres (Stavanger city bridge, 1 km: 26 m
 * clearance; Hålogaland bridge, 1.5 km: 40 m). Lower bridges over land look the same from above.
 */
export function bridgeClearance(length, cls = 'minor') {
  const small = cls === 'path' || cls === 'track' || cls === 'service';
  const h = 3 + length * 0.026;
  return Math.min(small ? 12 : 70, Math.max(small ? 2.5 : 4, h));
}

/** The deck's height at `t` (0 at one end, 1 at the other): rising quickly off the ends, then flat-ish. */
export function deckProfile(t) {
  const u = Math.min(1, Math.max(0, t));
  return Math.pow(Math.max(0, 1 - (2 * u - 1) ** 2), 0.35);
}

const ring = (pts, o) => [[...pts, pts[0]].map((p) => toLonLat(p, o))];
const square = ([x, y], half, o) => ring([[x - half, y - half], [x + half, y - half], [x + half, y + half], [x - half, y + half]], o);

/**
 * Bridges as 3D parts, from bridge features (GeoJSON, lon/lat) as the map gives them: one feature
 * per way per tile, so a long bridge comes in several pieces with the same id. The pieces of a way
 * are put together; its length is the distance between its two ends furthest apart, and each piece
 * of deck stands at that bridge's profile there. Returns a FeatureCollection of polygons with
 * { part: 'deck' | 'pier' | 'tower', base, top, color }.
 */
export function buildBridges(features, extra = [], { maxParts = 20000, heightFor = () => null } = {}) {
  const ways = new Map();
  for (const f of features) {
    const g = f.geometry;
    if (!g || (g.type !== 'LineString' && g.type !== 'MultiLineString')) continue;
    const cls = baseClass(f.properties?.class);
    if (!(cls in ROAD_WIDTH) || cls === 'pier') continue;
    const key = f.id ?? JSON.stringify(f.properties) + JSON.stringify(g.coordinates[0]);
    const w = ways.get(key) ?? { cls, layer: Number(f.properties?.layer) || 1, lines: [] };
    for (const line of g.type === 'LineString' ? [g.coordinates] : g.coordinates) if (line.length > 1) w.lines.push(line);
    ways.set(key, w);
  }
  const out = [];
  const towers = []; // [lon, lat] of towers built: carriageways side by side share one bridge's towers
  for (const w of splitWays(ways.values())) {
    if (out.length >= maxParts) break;
    const o = w.lines[0][0];
    const lines = w.lines.map((l) => l.map((p) => toLocal(p, o)));
    // The ends: the two points furthest apart (a bridge is nearly straight)
    const ends = lines.flatMap((l) => [l[0], l[l.length - 1]]);
    let a = ends[0], b = ends[0], best = -1;
    for (let i = 0; i < ends.length; i++) for (let j = i + 1; j < ends.length; j++) {
      const d = Math.hypot(ends[i][0] - ends[j][0], ends[i][1] - ends[j][1]);
      if (d > best) { best = d; a = ends[i]; b = ends[j]; }
    }
    const length = Math.max(best, 1);
    const ax = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
    const tOf = (p) => ((p[0] - a[0]) * ax[0] + (p[1] - a[1]) * ax[1]) / length;
    // A bridge over another (layer 2 over layer 1) stands higher.
    const H = bridgeClearance(length, w.cls) + (w.layer - 1) * 6;
    const half = (ROAD_WIDTH[w.cls] ?? 6) / 2 + (w.cls === 'path' ? 0.3 : 1); // carriageway and railings
    const thick = Math.min(3, 0.6 + length * 0.002);
    const rail = w.cls === 'rail' || w.cls === 'transit';
    // The deck is the road itself, raised: in the road's colour, as wide as the road is drawn.
    const deckColor = rail ? '#7b7f86' : ROAD_COLOR[w.cls] ?? '#ffffff';
    // Where NVDB knows the bridge (nvdbbridges.js), the road's real heights there, and its towers,
    // cables or piers come from NVDB too; else heights estimated from the length.
    const known = heightFor(w.lines);
    const heightAt = (t) => Math.max(0.8, H * deckProfile(t));
    const topOf = (local) => (known ? known(toLonLat(local, o)) : null) ?? heightAt(tOf(local));
    for (const l of lines) {
      // Pieces of deck 2 m long: each is a flat-topped box (MapLibre's extrusions), so a sloping road is
      // a staircase of steps a few centimetres high, too small to see.
      for (let i = 0; i + 1 < l.length; i++) {
        const p = l[i], q = l[i + 1];
        const segLen = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (segLen < 0.05) continue;
        const n = Math.max(1, Math.ceil(segLen / 2));
        const d = [(q[0] - p[0]) / segLen, (q[1] - p[1]) / segLen];
        const nx = -d[1] * half, ny = d[0] * half;
        for (let k = 0; k < n; k++) {
          const s0 = [p[0] + (q[0] - p[0]) * (k / n), p[1] + (q[1] - p[1]) * (k / n)];
          const s1 = [p[0] + (q[0] - p[0]) * ((k + 1) / n), p[1] + (q[1] - p[1]) * ((k + 1) / n)];
          // a little overlap, so the pieces join without slits
          const e0 = [s0[0] - d[0] * 0.3, s0[1] - d[1] * 0.3], e1 = [s1[0] + d[0] * 0.3, s1[1] + d[1] * 0.3];
          const top = topOf([(s0[0] + s1[0]) / 2, (s0[1] + s1[1]) / 2]);
          out.push({
            type: 'Feature',
            properties: { part: 'deck', base: Math.max(0, top - (known ? 1.5 : thick)), top, color: deckColor, road: w.cls },
            geometry: { type: 'Polygon', coordinates: ring([[e0[0] + nx, e0[1] + ny], [e1[0] + nx, e1[1] + ny], [e1[0] - nx, e1[1] - ny], [e0[0] - nx, e0[1] - ny]], o) },
          });
        }
      }
      // Round joints where the road bends, so a curving deck has no notches at its corners.
      for (let i = 1; i + 1 < l.length; i++) {
        const top = topOf(l[i]);
        const oct = Array.from({ length: 8 }, (_, k) => [l[i][0] + half * Math.cos((k * Math.PI) / 4 + Math.PI / 8), l[i][1] + half * Math.sin((k * Math.PI) / 4 + Math.PI / 8)]);
        out.push({ type: 'Feature', properties: { part: 'deck', base: Math.max(0, top - (known ? 1.5 : thick)), top, color: deckColor, road: w.cls }, geometry: { type: 'Polygon', coordinates: ring(oct, o) } });
      }
    }
    // Piers under the deck along the bridge's line, where the deck stands clear of the ground; on long
    // bridges two towers stand up through the deck (most long Norwegian bridges are suspension or cable-stayed).
    if (length >= 25 && w.cls !== 'path' && !known) {
      const span = Math.min(120, Math.max(20, length / 12));
      const pierHalf = Math.min(4, Math.max(1, half * 0.35));
      for (let s = span; s < length - span / 2; s += span) {
        const t = s / length;
        const top = heightAt(t) - thick;
        if (top < 2.5) continue;
        const c = [a[0] + ax[0] * s, a[1] + ax[1] * s];
        // two legs, one under each edge of the deck
        for (const side of [-1, 1]) {
          const leg = [c[0] - ax[1] * half * 0.7 * side, c[1] + ax[0] * half * 0.7 * side];
          out.push({ type: 'Feature', properties: { part: 'pier', base: 0, top, color: '#8f9399' }, geometry: { type: 'Polygon', coordinates: square(leg, pierHalf, o) } });
        }
      }
      if (length >= 400 && !rail) {
        const towerH = H + Math.min(150, length * 0.09);
        for (const t of [0.22, 0.78]) {
          const c = [a[0] + ax[0] * length * t, a[1] + ax[1] * length * t];
          const at = toLonLat(c, o);
          if (towers.some((x) => Math.hypot(...toLocal(x, at)) < 80)) continue;
          towers.push(at);
          for (const side of [-1, 1]) {
            const leg = [c[0] - ax[1] * (half + 1.5) * side, c[1] + ax[0] * (half + 1.5) * side];
            out.push({ type: 'Feature', properties: { part: 'tower', base: 0, top: towerH, color: '#c9ccd1' }, geometry: { type: 'Polygon', coordinates: square(leg, 2.2, o) } });
          }
        }
      }
    }
  }
  // parts built elsewhere (NVDB's road bridges, nvdbbridges.js) go first, so they are never cut off
  return { type: 'FeatureCollection', features: [...(extra ?? []), ...out].slice(0, maxParts + (extra?.length ?? 0)) };
}
