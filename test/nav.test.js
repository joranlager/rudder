import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distanceM, bearingDeg, formatDM, formatPosition, formatDistance, compassPoint, msToKnots, NM } from '../public/nav.js';

test('one minute of latitude is one nautical mile', () => {
  assert.ok(Math.abs(distanceM(60, 5, 60 + 1 / 60, 5) - NM) < 5);
});

test('bearings point the right way', () => {
  assert.ok(Math.abs(bearingDeg(59, 5, 60, 5) - 0) < 0.01);
  assert.ok(Math.abs(bearingDeg(59, 5, 59, 6) - 90) < 0.5);
  assert.ok(Math.abs(bearingDeg(59, 5, 58, 5) - 180) < 0.01);
});

test('positions in degrees and decimal minutes', () => {
  assert.equal(formatDM(59.5, 'lat'), "59°30.000'N");
  assert.equal(formatDM(5.25, 'lon'), "005°15.000'E");
  assert.equal(formatDM(-0.5, 'lon'), "000°30.000'W");
  assert.equal(formatDM(59.99999999, 'lat'), "60°00.000'N");
  assert.equal(formatPosition(58.974, 5.73), "58°58.440'N 005°43.800'E");
});

test('short distances in metres, longer in nautical miles', () => {
  assert.equal(formatDistance(400), '400 m');
  assert.equal(formatDistance(NM), '1.00 nm');
  assert.equal(formatDistance(25 * NM), '25.0 nm');
});

test('compass points and knots', () => {
  assert.equal(compassPoint(0), 'N');
  assert.equal(compassPoint(359), 'N');
  assert.equal(compassPoint(225), 'SW');
  assert.equal(compassPoint(-90), 'W');
  assert.ok(Math.abs(msToKnots(NM / 3600) - 1) < 1e-9);
});
