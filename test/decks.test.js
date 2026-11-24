import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decksFor, defaultParams, KIND_PRESETS } from '../public/ships/presets.js';
import { hullFromAis } from '../public/ais.js';

test('car ferries get few decks, more as they get longer', () => {
  assert.equal(decksFor('ferry', 40), 1);
  assert.equal(decksFor('ferry', 70), 2);
  assert.equal(decksFor('ferry', 110), 3);
  assert.equal(decksFor('ferry', 139), 4, 'Basto Electric');
  assert.equal(decksFor('ferry', 400), KIND_PRESETS.ferry.decks, 'never more than the preset');
});

test('other kinds scale with length, never above their preset or below one deck', () => {
  assert.equal(decksFor('cruise', 300), 12);
  assert.equal(decksFor('cruise', 200), 8);
  assert.equal(decksFor('cargo', 70), 2);
  assert.equal(decksFor('tug', 10), 1);
  assert.equal(decksFor('container', 500), KIND_PRESETS.container.decks);
  for (const kind of Object.keys(KIND_PRESETS).filter((k) => k !== 'ferry')) {
    assert.equal(defaultParams(kind).decks, KIND_PRESETS[kind].decks, `${kind} at its typical length`);
  }
  assert.equal(defaultParams('ferry').decks, 5, 'a 180 m ro-pax');
});

test('a small passenger ship from AIS is not a tower of decks', () => {
  const v = { mmsi: 257000001, shipType: 60, dimensionA: 30, dimensionB: 10, dimensionC: 5, dimensionD: 5, draught: 30 };
  const { params } = hullFromAis(v);
  assert.equal(params.kind, 'ferry');
  assert.equal(params.decks, 1);
  // Superstructure height (decks of at least 2.5 m) stays below the ship's length / 6.
  assert.ok(params.decks * 2.5 < params.length / 6 + 2.5);
});
