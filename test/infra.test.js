import { test } from 'node:test';
import assert from 'node:assert/strict';
import { infraLayers, buildBridges, bridgeClearance, deckProfile, toLocal, toLonLat, PREFIX, SOURCE, BRIDGE_SOURCE, BRIDGE_MIN_ZOOM, baseClass } from '../public/infra.js';
import { infraBefore } from '../public/infralayer.js';
import { BASEMAPS, buildStyle, mergeSettings, defaultSettings, SATELLITE_TILES } from '../public/layers.js';

test('the satellite background is Sentinel-2 cloudless, in web mercator tiles', () => {
  const sat = BASEMAPS.find((b) => b.id === 'satellite');
  assert.equal(SATELLITE_TILES, 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg');
  assert.equal(sat.maxzoom, 14, 'enlarged beyond 10 m pixels');
  assert.match(sat.attribution, /Copernicus Sentinel/);
  assert.match(sat.attribution, /BY-NC-SA/);
  const s = buildStyle({ ...defaultSettings(), basemap: 'satellite' });
  assert.equal(s.layers.find((l) => l.id === 'satellite').layout.visibility, 'visible');
});

test('roads, bridges and buildings are remembered, off at first', () => {
  assert.equal(defaultSettings().infra, false);
  assert.equal(mergeSettings({ infra: true }).infra, true);
  assert.equal(mergeSettings({ infra: 'yes' }).infra, false);
  assert.equal(mergeSettings({ basemap: 'satellite' }).basemap, 'satellite');
});

test('the layers are ours, from the vector tiles or the built bridges, and well formed', () => {
  const layers = infraLayers();
  assert.ok(layers.length >= 8);
  for (const l of layers) {
    assert.ok(l.id.startsWith(PREFIX), l.id);
    assert.ok([SOURCE, BRIDGE_SOURCE].includes(l.source), l.id);
    if (l.source === SOURCE) assert.ok(l['source-layer'], `${l.id} names its tile layer`);
  }
  assert.equal(new Set(layers.map((l) => l.id)).size, layers.length, 'ids are unique');
  const ids = layers.map((l) => l.id);
  assert.ok(ids.indexOf(`${PREFIX}road`) > ids.indexOf(`${PREFIX}road-casing`), 'casing under the road');
  assert.equal(layers.find((l) => l.id === `${PREFIX}building`).type, 'fill-extrusion');
  assert.equal(layers.find((l) => l.id === `${PREFIX}bridge-3d`).minzoom, BRIDGE_MIN_ZOOM);
});

test('the works go over the backgrounds and overlays, under the ships', () => {
  const layers = [{ id: 'bg', type: 'background' }, { id: 'sjokart' }, { id: 'depth-areas' }, { id: 'hillshade' }, { id: 'infra-road' }, { id: 'ais-hull' }];
  assert.equal(infraBefore(layers, ['sjokart', 'depth-areas']), 'ais-hull');
  assert.equal(infraBefore(layers.slice(0, 5), ['sjokart', 'depth-areas']), undefined, 'on top when nothing is above');
});

test('local metres and back', () => {
  const o = [5.74, 58.97];
  const p = toLonLat([1000, -500], o);
  const [x, y] = toLocal(p, o);
  assert.ok(Math.abs(x - 1000) < 1e-6 && Math.abs(y + 500) < 1e-6);
});

test('bridge decks stand higher on longer bridges, within reason', () => {
  assert.ok(bridgeClearance(30) <= 5);
  assert.ok(Math.abs(bridgeClearance(1067) - 30.7) < 1, 'about Stavanger city bridge');
  assert.equal(bridgeClearance(5000), 70);
  assert.ok(bridgeClearance(400, 'path') <= 12, 'a footbridge');
  assert.equal(deckProfile(0), 0);
  assert.equal(deckProfile(1), 0);
  assert.equal(deckProfile(0.5), 1);
  assert.ok(deckProfile(0.2) > 0.6, 'rises quickly off the ends');
});

/** A bridge way from (lon, lat) eastwards `m` metres, cut in `pieces` as tiles would. */
function bridge(id, m, { cls = 'secondary', pieces = 1, lat = 58.97, lon = 5.7 } = {}) {
  const o = [lon, lat];
  const pts = Array.from({ length: 11 }, (_, i) => toLonLat([(m * i) / 10, 0], o));
  const per = Math.ceil(10 / pieces);
  const out = [];
  for (let k = 0; k < 10; k += per) {
    out.push({ id, type: 'Feature', properties: { class: cls, brunnel: 'bridge', layer: 1 }, geometry: { type: 'LineString', coordinates: pts.slice(k, Math.min(11, k + per + 1)) } });
  }
  return out;
}

test('a bridge cut across tiles is built as one: decks rise to the middle, piers under them', () => {
  const whole = buildBridges(bridge(1, 800));
  const cut = buildBridges(bridge(1, 800, { pieces: 3 }));
  const tops = (fc) => fc.features.filter((f) => f.properties.part === 'deck').map((f) => f.properties.top);
  assert.ok(Math.abs(Math.max(...tops(whole)) - Math.max(...tops(cut))) < 0.5, 'same height in pieces');
  const H = bridgeClearance(800);
  assert.ok(Math.max(...tops(cut)) > H * 0.95 && Math.max(...tops(cut)) <= H);
  assert.ok(Math.min(...tops(cut)) < H * 0.5, 'low at the ends');
  const piers = whole.features.filter((f) => f.properties.part === 'pier');
  assert.ok(piers.length >= 10, `piers: ${piers.length}`);
  for (const p of piers) assert.equal(p.properties.base, 0);
  const towers = whole.features.filter((f) => f.properties.part === 'tower');
  assert.equal(towers.length, 4, 'two towers of two legs on a long bridge');
  for (const f of whole.features) {
    const r = f.geometry.coordinates[0];
    assert.deepEqual(r[0], r[r.length - 1], 'closed rings');
    assert.ok(f.properties.top > f.properties.base);
  }
});

test('carriageways side by side share their towers; short and foot bridges have none', () => {
  const twin = buildBridges([...bridge(1, 800), ...bridge(2, 800, { lat: 58.97001 })]);
  assert.equal(twin.features.filter((f) => f.properties.part === 'tower').length, 4);
  assert.equal(buildBridges(bridge(3, 120)).features.filter((f) => f.properties.part === 'tower').length, 0);
  const foot = buildBridges(bridge(4, 600, { cls: 'path' }));
  assert.equal(foot.features.filter((f) => f.properties.part !== 'deck').length, 0);
});

test('only road and rail bridges are built; anything else is left out', () => {
  const fc = buildBridges([
    { id: 9, properties: { class: 'bridge' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
    { id: 8, properties: { class: 'pier' }, geometry: { type: 'LineString', coordinates: [[5, 59], [5.001, 59]] } },
    { id: 7, properties: { class: 'rail' }, geometry: { type: 'MultiLineString', coordinates: [[[5, 59], [5.002, 59]]] } },
    { id: 6, properties: {}, geometry: null },
  ]);
  assert.ok(fc.features.length > 0);
  assert.ok(fc.features.every((f) => f.properties.color === '#7b7f86' || f.properties.part !== 'deck'), 'only the railway');
  assert.ok(buildBridges(bridge(5, 3000)).features.length <= 6000);
  assert.equal(buildBridges(bridge(5, 3000), [], { maxParts: 10 }).features.length, 10);
});

test('where NVDB knows a bridge, the road itself is raised to its heights, in the road\'s colour, without guessed towers', () => {
  const ways = bridge(7, 800);
  const plain = buildBridges(ways);
  assert.ok(plain.features.some((f) => f.properties.part === 'tower'), 'estimated: towers on a long bridge');
  const known = buildBridges(ways, [], { heightFor: () => () => 42 });
  const decks = known.features.filter((f) => f.properties.part === 'deck');
  assert.ok(decks.length > 10);
  assert.ok(decks.every((f) => f.properties.top === 42 && f.properties.road === 'secondary'));
  assert.equal(decks[0].properties.color, '#f7fabf', 'the secondary road\'s own colour');
  assert.equal(known.features.filter((f) => f.properties.part !== 'deck').length, 0, 'towers and piers come from NVDB instead');
});

test('roads being built are drawn, and raised on bridges, as the roads they become', () => {
  assert.equal(baseClass('motorway_construction'), 'motorway');
  assert.equal(baseClass('trunk'), 'trunk');
  const ways = bridge(8, 600, { cls: 'motorway_construction' });
  const decks = buildBridges(ways, [], { heightFor: () => () => 50 }).features.filter((f) => f.properties.part === 'deck');
  assert.ok(decks.length > 10);
  assert.equal(decks[0].properties.road, 'motorway');
  const road = infraLayers().find((l) => l.id === `${PREFIX}road`);
  assert.ok(JSON.stringify(road.filter).includes('motorway_construction'));
});
