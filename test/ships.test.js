import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectKind, defaultParams, paramsFromFacts, liveryFromFacts, DEFAULT_LIVERY } from '../public/ships/presets.js';
import { HullShape, buildHull } from '../public/ships/hull.js';
import { suggestLivery, NOT_A_PHOTO } from '../public/ships/livery.js';
import { searchShips, fetchShipFacts } from '../public/ships/wikidata.js';
import { fileTitleFromP18 } from '../public/ships/commons.js';
import { fmtLen } from '../public/ships/callouts.js';

const facts = (over = {}) => ({
  qid: 'Q1', label: 'Test', types: [], builders: [], operators: [], owners: [], flags: [], homePorts: [], shipClass: [], colors: [], ...over,
});

test('the vessel type comes from Wikidata types, class and description', () => {
  assert.equal(detectKind(['container ship']), 'container');
  assert.equal(detectKind(['cruiseferry', 'ro-ro passenger ship']), 'ferry');
  assert.equal(detectKind(['ocean liner', 'cruise ship']), 'cruise');
  assert.equal(detectKind(['four funnel liner', 'shipwreck']), 'liner');
  assert.equal(detectKind(['supercarrier']), 'carrier');
  assert.equal(detectKind(['training vessel', 'barque']), 'sailing');
  assert.equal(detectKind(['sailing frigate']), 'sailing'); // not a modern warship
  assert.equal(detectKind(['frigate']), 'warship');
  assert.equal(detectKind(['oil tanker']), 'tanker');
  assert.equal(detectKind(['something unknown']), 'cargo');
});

test('Wikidata dimensions are used as given and flagged, missing ones estimated', () => {
  const { params, sources } = paramsFromFacts(facts({ types: ['container ship'], length: 399.9, beam: 58.8 }));
  assert.equal(params.kind, 'container');
  assert.equal(params.length, 399.9);
  assert.equal(params.beam, 58.8);
  assert.deepEqual(sources, { length: 'wikidata', beam: 'wikidata', draft: 'estimated', airDraft: 'estimated' });
  assert.ok(params.draft > 10 && params.draft < 25, `draft ${params.draft}`);
  assert.ok(params.depth > params.draft);
});

test('nonsense values are ignored and estimated instead', () => {
  const { params, sources } = paramsFromFacts(facts({ types: ['ferry'], length: 0.2, beam: 5000 }));
  assert.equal(sources.length, 'estimated');
  assert.equal(sources.beam, 'estimated');
  assert.ok(params.length > 10 && params.beam < 100);
});

test('the same item always builds the same ship', () => {
  assert.equal(paramsFromFacts(facts({ qid: 'Q25173' })).params.seed, paramsFromFacts(facts({ qid: 'Q25173' })).params.seed);
});

test('Wikidata colour statements seed the livery', () => {
  const lv = liveryFromFacts('cargo', facts({ colors: ['black', 'white'] }));
  assert.equal(lv.hull, '#151515');
  assert.equal(lv.superstructure, '#f4f4f2');
  assert.deepEqual(liveryFromFacts('tug'), DEFAULT_LIVERY.tug);
});

test('the hull has the given beam amidships and closes at the bow', () => {
  const p = defaultParams('cargo', 120);
  const s = new HullShape(p);
  assert.ok(Math.abs(s.halfBreadth(0.5, p.draft) - p.beam / 2) < 1e-9);
  assert.equal(s.halfBreadth(1, p.draft), 0);
  assert.equal(s.halfBreadth(0.5, s.keelH(0.5)), 0); // keel on the centreline
  assert.ok(s.planW(0, p.depth) > 0.3, 'a transom stern stays wide at the deck');
  const d = s.deckAt(0);
  assert.ok(Math.abs(d.y - (p.depth - p.draft)) < 0.05, 'deck amidships is depth minus draft above the waterline');
});

test('the hull mesh spans the length, beam and draft', () => {
  const p = defaultParams('tanker', 250);
  const hb = buildHull(p);
  hb.hull.computeBoundingBox();
  const box = hb.hull.boundingBox;
  assert.ok(Math.abs(box.max.x - box.min.x - p.length) < p.length * 0.03, `length ${box.max.x - box.min.x}`);
  assert.ok(Math.abs(box.max.z * 2 - p.beam) < 1e-6);
  assert.ok(Math.abs(box.min.y + p.draft) < 1e-6, 'keel at -draft');
  assert.ok(hb.transom, 'a transom stern has a transom plate');
  assert.ok(hb.bulb, 'tankers get a bulbous bow');
  const cruiser = buildHull({ ...p, stern: 'cruiser', bow: 'raked' });
  assert.equal(cruiser.transom, null);
  assert.equal(cruiser.bulb, null);
});

