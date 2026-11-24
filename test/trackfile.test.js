import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodePosition, decodePosition, decodeShip, mergeSessions, parseLine, writeTracksFile, readTracksFile, exportName, FORMAT,
} from '../public/trackfile.js';

const T0 = Date.parse('2026-11-25T12:00:00Z');
const rec = (o = {}) => ({ m: 257000001, t: T0, la: 59.123456, lo: 10.654321, s: 12.3, c: 45.6, h: 44, ...o });
async function* batches(list, size = 3) { for (let i = 0; i < list.length; i += size) yield list.slice(i, i + size); }

test('a position is a compact array, read back the same; unknown values are left off', () => {
  assert.deepEqual(encodePosition(rec()), [257000001, T0, 59.123456, 10.654321, 12.3, 45.6, 44]);
  assert.deepEqual(encodePosition({ m: 1, t: T0, la: 59, lo: 10 }), [1, T0, 59, 10]);
  assert.deepEqual(encodePosition({ m: 1, t: T0, la: 59, lo: 10, h: 90 }), [1, T0, 59, 10, null, null, 90]);
  assert.deepEqual(decodePosition(encodePosition(rec())), rec());
  assert.deepEqual(decodePosition([1, T0, 59, 10, null, null, 90]), { m: 1, t: T0, la: 59, lo: 10, h: 90 });
});

test('unsound positions are refused', () => {
  for (const bad of [null, [1, T0, 59], ['x', T0, 59, 10], [0, T0, 59, 10], [1, 'now', 59, 10], [1, 0, 59, 10],
    [1, T0, 91, 10], [1, T0, 59, 181], [1.5, T0, 59, 10]]) {
    assert.equal(decodePosition(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(decodePosition([1, T0, 59, 10, 102.3, 400, -5]), { m: 1, t: T0, la: 59, lo: 10 }, 'impossible speed and courses dropped');
});

test('ship descriptions keep plain values only', () => {
  assert.deepEqual(decodeShip({ m: 5, name: 'A', shipType: 60, evil: { x: 1 }, list: [1], long: 'x'.repeat(300) }), { m: 5, name: 'A', shipType: 60 });
  assert.equal(decodeShip({ name: 'no mmsi' }), null);
});

test('stretches of recording merge where they overlap or nearly touch', () => {
  const a = [{ from: 0, to: 100e3 }, { from: 3600e3, to: 3700e3 }];
  const b = [{ from: 50e3, to: 200e3 }, { from: 3700e3 + 60e3, to: 3800e3 }, { from: 'x', to: 1 }];
  assert.deepEqual(mergeSessions(a, b), [{ from: 0, to: 200e3 }, { from: 3600e3, to: 3800e3 }]);
  assert.deepEqual(mergeSessions(null, []), []);
});

test('lines: header, ship, position, and anything else is bad', () => {
  assert.equal(parseLine(JSON.stringify({ format: FORMAT, version: 1 })).kind, 'header');
  assert.equal(parseLine('{"ship":{"m":5,"name":"A"}}').kind, 'ship');
  assert.equal(parseLine(`[1,${T0},59,10]`).kind, 'pos');
  assert.equal(parseLine('').kind, 'blank');
  assert.equal(parseLine('{not json').kind, 'bad');
  assert.equal(parseLine('{"hello":1}').kind, 'bad');
  assert.equal(parseLine('[1,2]').kind, 'bad');
});

test('a recording survives export and import, compressed, a batch at a time', async () => {
  const positions = Array.from({ length: 10 }, (_, i) => rec({ m: 257000001 + (i % 3), t: T0 + i * 60e3 }));
  const ships = [{ m: 257000001, name: 'ONE', shipType: 60 }, { m: 257000002, name: 'TWO' }];
  const sessions = [{ from: T0, to: T0 + 9 * 60e3 }];
  const blob = await writeTracksFile({ positions: batches(positions), ships, sessions, count: positions.length });
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  assert.deepEqual([...head], [0x1f, 0x8b], 'gzip');
  const got = [], gotShips = [];
  const r = await readTracksFile(blob, { batch: 4, onPositions: async (l) => { got.push(...l); }, onShips: async (l) => { gotShips.push(...l); } });
  assert.deepEqual(got, positions);
  assert.deepEqual(gotShips, ships);
  assert.equal(r.positions, 10);
  assert.equal(r.ships, 2);
  assert.equal(r.bad, 0);
  assert.deepEqual(r.header.sessions, sessions);
  assert.equal(r.header.positions, 10);
});

test('plain (uncompressed) files are read too, bad lines skipped and counted', async () => {
  const text = [JSON.stringify({ format: FORMAT, version: 1, sessions: [] }), `[1,${T0},59,10]`, 'garbage', `[2,${T0},95,10]`, '', `[3,${T0},60,11,5]`].join('\n');
  const got = [];
  const r = await readTracksFile(new Blob([text]), { onPositions: async (l) => { got.push(...l); } });
  assert.equal(got.length, 2);
  assert.equal(r.bad, 2);
});

test('files that are not Rudder tracks are refused', async () => {
  await assert.rejects(readTracksFile(new Blob(['{"type":"FeatureCollection"}\n'])), /not a Rudder tracks file/);
  await assert.rejects(readTracksFile(new Blob([''])), /not a Rudder tracks file/);
  await assert.rejects(readTracksFile(new Blob([JSON.stringify({ format: FORMAT, version: 99 })])), /newer Rudder/);
  await assert.rejects(readTracksFile(new Blob([new Uint8Array([0x1f, 0x8b, 1, 2, 3, 4])])), /damaged/);
});

test('export file names say when', () => {
  assert.equal(exportName(new Date(2026, 10, 25, 14, 5), true), 'rudder-tracks-2026-11-25-1405.ndjson.gz');
  assert.equal(exportName(new Date(2026, 10, 25, 14, 5), false), 'rudder-tracks-2026-11-25-1405.ndjson');
});
