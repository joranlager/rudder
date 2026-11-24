import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderForSpeed, rudderRate } from '../public/helm.js';
import { handlingFor } from '../public/shiphandling.js';
import { mergeVessels } from '../public/ais.js';

const KNOT = 1852 / 3600;
const ferry = { mmsi: 1, shipType: 60, dimensionA: 70, dimensionB: 69, dimensionC: 10, dimensionD: 11, draught: 55 };

test('taking the helm keeps the engine doing what it was doing', () => {
  const h = handlingFor(ferry);
  assert.equal(orderForSpeed(0, h), 0, 'lying still: stop');
  assert.equal(orderForSpeed(h.aheadMs, h), 4, 'at service speed: full ahead');
  assert.equal(orderForSpeed(h.aheadMs * 0.42, h), 2, 'about 40 %: slow ahead');
  assert.equal(orderForSpeed(-h.asternMs, h), -4, 'going astern');
  assert.equal(orderForSpeed(30 * KNOT, h), 4, 'faster than it can: full ahead');
});

test('the rudder turns at a believable speed', () => {
  assert.ok((2 * 35) / rudderRate(139) <= 30, 'hard over to hard over within about 28 s');
  assert.ok(rudderRate(20) > rudderRate(139), 'small ships are quicker');
});

test('a simulated report gives way to the first real one, however old', () => {
  const m = new Map([[1, { mmsi: 1, latitude: 60, longitude: 5, msgtime: '2026-11-24T13:00:00Z', simulated: true }]]);
  mergeVessels(m, [{ mmsi: 1, latitude: 59, longitude: 5, msgtime: '2026-11-24T12:00:00Z' }]);
  assert.equal(m.get(1).latitude, 59);
  assert.equal(m.get(1).simulated, false);
  mergeVessels(m, [{ mmsi: 1, latitude: 58, longitude: 5, msgtime: '2026-11-24T11:00:00Z' }]);
  assert.equal(m.get(1).latitude, 59, 'real reports still keep the newest');
});
