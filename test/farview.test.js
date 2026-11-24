import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extendFar, boxAround, landMesh, landColor, RADIUS_M, LAND_M } from '../public/farview.js';

// Column-major 4x4 helpers, as gl-matrix and MapLibre use.
const mul = (a, b) => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
const perspective = (fov, aspect, n, f) => {
  const t = 1 / Math.tan(fov / 2), o = new Array(16).fill(0);
  o[0] = t / aspect; o[5] = t; o[10] = (f + n) / (n - f); o[11] = -1; o[14] = (2 * f * n) / (n - f);
  return o;
};
const apply = (m, [x, y, z]) => [0, 1, 2, 3].map((r) => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r]);
// Some camera: a rotation, a scale and a translation, like MapLibre's view part.
const X = (() => {
  const a = 1.2, c = Math.cos(a), s = Math.sin(a);
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, -3, 5, -400, 1].map((v, i) => (i % 5 === 0 && i < 15 ? v * 1.5 : v));
})();

test('the far plane is moved out, and nothing else about the camera changes', () => {
  const n = 15, f = 2000, f2 = 60000, fov = 0.6435, aspect = 4 / 3;
  const M = mul(perspective(fov, aspect, n, f), X);
  const expected = mul(perspective(fov, aspect, n, f2), X);
  const got = extendFar(M, n, f, f2);
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(got[i] - expected[i]) < 1e-6 * Math.max(1, Math.abs(expected[i])), `element ${i}: ${got[i]} vs ${expected[i]}`);
  // A point on screen stays where it was; only its depth changes.
  const p = [10, -20, 30];
  const [x1, y1, , w1] = apply(M, p), [x2, y2, , w2] = apply(got, p);
  assert.ok(Math.abs(x1 / w1 - x2 / w2) < 1e-9 && Math.abs(y1 / w1 - y2 / w2) < 1e-9);
  assert.deepEqual(extendFar(M, n, f, f).map((v) => +v.toFixed(9)), M.map((v) => +v.toFixed(9)), 'same far: same matrix');
});

test('the box around the ship is 2 x 20 km', () => {
  const b = boxAround(59, 6);
  const R = 6371008.8, rad = (d) => (d * Math.PI) / 180;
  assert.ok(Math.abs(rad(b.north - b.south) * R - 2 * RADIUS_M) < 1);
  assert.ok(Math.abs(rad(b.east - b.west) * R * Math.cos(rad(59)) - 2 * RADIUS_M) < 1);
});

test('the land mesh keeps only cells with land, placed east, up and south of the middle', () => {
  // 3 x 3 grid, north row first: a 100 m hill in the north-east corner, sea elsewhere.
  const heights = new Float32Array([0, 0, 100, 0, 0, 0, 0, 0, 0]);
  const box = { west: 5.99, east: 6.01, south: 58.99, north: 59.01 };
  const m = landMesh(heights, 3, 3, box);
  assert.equal(m.index.length, 6, 'one cell (two triangles) touches the hill');
  const hill = 2;
  assert.ok(m.positions[3 * hill] > 0, 'east of the middle');
  assert.equal(m.positions[3 * hill + 1], 100, 'up');
  assert.ok(m.positions[3 * hill + 2] < 0, 'north is -z');
  assert.equal(m.positions[3 * 4], 0, 'the middle sample is at the middle');
  const allSea = landMesh(new Float32Array(9).fill(LAND_M / 2), 3, 3, box);
  assert.equal(allSea.index.length, 0);
});

test('land colours go from green to rock to snow', () => {
  const [r0, g0] = landColor(0), [, , b1] = landColor(1500);
  assert.ok(g0 > r0, 'green low down');
  assert.ok(b1 > 0.9, 'white on the tops');
});