test('photo colours map onto hull, superstructure, funnel and boot-top', () => {
  const sw = (hex, share, meanY, lum, sat, hue, role) => ({ hex, share, meanY, lum, sat, hue, role });
  const palette = [
    sw('#d9dcdb', 0.27, 0.35, 0.86, 0.03, 160), // white superstructure
    sw('#10161b', 0.19, 0.62, 0.08, 0.25, 207), // black hull
    sw('#6b787d', 0.18, 0.85, 0.45, 0.08, 197), // quay
    sw('#b3d1ef', 0.13, 0.1, 0.82, 0.65, 211, 'sky'),
    sw('#941a14', 0.02, 0.75, 0.33, 0.76, 3), // antifouling
    sw('#e8b020', 0.02, 0.2, 0.52, 0.81, 43), // funnel
  ];
  const lv = suggestLivery(palette, DEFAULT_LIVERY.cruise);
  assert.equal(lv.hull, '#10161b');
  assert.equal(lv.superstructure, '#d9dcdb');
  assert.equal(lv.bootTop, '#941a14');
  assert.equal(lv.funnel, '#e8b020');
});

test('insignia, plans and maps are not used as livery photos', () => {
  assert.ok(NOT_A_PHOTO.test('CVN-68 insignia.jpg'));
  assert.ok(NOT_A_PHOTO.test('Titanic deck plan.png'));
  assert.ok(!NOT_A_PHOTO.test('Qm2 portboston (cropped).jpg'));
  assert.equal(fileTitleFromP18('http://commons.wikimedia.org/wiki/Special:FilePath/RMS%20Titanic%203.jpg'), 'RMS Titanic 3.jpg');
});

test('lengths read in metres or feet', () => {
  assert.equal(fmtLen(269.1, 'metric'), '269.1 m');
  assert.equal(fmtLen(10.54, 'metric'), '10.54 m');
  assert.equal(fmtLen(269.1, 'imperial'), '883 ft');
});

function stubFetch(bindings) {
  const calls = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(new URL(url).searchParams.get('query'));
    return { ok: true, json: async () => ({ results: { bindings } }) };
  };
  return { calls, restore: () => { globalThis.fetch = prev; } };
}
const lit = (value) => ({ type: 'literal', value: String(value) });

test('search escapes the term and reads the hits', async () => {
  const f = stubFetch([{ item: { value: 'http://www.wikidata.org/entity/Q25173' }, itemLabel: lit('Titanic'), type: lit('four funnel liner'), length: lit('269.1') }]);
  try {
    const hits = await searchShips('Ti"tanic\\');
    assert.deepEqual(hits, [{ qid: 'Q25173', label: 'Titanic', description: undefined, type: 'four funnel liner', image: undefined, length: 269.1 }]);
    assert.match(f.calls[0], /mwapi:search "Ti\\"tanic\\\\"/);
    assert.deepEqual(await searchShips('   '), []);
    assert.equal(f.calls.length, 1, 'a blank search asks nothing');
  } finally {
    f.restore();
  }
});

test('facts are parsed, lists de-duplicated and speed turned into knots', async () => {
  const f = stubFetch([{
    itemLabel: lit('Titanic'), length: lit('269.1'), beam: lit('28.2'), draft: lit('10.54'), height: lit('32'), speed: lit('12.3466'),
    types: lit('four funnel liner|shipwreck|shipwreck'), builders: lit('Harland and Wolff'), operators: lit(''), owners: lit('White Star Line'),
    flags: lit(''), ports: lit('Liverpool'), classes: lit('Olympic-class ocean liner'), colors: lit(''), serviceEntry: lit('1912-04-02T00:00:00Z'),
  }]);
  try {
    const x = await fetchShipFacts('Q25173');
    assert.equal(x.length, 269.1);
    assert.deepEqual(x.types, ['four funnel liner', 'shipwreck']);
    assert.deepEqual(x.operators, []);
    assert.equal(Math.round(x.speedKnots), 24);
    assert.equal(x.serviceEntry, '1912-04-02');
    assert.match(f.calls[0], /MAX\(COALESCE\(\?lenN, \?lenR\)\)/); // several lengths: the overall length wins
  } finally {
    f.restore();
  }
  await assert.rejects(fetchShipFacts('Q1; DROP'), /Invalid Wikidata id/);
});
