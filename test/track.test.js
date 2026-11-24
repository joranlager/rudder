import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toRecord, staticOf, shouldKeep, between, positionAt, traceCoords, lastAtOrBefore, parseAgo, formatSpan, playbackReport,
  distanceM, MAX_GAP_MS, HOLD_MS, KEEP,
} from '../public/track.js';

const R = 6371008.8;
const T0 = Date.parse('2026-11-25T12:00:00Z');
const north = (lat, m) => lat + (m / R) * 180 / Math.PI;
const east = (lat, lon, m) => lon + (m / (R * Math.cos(lat * Math.PI / 180))) * 180 / Math.PI;
const rec = (o) => ({ m: 1, t: T0, la: 59, lo: 10, s: 10, c: 90, h: 90, ...o });
const KN = 1852 / 3600;

test('a report becomes a compact record; nonsense is left out', () => {
  const r = toRecord({ mmsi: 257000001, msgtime: '2026-11-25T12:00:00Z', latitude: 59.1234567, longitude: 10.7654321,
    speedOverGround: 12.34, courseOverGround: 45.67, trueHeading: 44 });
  assert.deepEqual(r, { m: 257000001, t: T0, la: 59.123457, lo: 10.765432, s: 12.3, c: 45.7, h: 44 });
  const unknown = toRecord({ mmsi: 1, msgtime: '2026-11-25T12:00:00Z', latitude: 59, longitude: 10, speedOverGround: 102.3, courseOverGround: 360, trueHeading: 511 });
  assert.deepEqual(unknown, { m: 1, t: T0, la: 59, lo: 10 });
  assert.equal(toRecord({ mmsi: 1, msgtime: 'x', latitude: 59, longitude: 10 }), null);
  assert.equal(toRecord({ mmsi: 1, msgtime: '2026-11-25T12:00:00Z', latitude: 91, longitude: 10 }), null);
  assert.deepEqual(staticOf({ mmsi: 7, name: 'A', shipType: 60, latitude: 1, callSign: '' }), { m: 7, name: 'A', shipType: 60 });
});

test('a report is kept when the ship has moved, turned or been quiet a while', () => {
  const a = rec({ s: 0 });
  assert.equal(shouldKeep(null, a), true);
  assert.equal(shouldKeep(a, rec({ t: T0 + 60e3, s: 0 })), false, 'lying still a minute later');
  assert.equal(shouldKeep(a, rec({ t: T0 + KEEP.quietMs })), true, 'still there after ten minutes');
  assert.equal(shouldKeep(a, rec({ t: T0 + 60e3, la: north(59, 30) })), true, 'moved 30 m');
  assert.equal(shouldKeep(a, rec({ t: T0 + 60e3, h: 100 })), true, 'turned 10°');
  assert.equal(shouldKeep(a, rec({ t: T0 - 1 })), false, 'older than the last kept');
});

test('between two records the ship follows a smooth curve that fits their velocities', () => {
  // Due east at 10 kn for 60 s: about 309 m, straight.
  const a = rec(), b = rec({ t: T0 + 60e3, lo: east(59, 10, 10 * KN * 60) });
  const mid = between(a, b, T0 + 30e3);
  assert.ok(Math.abs(mid.lat - 59) < 1e-7, 'stays on the line');
  const half = distanceM({ la: 59, lo: 10 }, { la: mid.lat, lo: mid.lon });
  assert.ok(Math.abs(half - 10 * KN * 30) < 1, `half way after half the time: ${half}`);
  assert.equal(mid.heading, 90);
  // A 90° turn: east then north. The curve bulges out like a real turn instead of cutting the corner.
  const c = rec({ c: 90, h: 90 }), d = rec({ t: T0 + 120e3, la: north(59, 400), lo: east(59, 10, 400), c: 0, h: 0 });
  const p = between(c, d, T0 + 60e3);
  const pe = (p.lon - 10) * Math.PI / 180 * R * Math.cos(59 * Math.PI / 180), pn = (p.lat - 59) * Math.PI / 180 * R;
  assert.ok(pe > pn, 'more east than north half way through a turn from east to north');
  assert.equal(Math.round(p.heading), 45, 'heading half way round');
  assert.equal(between(c, d, T0).lat, 59);
  assert.ok(Math.abs(between(c, d, T0 + 120e3).lat - d.la) < 1e-9, 'ends exactly at the second record');
});

test('velocities that do not fit the gap fall back to the straight line', () => {
  // The course says west but the ship went east: no loop backwards.
  const a = rec({ c: 270, h: 270 }), b = rec({ t: T0 + 60e3, lo: east(59, 10, 300), c: 270, h: 270 });
  for (const t of [T0 + 15e3, T0 + 30e3, T0 + 45e3]) assert.ok(between(a, b, t).lon >= 10, 'never behind the start');
  // Lying still with no speed: stays between the two.
  const s = between(rec({ s: undefined, c: undefined }), rec({ t: T0 + 60e3, lo: east(59, 10, 5), s: undefined, c: undefined }), T0 + 30e3);
  assert.ok(s.lon > 10 && s.lon < east(59, 10, 5));
});

