import { test } from 'node:test';
import assert from 'node:assert/strict';
import { predict, createMotion, remaining, angleDiff, hitsShip, bowAndStern, MAX_PREDICT_MS, EASE_MS } from '../public/motion.js';

const T0 = Date.parse('2026-11-24T12:00:00Z');
const KNOT = 1852 / 3600;
const R = 6371008.8;
const metresNorth = (a, b) => ((b.lat - a.lat) * Math.PI / 180) * R;
const metresEast = (a, b) => ((b.lon - a.lon) * Math.PI / 180) * R * Math.cos(a.lat * Math.PI / 180);
const ship = (o = {}) => ({
  mmsi: 1, msgtime: new Date(T0).toISOString(), latitude: 59, longitude: 5.7,
  speedOverGround: 10, courseOverGround: 90, trueHeading: 92, ...o,
});

test('a ship under way moves along its course at its speed', () => {
  const p = predict(ship(), T0 + 60e3);
  const start = { lat: 59, lon: 5.7 };
  assert.ok(Math.abs(metresEast(start, p) - 10 * KNOT * 60) < 0.5, 'one minute at 10 kn east is about 309 m');
  assert.ok(Math.abs(metresNorth(start, p)) < 0.5);
  assert.equal(p.heading, 92, 'the bow keeps its own heading (drift and current)');
  assert.equal(p.moving, true);
  const north = predict(ship({ courseOverGround: 0 }), T0 + 30e3);
  assert.ok(Math.abs(metresNorth(start, north) - 10 * KNOT * 30) < 0.5);
});

test('a ship lying still, or with no course, stays put', () => {
  for (const o of [{ speedOverGround: 0.1 }, { courseOverGround: 360 }, { speedOverGround: null }, { speedOverGround: 102.3 }]) {
    const p = predict(ship(o), T0 + 60e3);
    assert.deepEqual([p.lat, p.lon, p.moving], [59, 5.7, false], JSON.stringify(o));
  }
});

test('dead reckoning stops after five minutes without a report', () => {
  const a = predict(ship(), T0 + MAX_PREDICT_MS);
  const b = predict(ship(), T0 + MAX_PREDICT_MS + 10 * 60e3);
  assert.deepEqual([a.lat, a.lon], [b.lat, b.lon]);
  assert.equal(b.moving, false);
});

test('a turning ship follows an arc for a minute, then goes straight', () => {
  // 30 degrees a minute to starboard from east: after one minute the course is 120.
  const v = ship({ rateOfTurn: 30, trueHeading: 90 });
  const one = predict(v, T0 + 60e3);
  assert.ok(Math.abs(one.heading - 120) < 1e-9);
  const start = { lat: 59, lon: 5.7 };
  assert.ok(metresNorth(start, one) < -10, 'curved to the south');
  const two = predict(v, T0 + 120e3);
  assert.ok(Math.abs(two.heading - 120) < 1e-9, 'no more turning after a minute');
  // The second minute is a straight line along 120 degrees.
  const n = metresNorth(one, two), e = metresEast(one, two);
  assert.ok(Math.abs(Math.atan2(e, n) * 180 / Math.PI - 120) < 0.5);
  assert.ok(Math.abs(Math.hypot(n, e) - 10 * KNOT * 60) < 1);
  // "No information" rates of turn are ignored.
  assert.equal(predict(ship({ rateOfTurn: -720 }), T0 + 60e3).heading, 92);
});

test('a new report is eased in instead of making the ship jump', () => {
  const m = createMotion();
  const first = ship();
  const t1 = T0 + 30e3;
  const before = m.show(first, t1);
  // The new report puts the ship 50 m further north than predicted.
  const second = ship({ msgtime: new Date(t1).toISOString(), latitude: before.lat + (50 / R) * 180 / Math.PI, longitude: before.lon });
  const at = m.show(second, t1);
  assert.ok(Math.abs(metresNorth(before, at)) < 0.01 && Math.abs(metresEast(before, at)) < 0.01, 'no jump at the moment of the report');
  const half = m.show(second, t1 + EASE_MS / 2);
  const end = m.show(second, t1 + EASE_MS);
  const target = predict(second, t1 + EASE_MS);
  assert.ok(Math.abs(metresNorth(target, end)) < 0.01, 'all the way there after the easing');
  const midGap = metresNorth(predict(second, t1 + EASE_MS / 2), half);
  assert.ok(midGap < -20 && midGap > -30, `half way through the correction (${midGap})`);
});

test('easing and angles', () => {
  assert.equal(remaining(0), 1);
  assert.equal(remaining(1), 0);
  assert.equal(remaining(0.5), 0.5);
  assert.equal(remaining(-1), 1);
  assert.equal(angleDiff(10, 350), 20);
  assert.equal(angleDiff(350, 10), -20);
});

test('a heading change in a new report turns the model smoothly, the short way round', () => {
  const m = createMotion();
  m.show(ship({ trueHeading: 355, speedOverGround: 0 }), T0);
  const v2 = ship({ msgtime: new Date(T0 + 10e3).toISOString(), trueHeading: 5, speedOverGround: 0 });
  assert.equal(m.show(v2, T0 + 10e3).heading, 355);
  const mid = m.show(v2, T0 + 10e3 + EASE_MS / 2).heading;
  assert.equal(mid, 0, 'through north, not round by south');
});

test('hits follow the shown ship', () => {
  const { bow, stern } = bowAndStern(59, 5.7, 90, 100, 120);
  assert.ok(bow[1] > 5.7 && stern[1] < 5.7, 'bow east, stern west');
  const s = { x: 0, y: 0 }, b = { x: 100, y: 0 };
  assert.equal(hitsShip({ x: 50, y: 5 }, b, s, 8), true);
  assert.equal(hitsShip({ x: 50, y: 12 }, b, s, 8), false);
  assert.equal(hitsShip({ x: 105, y: 0 }, b, s, 8), true, 'a little slack at the ends');
  assert.equal(hitsShip({ x: 50, y: 5 }, b, s, 1), true, 'thin ships still get 6 px');
});
