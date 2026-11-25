import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toWorld } from '../public/bridgecables.js';

test('cables are placed in metres east, up and south of their origin', () => {
  const o = [9.69, 59.05];
  const [x, y, z] = toWorld([9.69 + 0.001, 59.05 + 0.001, 48], o);
  assert.ok(x > 55 && x < 58, `east ${x}`); // 0.001° of longitude at 59° N is about 57 m
  assert.equal(y, 48);
  assert.ok(z < -110 && z > -112, `north is negative z: ${z}`);
});