test('a ship is placed from its records, held a while after the last, and gone after long silence', () => {
  const recs = [rec(), rec({ t: T0 + 60e3, lo: east(59, 10, 309) }), rec({ t: T0 + 60e3 + MAX_GAP_MS + 60e3, lo: east(59, 10, 5000) })];
  assert.equal(lastAtOrBefore(recs, T0 - 1), -1);
  assert.equal(lastAtOrBefore(recs, T0 + 61e3), 1);
  assert.equal(positionAt(recs, T0 - 1), null, 'not yet recorded');
  assert.ok(positionAt(recs, T0 + 30e3).lon > 10);
  const held = positionAt(recs, T0 + 60e3 + HOLD_MS - 1);
  assert.equal(held.lon, recs[1].lo, 'held at its last place over a long gap');
  assert.equal(positionAt(recs, T0 + 60e3 + HOLD_MS + 1), null, 'then gone');
  assert.equal(positionAt(recs, recs[2].t).lon, recs[2].lo, 'back when it reports again');
  assert.equal(positionAt([], T0), null);
});

test('a trace follows the smooth path between two times', () => {
  const recs = [rec(), rec({ t: T0 + 60e3, lo: east(59, 10, 309) }), rec({ t: T0 + 120e3, lo: east(59, 10, 618) })];
  const line = traceCoords(recs, T0, T0 + 90e3, 4);
  assert.equal(line[0][0], 10);
  assert.ok(line.length >= 6);
  for (let i = 1; i < line.length; i++) assert.ok(line[i][0] >= line[i - 1][0], 'onwards, east');
  assert.ok(line.at(-1)[0] < east(59, 10, 618) && line.at(-1)[0] > east(59, 10, 309));
  assert.deepEqual(traceCoords(recs, T0 + 10, T0), []);
});

test('playback times and spans', () => {
  assert.equal(parseAgo('1:30'), 90 * 60e3);
  assert.equal(parseAgo('0:05'), 5 * 60e3);
  assert.equal(parseAgo('45'), 45 * 60e3);
  assert.equal(parseAgo('2h'), 2 * 3600e3);
  assert.equal(parseAgo('1.5 h'), 1.5 * 3600e3);
  assert.equal(parseAgo('soon'), null);
  assert.equal(formatSpan(12 * 60e3), '12 min');
  assert.equal(formatSpan(185 * 60e3), '3 h 05 min');
  assert.equal(formatSpan(27 * 3600e3), '1 d 3 h');
});

test('a played-back ship is reported like an AIS ship', () => {
  const r = playbackReport({ m: 5, name: 'X', shipType: 70 }, { lat: 59, lon: 10, heading: null, cog: 45, sog: 7 }, T0);
  assert.deepEqual(r, { m: 5, name: 'X', shipType: 70, mmsi: 5, latitude: 59, longitude: 10, trueHeading: 511, courseOverGround: 45,
    speedOverGround: 7, msgtime: '2026-11-25T12:00:00.000Z', playback: true });
});

test('a ship lying still is held as long as the live chart keeps a report; one under way not', async () => {
  const { HOLD_STILL_MS } = await import('../public/track.js');
  const still = [rec({ s: 0 })], moving = [rec({ s: 10 })];
  assert.ok(positionAt(still, T0 + 60 * 60e3), 'an hour later, still there');
  assert.equal(positionAt(still, T0 + HOLD_STILL_MS + 1), null);
  assert.equal(positionAt(moving, T0 + HOLD_MS + 1), null);
});

test('when the recorder ran: polls close together make one stretch', async () => {
  const { addPoll, coveredMs, clampToCoverage, pruneSessions } = await import('../public/track.js');
  const P = 60e3;
  let s = [];
  for (let i = 0; i <= 30; i++) s = addPoll(s, T0 + i * P, P); // 30 minutes recording
  s = addPoll(s, T0 + 3 * 3600e3, P); // Rudder closed, opened again three hours later
  s = addPoll(s, T0 + 3 * 3600e3 + P, P);
  assert.deepEqual(s, [{ from: T0, to: T0 + 30 * P }, { from: T0 + 3 * 3600e3, to: T0 + 3 * 3600e3 + P }]);
  assert.equal(coveredMs(s), 31 * P);
  assert.deepEqual(clampToCoverage(s, T0 - 3600e3), { t: T0, moved: true }, 'before the recording: its start');
  assert.deepEqual(clampToCoverage(s, T0 + 10 * P), { t: T0 + 10 * P, moved: false });
  assert.deepEqual(clampToCoverage(s, T0 + 3600e3), { t: T0 + 3 * 3600e3, moved: true }, 'in the pause: the next stretch');
  assert.deepEqual(clampToCoverage(s, T0 + 9 * 3600e3), { t: T0 + 3 * 3600e3 + P, moved: true }, 'after: the end');
  assert.deepEqual(clampToCoverage([], T0), { t: T0, moved: false });
  assert.equal(pruneSessions(s, T0 + 3600e3).length, 1);
});
