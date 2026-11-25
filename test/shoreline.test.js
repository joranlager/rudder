import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearestShore, nearerWay, guessHeading, cutByTile, tileXY, SHORE_REACH_M } from '../public/shoreline.js';
import { drawHeading, reportedHeading, mergeVessels, toGeoJson, vesselOutline } from '../public/ais.js';

const R = 6371008.8;
const at = (lat, lon, north, east) => [lon + (east / (R * Math.cos((lat * Math.PI) / 180))) * (180 / Math.PI), lat + (north / R) * (180 / Math.PI)];
const LAT = 58.46605, LON = 8.79262; // Ragni Berg at Halvøya

test('the nearest stretch of shore, and which way it runs', () => {
  // a quay running ENE (64°) 8 m north of the ship
  const a = at(LAT, LON, 8, 0);
  const quay = [at(LAT, LON, 8 - 50 * Math.cos(64 * Math.PI / 180), -50 * Math.sin(64 * Math.PI / 180)), at(LAT, LON, 8 + 50 * Math.cos(64 * Math.PI / 180), 50 * Math.sin(64 * Math.PI / 180))];
  const s = nearestShore(LON, LAT, [quay, [at(LAT, LON, 300, 0), at(LAT, LON, 300, 100)]], 60);
  assert.ok(Math.abs(s.along - 64) < 0.5, `along ${s.along}`);
  assert.ok(s.distance > 6 && s.distance < 8.5, `distance ${s.distance}`);
  assert.equal(nearestShore(LON, LAT, [quay], 3), null, 'too far');
  assert.ok(a);
});

test('the straight lines tiles cut the water with are not shore', () => {
  const [x, y] = tileXY([LON, LAT], 14);
  const edgeLon = (Math.floor(x) / 2 ** 14) * 360 - 180;
  const cut = [[edgeLon, LAT - 0.001], [edgeLon, LAT + 0.001]];
  assert.equal(cutByTile(cut[0], cut[1]), true);
  assert.equal(cutByTile([LON, LAT], [LON + 0.001, LAT + 0.0005]), false, 'a slanting quay');
  // a north-south shore right at the tile edge is taken for a cut; one well inside the tile is not
  const inside = ((Math.floor(x) + 0.5) / 2 ** 14) * 360 - 180;
  assert.equal(cutByTile([inside, LAT - 0.001], [inside, LAT + 0.001]), false);
  const s = nearestShore(edgeLon + 0.00005, LAT, [cut], 60);
  assert.equal(s, null, 'ignored');
  assert.ok(y > 0);
});

test('along the quay, the bow points the way it pointed before (else either way)', () => {
  assert.equal(nearerWay(64, 250), 244);
  assert.equal(nearerWay(64, 80), 64);
  assert.equal(nearerWay(64, undefined), 64);
  const shore = { distance: 5, along: 64 };
  assert.deepEqual(guessHeading({ courseOverGround: 360 }, shore, 4), { deg: 64, how: 'along the quay' });
  assert.deepEqual(guessHeading({ courseOverGround: 250 }, shore, 4), { deg: 244, how: 'along the quay' });
  assert.deepEqual(guessHeading({ knownHeading: 70, courseOverGround: 250 }, shore, 4), { deg: 64, how: 'along the quay' }, 'what it told before wins');
  assert.equal(guessHeading({}, { distance: 2 + SHORE_REACH_M + 1, along: 64 }, 4).how, 'not known (drawn north)', 'not alongside');
  assert.deepEqual(guessHeading({ knownHeading: 200 }, null), { deg: 200, how: 'as reported earlier' });
  assert.deepEqual(guessHeading({ courseOverGround: 136 }, null), { deg: 136, how: 'its last course' });
  assert.deepEqual(guessHeading({ courseOverGround: 360 }, null), { deg: 0, how: 'not known (drawn north)' });
});

const ship = (o = {}) => ({ mmsi: 257797500, name: 'RAGNI BERG', shipType: 70, latitude: LAT, longitude: LON, speedOverGround: 0, courseOverGround: 360, trueHeading: 511,
  dimensionA: 7, dimensionB: 7, dimensionC: 2, dimensionD: 2, msgtime: new Date().toISOString(), ...o });

test('a ship that tells no heading is drawn at true size on its guess, marked as guessed', () => {
  const v = ship();
  assert.equal(reportedHeading(v), null);
  assert.equal(drawHeading(v), null);
  assert.equal(vesselOutline(v), null, 'no guess yet: a dot');
  const g = { ...v, headingGuess: { deg: 64, how: 'along the quay', lat: LAT, lon: LON } };
  assert.equal(drawHeading(g), 64);
  assert.ok(vesselOutline(g));
  const { points, outlines } = toGeoJson([g]);
  assert.equal(points.features[0].properties.hasHeading, false, 'no arrow for a guess');
  assert.equal(points.features[0].properties.guessed, true);
  assert.equal(outlines.features.length, 1);
  assert.equal(toGeoJson([ship({ trueHeading: 90 })]).points.features[0].properties.guessed, false);
});

test('a heading told is remembered; a guess goes when the ship moves or tells its own', () => {
  const m = new Map();
  const t = (min) => new Date(Date.now() - min * 60000).toISOString();
  mergeVessels(m, [ship({ trueHeading: 250, msgtime: t(10) })]);
  mergeVessels(m, [ship({ msgtime: t(5) })]);
  assert.equal(m.get(257797500).knownHeading, 250);
  m.get(257797500).headingGuess = { deg: 244, how: 'along the quay', lat: LAT, lon: LON };
  mergeVessels(m, [ship({ msgtime: t(4) })]);
  assert.ok(m.get(257797500).headingGuess, 'still there: kept');
  mergeVessels(m, [ship({ msgtime: t(3), latitude: LAT + 0.001 })]);
  assert.equal(m.get(257797500).headingGuess, undefined, 'moved: guessed again');
  m.get(257797500).headingGuess = { deg: 244, how: 'along the quay', lat: LAT + 0.001, lon: LON };
  mergeVessels(m, [ship({ msgtime: t(2), latitude: LAT + 0.001, trueHeading: 245 })]);
  assert.equal(m.get(257797500).headingGuess, undefined, 'told its own');
  assert.equal(drawHeading(m.get(257797500)), 245);
});
