import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TELEGRAPH, telegraphPower, handlingFor, initialState, neutralControls, step, overGround, simReport, thrusterGrip, RUDDER_MAX,
} from '../public/shiphandling.js';

const KNOT = 1852 / 3600;
const R = 6371008.8;
const ferry = (o = {}) => ({ mmsi: 1, shipType: 60, latitude: 59, longitude: 10.5, trueHeading: 0, speedOverGround: 0,
  dimensionA: 70, dimensionB: 69, dimensionC: 10, dimensionD: 11, draught: 55, msgtime: '2026-11-24T12:00:00Z', ...o });
const run = (s, c, h, seconds, dt = 0.1) => { for (let t = 0; t < seconds; t += dt) s = step(s, c, h, dt); return s; };
const metres = (a, b) => ({
  north: ((b.lat - a.lat) * Math.PI / 180) * R,
  east: ((b.lon - a.lon) * Math.PI / 180) * R * Math.cos(a.lat * Math.PI / 180),
});

test('the telegraph runs from full astern to full ahead', () => {
  assert.equal(TELEGRAPH.length, 9);
  assert.equal(telegraphPower(4), 1);
  assert.equal(telegraphPower(0), 0);
  assert.equal(telegraphPower(-4), -1);
  assert.equal(telegraphPower(9), 0);
});

test('handling follows type and size', () => {
  const big = handlingFor(ferry());
  const small = handlingFor(ferry({ dimensionA: 20, dimensionB: 20, dimensionC: 5, dimensionD: 5 }));
  assert.equal(big.kind, 'ferry');
  assert.ok(big.bow && big.stern, 'ferries have bow and stern thrusters');
  assert.ok(big.aheadMs / KNOT > 13 && big.aheadMs / KNOT <= 16);
  assert.ok(small.aheadMs < big.aheadMs, 'small ships are slower');
  assert.ok(small.tauSpeed < big.tauSpeed, 'and quicker to answer');
  const tanker = handlingFor(ferry({ shipType: 80, dimensionA: 200, dimensionB: 50, dimensionC: 20, dimensionD: 20 }));
  assert.ok(tanker.bow && !tanker.stern);
  const tug = handlingFor(ferry({ shipType: 52, dimensionA: 20, dimensionB: 10, dimensionC: 5, dimensionD: 5 }));
  assert.ok(!tug.bow && tug.turnRadius < 2 * tug.length, 'tugs turn tightly');
  assert.equal(handlingFor(ferry({ shipType: 36, dimensionA: 15, dimensionB: 5 })).bow, false, 'sailing ships have no thrusters');
});

test('full ahead builds up to service speed, and a stopped engine lets the ship coast down slowly', () => {
  const h = handlingFor(ferry());
  let s = initialState(ferry());
  s = run(s, { ...neutralControls(), order: 4 }, h, 600);
  assert.ok(Math.abs(s.u - h.aheadMs) < 0.05 * h.aheadMs, `${s.u / KNOT} kn`);
  const afterMinute = run(s, neutralControls(), h, 60);
  assert.ok(afterMinute.u > 0.4 * h.aheadMs, 'still making way a minute after stopping');
  const astern = run(s, { ...neutralControls(), order: -4 }, h, 900);
  assert.ok(astern.u < 0 && Math.abs(astern.u + h.asternMs) < 0.05 * h.asternMs, 'full astern ends going astern');
});

test('heading north at speed, the ship moves north', () => {
  const h = handlingFor(ferry());
  const s0 = { ...initialState(ferry()), u: 10 * KNOT };
  const s = run(s0, { ...neutralControls(), order: 2 }, h, 10);
  const d = metres(s0, s);
  assert.ok(d.north > 40 && Math.abs(d.east) < 0.5);
});

test('starboard rudder turns to starboard; hard over gives a circle of a few ship lengths', () => {
  const h = handlingFor(ferry());
  let s = { ...initialState(ferry()), u: h.aheadMs };
  const c = { ...neutralControls(), order: 4, rudder: RUDDER_MAX };
  const one = run(s, c, h, 20);
  assert.ok(one.heading > 5 && one.heading < 180, `turned to starboard: ${one.heading}`);
  // Steady turning rate gives the circle: radius = speed / rate.
  s = run(s, c, h, 120);
  const radius = s.u / s.r;
  assert.ok(radius > 1.7 * h.length && radius < 2.6 * h.length, `radius ${radius} m for ${h.length} m`);
  assert.ok(s.u < 0.85 * h.aheadMs, 'speed is lost in the turn');
  const port = run({ ...initialState(ferry()), u: h.aheadMs }, { ...c, rudder: -RUDDER_MAX }, h, 20);
  assert.ok(port.heading > 180, 'port rudder turns to port');
});

test('the rudder does nothing without way on or a running propeller', () => {
  const h = handlingFor(ferry());
  const s = run(initialState(ferry()), { ...neutralControls(), rudder: RUDDER_MAX }, h, 60);
  assert.equal(Math.round(s.heading * 1000), 0);
});

test('thrusters turn the ship on the spot and push it sideways, until it gathers way', () => {
  const h = handlingFor(ferry());
  const s0 = initialState(ferry());
  const spin = run(s0, { ...neutralControls(), bow: 1, stern: -1 }, h, 60);
  assert.ok(spin.heading > 20 && spin.heading < 180, `turned to starboard on the spot: ${spin.heading}`);
  const d = metres(s0, spin);
  assert.ok(Math.hypot(d.north, d.east) < 5, 'without moving off');
  const sideways = run(s0, { ...neutralControls(), bow: 1, stern: 1 }, h, 60);
  const ds = metres(s0, sideways);
  assert.ok(ds.east > 5 && Math.abs(sideways.heading) < 1, `moved to starboard: ${ds.east} m`);
  assert.equal(thrusterGrip(0), 1);
  assert.equal(thrusterGrip(6 * KNOT), 0);
  const tug = ferry({ shipType: 52, dimensionA: 20, dimensionB: 10, dimensionC: 5, dimensionD: 5 });
  const none = run(initialState(tug), { ...neutralControls(), bow: 1, stern: -1 }, handlingFor(tug), 30);
  assert.equal(Math.round(none.heading * 1000), 0, 'no thrusters, no turn');
});

test('a long pause is not one huge step', () => {
  const h = handlingFor(ferry());
  const s0 = { ...initialState(ferry()), u: 10 * KNOT };
  const s = step(s0, neutralControls(), h, 3600);
  assert.ok(metres(s0, s).north < 10);
});

test('the simulated ship is reported like an AIS ship', () => {
  const s = { lat: 59.1, lon: 10.6, heading: 90, u: 5 * KNOT, v: 0, r: (2 * Math.PI) / 180 / 60 };
  assert.deepEqual(Object.values(overGround(s)).map((x) => +x.toFixed(3)), [5, 90]);
  const r = simReport(ferry(), s, Date.parse('2026-11-24T13:00:00Z'));
  assert.equal(r.latitude, 59.1);
  assert.equal(r.trueHeading, 90);
  assert.equal(r.speedOverGround, 5);
  assert.equal(r.rateOfTurn, 2);
  assert.equal(r.msgtime, '2026-11-24T13:00:00.000Z');
  assert.equal(r.simulated, true);
  assert.equal(r.name, undefined);
  assert.equal(initialState(ferry({ trueHeading: 511, courseOverGround: 45 })).heading, 45);
});
