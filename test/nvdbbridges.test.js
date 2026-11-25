import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bridgesUrl, roadsUrl, parseWkt, bridgeKind, bridgeFromNvdb, roadsFromNvdb, deckProfile, heightAt, buildNvdbBridge, onBridge, inside,
} from '../public/nvdbbridges.js';
import { toLonLat } from '../public/infra.js';

test('NVDB is asked for bridges and roads in a box, in WGS 84', () => {
  const u = new URL(bridgesUrl([9.68, 59.04, 9.7, 59.06]));
  assert.equal(u.host, 'nvdbapiles.atlas.vegvesen.no');
  assert.equal(u.pathname, '/vegobjekter/api/v4/vegobjekter/60');
  assert.equal(u.searchParams.get('kartutsnitt'), '9.68000,59.04000,9.70000,59.06000');
  assert.equal(u.searchParams.get('srid'), '4326');
  assert.match(u.searchParams.get('inkluder'), /geometri/);
  assert.equal(new URL(roadsUrl([0, 0, 1, 1])).pathname, '/vegnett/api/v4/veglenkesekvenser/segmentert');
});

test('NVDB writes latitude first; heights come along', () => {
  assert.deepEqual(parseWkt('LINESTRING Z (59.05 9.69 48.5, 59.06 9.70 49)'), [[[9.69, 59.05, 48.5], [9.7, 59.06, 49]]]);
  assert.deepEqual(parseWkt('POLYGON((59 9, 59 10, 60 10, 59 9))'), [[[9, 59], [10, 59], [10, 60], [9, 59]]]);
  assert.deepEqual(parseWkt('POLYGON Z ((59 9 1, 59 10 1, 60 10 1, 59 9 1), (59.1 9.1 1, 59.2 9.1 1, 59.1 9.2 1, 59.1 9.1 1))').length, 1, 'outer ring only');
  assert.equal(parseWkt('MULTIPOLYGON(((59 9, 59 10, 60 10, 59 9)),((61 9, 61 10, 62 10, 61 9)))').length, 2);
  assert.deepEqual(parseWkt('nonsense'), []);
});

test("the kind of bridge from NVDB's type; tunnels, culverts and quays are no bridges", () => {
  assert.equal(bridgeKind('Hengebru (723)'), 'suspension');
  assert.equal(bridgeKind('Skråstagbru (752)'), 'cable-stayed');
  assert.equal(bridgeKind('Bue/hvelv (5)'), 'arch');
  assert.equal(bridgeKind('Kassebru (415)'), 'box');
  assert.equal(bridgeKind('Platebru (210)'), 'girder');
  assert.equal(bridgeKind('Flytebru (900)'), 'floating');
  for (const t of ['Tunnelportal (950)', 'Kulvert, plassp (111)', 'Ferjekaibru (810)', null]) assert.equal(bridgeKind(t), null, String(t));
});

// A bridge 600 m long running east from (9.69, 59.045), 10 m wide, its road rising to 48 m in the middle.
const o = [9.69, 59.045];
const P = (x, y) => toLonLat([x, y], o);
const wkt = (pts) => pts.map(([lon, lat, z]) => `${lat} ${lon}${z !== undefined ? ` ${z}` : ''}`).join(', ');
const outline = [P(0, -6), P(600, -6), P(600, 6), P(0, 6), P(0, -6)];
const nvdbBridge = (type = 'Hengebru (723)', span = 270) => ({
  id: 1, geometri: { wkt: `POLYGON((${wkt(outline)}))` },
  egenskaper: [{ navn: 'Navn', verdi: 'Brevik' }, { navn: 'Byggverkstype', verdi: type }, { navn: 'Lengde', verdi: 600 }, { navn: 'Lengste spenn', verdi: span }, { navn: 'Bredde', verdi: 10 }],
});
const deckZ = (x) => 30 + 18 * Math.sin((Math.PI * x) / 600);
const roads = {
  objekter: [
    { typeVeg: 'Enkel bilveg', geometri: { wkt: `LINESTRING Z (${wkt(Array.from({ length: 31 }, (_, i) => [...P(-50 + i * 23.33, 0), deckZ(-50 + i * 23.33)]))})` } },
    // a road under the bridge, across it, at 3 m: not the deck
    { typeVeg: 'Enkel bilveg', geometri: { wkt: `LINESTRING Z (${wkt([[...P(300, -40), 3], [...P(300, 0), 3], [...P(300, 40), 3]])})` } },
    { typeVeg: 'Bilferje', geometri: { wkt: `LINESTRING Z (${wkt([[...P(0, 0), 2], [...P(600, 0), 2]])})` } },
  ],
};

