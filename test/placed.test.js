import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placedReport, nextMmsi, isPlacedMmsi, carryOn, advance, stopped, parsePlaced, PLACED_BASE } from '../public/placed.js';
import { vesselSize, drawHeading, typeName } from '../public/ais.js';
import { distanceM, bearingDeg } from '../public/nav.js';

const spec = { name: 'Color Magic', kind: 'ferry', length: 223.7, beam: 35, draft: 6.8 };

test('a placed ship gets an MMSI no real ship has, and a report like an AIS one', () => {
  assert.equal(nextMmsi([]), PLACED_BASE + 1);
  assert.equal(nextMmsi([PLACED_BASE + 1, PLACED_BASE + 2]), PLACED_BASE + 3);
  assert.ok(isPlacedMmsi(PLACED_BASE + 5));
  assert.ok(!isPlacedMmsi(257123000));
  const v = placedReport(spec, { lat: 59.05, lon: 9.69 }, 375, PLACED_BASE + 1, Date.UTC(2026, 10, 26));
  assert.equal(v.name, 'COLOR MAGIC');
  assert.equal(v.trueHeading, 15);
  assert.equal(drawHeading(v), 15);
  assert.equal(v.speedOverGround, 0);
  assert.equal(v.draught, 68);
  assert.match(typeName(v.shipType), /Passenger/i);
  const { length, beam, toBow } = vesselSize(v);
  assert.equal(length, 224);
  assert.equal(beam, 35);
  assert.equal(toBow, 112, 'antenna amidships');
  assert.equal(v.msgtime, '2026-11-26T00:00:00.000Z');
});

test('handed back, she carries on straight at her speed and course', () => {
  const t0 = Date.UTC(2026, 10, 26, 12);
  const v = { ...placedReport(spec, { lat: 59.05, lon: 9.69 }, 90, PLACED_BASE + 1, t0), speedOverGround: 10, courseOverGround: 90, trueHeading: 90, rateOfTurn: 30, simulated: true };
  const c = carryOn(v, t0);
  assert.equal(c.rateOfTurn, 0, 'no more turning');
  assert.equal(c.simulated, false);
  // an hour later (in steps, as Rudder moves it every few seconds): 10 nm east
  let w = c;
  for (let t = t0 + 60_000; t <= t0 + 3600_000; t += 60_000) w = advance(w, t);
  const d = distanceM(59.05, 9.69, w.latitude, w.longitude);
  assert.ok(Math.abs(d - 18520) < 50, `10 nm: ${d}`);
  assert.ok(Math.abs(bearingDeg(59.05, 9.69, w.latitude, w.longitude) - 90) < 0.2);
  assert.equal(w.speedOverGround, 10);
  const s = stopped(w, t0 + 3600_000);
  assert.equal(s.speedOverGround, 0);
  assert.equal(advance(s, t0 + 7200_000).latitude, s.latitude, 'stopped stays');
});

test('only sound placed ships come back from storage', () => {
  const ok = placedReport(spec, { lat: 59, lon: 9 }, 0, PLACED_BASE + 2);
  assert.deepEqual(parsePlaced([ok, { ...ok, mmsi: 257000000 }, { ...ok, latitude: 'x' }, null]).map((v) => v.mmsi), [PLACED_BASE + 2]);
  assert.deepEqual(parsePlaced('junk'), []);
});
