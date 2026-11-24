import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toLocal, hullAt, penetration, deepestContact, soundingPoints, seabedUrl, parseSeabed, groundCheck, allowedMotion,
} from '../public/contact.js';

const R = 6371008.8;
const north = (lat, m) => lat + (m / R) * 180 / Math.PI;
const east = (lat, lon, m) => lon + (m / (R * Math.cos(lat * Math.PI / 180))) * 180 / Math.PI;
// 100 m long, 20 m wide, antenna amidships on the centre line.
const ship = (mmsi, o = {}) => ({ mmsi, name: `SHIP ${mmsi}`, dimensionA: 50, dimensionB: 50, dimensionC: 10, dimensionD: 10, ...o });
const O = { lat: 59.43, lon: 10.53 };

test('local metres around an origin', () => {
  const [x, y] = toLocal([east(59.43, 10.53, 100), north(59.43, 50)], O);
  assert.ok(Math.abs(x - 100) < 0.01 && Math.abs(y - 50) < 0.01);
});

test('squares overlapping by 2 m, touching, and apart', () => {
  const sq = (x0) => [[x0, 0], [x0 + 10, 0], [x0 + 10, 10], [x0, 10]];
  assert.ok(Math.abs(penetration(sq(0), sq(8)) - 2) < 1e-9);
  assert.equal(penetration(sq(0), sq(10)), 0);
  assert.equal(penetration(sq(0), sq(25)), 0);
});

test('two ships side by side 30 m apart do not touch; 15 m apart they overlap by 5 m', () => {
  const a = hullAt(ship(1), { lat: O.lat, lon: O.lon, heading: 0 }, O);
  const far = hullAt(ship(2), { lat: O.lat, lon: east(O.lat, O.lon, 30), heading: 0 }, O);
  const near = hullAt(ship(2), { lat: O.lat, lon: east(O.lat, O.lon, 15), heading: 0 }, O);
  assert.equal(penetration(a, far), 0);
  assert.ok(Math.abs(penetration(a, near) - 5) < 0.05, `${penetration(a, near)}`);
  const worst = deepestContact(a, [{ v: ship(2), hull: far }, { v: ship(3), hull: near }, { v: ship(4), hull: null }]);
  assert.equal(worst.v.mmsi, 3);
  assert.equal(hullAt(ship(5), { lat: O.lat, lon: O.lon, heading: null }, O), null, 'no heading, no outline');
});

test('bow to bow: the pointed bows meet only when they really reach each other', () => {
  const a = hullAt(ship(1), { lat: O.lat, lon: O.lon, heading: 0 }, O);
  const ahead105 = hullAt(ship(2), { lat: north(O.lat, 105), lon: O.lon, heading: 180 }, O);
  const ahead95 = hullAt(ship(2), { lat: north(O.lat, 95), lon: O.lon, heading: 180 }, O);
  assert.equal(penetration(a, ahead105), 0);
  assert.ok(penetration(a, ahead95) > 0);
});

test('the hull is sounded at its bow, stern, antenna and both sides', () => {
  const pts = soundingPoints(ship(1, { dimensionA: 80, dimensionB: 20, dimensionC: 5, dimensionD: 15 }), { lat: O.lat, lon: O.lon, heading: 0 });
  const at = Object.fromEntries(pts.map(({ name, p }) => [name, toLocal(p, O)]));
  assert.ok(Math.abs(at.antenna[0]) < 1e-6 && Math.abs(at.antenna[1]) < 1e-6);
  assert.ok(Math.abs(at.bow[1] - 80 * 0.97) < 0.01, 'bow 80 m ahead of the antenna');
  assert.ok(Math.abs(at.stern[1] + 20 * 0.97) < 0.01, 'stern 20 m astern');
  assert.ok(Math.abs(at.bow[0] - 5) < 0.01, 'on the centre line (5 m to starboard of an antenna 5 m from port)');
  assert.ok(at['port side'][0] < 0 && at['starboard side'][0] > 10, 'the sides');
  const turned = soundingPoints(ship(1), { lat: O.lat, lon: O.lon, heading: 90 });
  assert.ok(toLocal(turned[0].p, O)[0] > 40, 'heading east: the bow is east');
});

test("Kartverket's answer: sea with depth, or land", () => {
  const url = new URL(seabedUrl([[10.5, 59.4], [10.6, 59.5]]));
  assert.equal(url.searchParams.get('punkter'), '[[10.5,59.4],[10.6,59.5]]');
  assert.equal(url.searchParams.get('koordsys'), '4258');
  assert.deepEqual(parseSeabed({ punkter: [
    { datakilde: 'dybdekurver', terreng: 'Havflate', z: -22.2 },
    { datakilde: 'dtm1', terreng: 'ÅpentOmråde', z: 13.29 },
    { terreng: 'Havflate', z: 0.4 },
  ] }), [{ sea: true, depth: 22.2 }, { sea: false, height: 13.29 }, { sea: true, depth: 0 }]);
});

test('aground: land or too little water at any sounded point, the first one named', () => {
  const pts = ['bow', 'stern', 'antenna', 'port side', 'starboard side'].map((name) => ({ name }));
  const deep = (d) => ({ sea: true, depth: d });
  const ok = groundCheck(pts, [deep(30), deep(25), deep(28), deep(27), deep(29)], 6.5);
  assert.deepEqual(ok, { hit: null, depth: 28 });
  assert.deepEqual(groundCheck(pts, [{ sea: false, height: 2 }, deep(25), deep(28), deep(27), deep(29)], 6.5).hit, { name: 'bow', reason: 'land' });
  assert.deepEqual(groundCheck(pts, [deep(30), deep(25), deep(28), deep(5.9), deep(29)], 6.5).hit, { name: 'port side', reason: 'shallow', depth: 5.9 });
  assert.equal(groundCheck(pts, [], 6.5).hit, null, 'no answer: not aground');
});

test('aground, the ship only moves away from where it touches', () => {
  const s = { u: 2, v: 0.5, r: 0.01 };
  assert.equal(allowedMotion({ name: 'bow' }, s).u, 0);
  assert.equal(allowedMotion({ name: 'bow' }, { ...s, u: -1 }).u, -1, 'astern off the bow');
  assert.equal(allowedMotion({ name: 'stern' }, s).u, 2, 'ahead off the stern');
  assert.equal(allowedMotion({ name: 'stern' }, { ...s, u: -1 }).u, 0);
  assert.equal(allowedMotion({ name: 'starboard side' }, s).v, 0);
  assert.equal(allowedMotion({ name: 'port side' }, s).v, 0.5);
  assert.equal(allowedMotion(null, s), s);
});