test('the deck follows the road over the bridge, not the road under it', () => {
  const b = bridgeFromNvdb(nvdbBridge());
  assert.deepEqual([b.kind, b.length, b.span, b.width, b.name], ['suspension', 600, 270, 10, 'Brevik']);
  const pf = deckProfile(b, roadsFromNvdb(roads));
  assert.ok(Math.abs(pf.length - 600) < 1);
  assert.ok(pf.profile.every((p) => p.z > 20), 'the 3 m road and the ferry are left out');
  assert.ok(Math.abs(heightAt(pf, 0.5) - 48) < 1);
  assert.ok(heightAt(pf, 0.05) < 36);
  assert.equal(deckProfile(b, []), null, 'no heights: nothing from NVDB');
});

test("a suspension bridge: towers at the main span's ends, cables, no piers under the main span", () => {
  const b = bridgeFromNvdb(nvdbBridge());
  const parts = buildNvdbBridge(b, roadsFromNvdb(roads));
  const of = (k) => parts.filter((f) => f.properties.part === k);
  assert.equal(of('tower').length, 4, 'two towers of two legs');
  assert.ok(of('cable').length > 100);
  const deckTop = Math.max(...of('deck').map((f) => f.properties.top));
  assert.ok(deckTop > 47 && deckTop < 50, `deck ${deckTop}`);
  const towerTop = of('tower')[0].properties.top;
  assert.ok(towerTop > deckTop + 25, `towers ${towerTop}`);
  // no pier within the main span (centred where the deck is highest: 165..435 m)
  const xOf = (f) => { const c = f.geometry.coordinates[0][0]; return (c[0] - o[0]) * 111320 * Math.cos((o[1] * Math.PI) / 180); };
  for (const p of of('pier')) { const x = xOf(p); assert.ok(x < 165 || x > 435, `pier at ${x}`); }
  for (const f of parts) assert.ok(f.properties.top > f.properties.base && f.properties.base >= 0);
});

test('other kinds: pylons and stays, an arch, piers', () => {
  const r = roadsFromNvdb(roads);
  const cs = buildNvdbBridge(bridgeFromNvdb(nvdbBridge('Skråstagbru (752)', 300)), r);
  assert.equal(cs.filter((f) => f.properties.part === 'tower').length, 4);
  assert.ok(cs.filter((f) => f.properties.part === 'cable').length > 50);
  const arch = buildNvdbBridge(bridgeFromNvdb(nvdbBridge('Bue/hvelv (5)', 200)), r);
  assert.ok(arch.some((f) => f.properties.part === 'arch'));
  const girder = buildNvdbBridge(bridgeFromNvdb(nvdbBridge('Kassebru (415)', 150)), r);
  assert.equal(girder.filter((f) => f.properties.part === 'tower').length, 0);
  assert.ok(girder.filter((f) => f.properties.part === 'pier').length >= 6);
});

test('OpenStreetMap pieces on an NVDB bridge are known, others not', () => {
  const b = bridgeFromNvdb(nvdbBridge());
  assert.equal(onBridge(P(300, 2), [b]), true);
  assert.equal(onBridge(P(300, 60), [b]), false);
  assert.equal(inside([1, 1], [[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]), true);
});
