import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldName, matchVessels, directoryRequest } from '../public/ais.js';

const ship = (mmsi, name, o = {}) => ({ mmsi, name, latitude: 59, longitude: 5.7, msgtime: '2026-11-24T12:00:00Z', ...o });
const LIST = [
  ship(257000001, 'BASTO ELECTRIC', { imoNumber: 9878319, callSign: 'LIDH' }),
  ship(257000002, 'VEDERØY'),
  ship(257000003, 'BASTO I'),
  ship(257000004, 'ELECTRIC BLUE'),
  ship(257000005, 'MS ÅLESUND', { callSign: 'LAJR' }),
  ship(257000006, 'NO POSITION', { latitude: null }),
  ship(258123456, 'STAVANGERFJORD', { imoNumber: 9745366 }),
];

test('names are folded for comparing: case, Norwegian letters, accents, punctuation', () => {
  assert.equal(foldName('Vederøy'), 'vederoy');
  assert.equal(foldName('MS ÅLESUND'), 'ms alesund');
  assert.equal(foldName('Sæbø-Lærdal'), 'saebo laerdal');
  assert.equal(foldName('  Côte  d’Azur '), 'cote d azur');
});

test('a name is found whole, from its start, from a word, or inside it, best first', () => {
  assert.deepEqual(matchVessels(LIST, 'basto').map((v) => v.mmsi), [257000001, 257000003]);
  assert.equal(matchVessels(LIST, 'basto electric')[0].mmsi, 257000001, 'the whole name first');
  assert.deepEqual(matchVessels(LIST, 'electric').map((v) => v.mmsi), [257000004, 257000001], 'start of the name before a later word');
  assert.equal(matchVessels(LIST, 'vedero')[0].mmsi, 257000002, 'ø typed as o');
  assert.equal(matchVessels(LIST, 'vederøy')[0].mmsi, 257000002);
  assert.equal(matchVessels(LIST, 'alesund')[0].mmsi, 257000005);
  assert.equal(matchVessels(LIST, 'angerfj')[0].mmsi, 258123456, 'inside the name');
  assert.deepEqual(matchVessels(LIST, 'b'), [], 'too short');
  assert.deepEqual(matchVessels(LIST, 'position'), [], 'ships without a position are left out');
});

test('MMSI, IMO number and call sign', () => {
  assert.equal(matchVessels(LIST, '257000002')[0].mmsi, 257000002);
  assert.equal(matchVessels(LIST, '9878319')[0].mmsi, 257000001);
  assert.deepEqual(matchVessels(LIST, '258').map((v) => v.mmsi), [258123456], 'number from the start');
  assert.equal(matchVessels(LIST, 'lajr')[0].mmsi, 257000005);
  assert.equal(matchVessels(LIST, 'LID')[0].mmsi, 257000001);
});

test('at most a few results, most recently heard first among equals', () => {
  const many = Array.from({ length: 10 }, (_, i) => ship(100 + i, `FJORD ${i}`, { msgtime: `2026-11-24T1${i}:00:00Z` }));
  const r = matchVessels(many, 'fjord');
  assert.equal(r.length, 6);
  assert.equal(r[0].mmsi, 109);
});

test('the directory asks for every ship, with full static data', () => {
  assert.deepEqual(directoryRequest(), { modelType: 'Full', modelFormat: 'Json' });
});
