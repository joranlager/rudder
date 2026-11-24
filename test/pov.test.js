import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eyeHeight, ahead, bridgeCamera, bridgeLine, LOOK_PITCH, LOOKS } from '../public/pov.js';

const R = 6371008.8;
const ferry = (o = {}) => ({ mmsi: 1, shipType: 60, dimensionA: 70, dimensionB: 69, dimensionC: 10, dimensionD: 11, draught: 55, ...o });

test('the eye is on the bridge: higher on bigger ships, never on the water', () => {
  const big = eyeHeight(ferry());
  const small = eyeHeight(ferry({ dimensionA: 20, dimensionB: 20, dimensionC: 5, dimensionD: 5, draught: 30 }));
  assert.ok(big > small, `${big} > ${small}`);
  assert.ok(big > 10 && big < 30, `a 139 m ferry's bridge is ${big} m up`);
  assert.ok(small >= 2.5 && small < 10, `a 40 m ferry's bridge is ${small} m up`);
  const tug = eyeHeight({ mmsi: 2, shipType: 52, dimensionA: 10, dimensionB: 5, dimensionC: 3, dimensionD: 3 });
  assert.ok(tug >= 2.5);
});

test('moving a point ahead along a bearing', () => {
  const [lon, lat] = ahead([5.7, 59], 0, 1000);
  assert.equal(lon, 5.7);
  assert.ok(Math.abs(((lat - 59) * Math.PI / 180) * R - 1000) < 1e-6);
  const [lon2, lat2] = ahead([5.7, 59], 90, 1000);
  assert.equal(lat2, 59);
  assert.ok(Math.abs(((lon2 - 5.7) * Math.PI / 180) * R * Math.cos(59 * Math.PI / 180) - 1000) < 1e-6);
});

test('the camera looks along the heading, pitched so the horizon is in view', () => {
  const cam = bridgeCamera({ lat: 59, lon: 5.7 }, 45, 20);
  assert.deepEqual(cam.from, [5.7, 59]);
  assert.equal(cam.bearing, 45);
  const north = ((cam.to[1] - 59) * Math.PI / 180) * R;
  const east = ((cam.to[0] - 5.7) * Math.PI / 180) * R * Math.cos(59 * Math.PI / 180);
  assert.ok(Math.abs(Math.atan2(east, north) * 180 / Math.PI - 45) < 0.01);
  const dist = Math.hypot(north, east);
  assert.ok(Math.abs(Math.atan(dist / 20) * 180 / Math.PI - LOOK_PITCH) < 0.01, 'pitch from the eye height and distance');
});

test('looking to port, starboard and astern turns from the heading', () => {
  assert.equal(bridgeCamera({ lat: 59, lon: 5.7 }, 10, 20, LOOKS.port).bearing, 280);
  assert.equal(bridgeCamera({ lat: 59, lon: 5.7 }, 10, 20, LOOKS.starboard).bearing, 100);
  assert.equal(bridgeCamera({ lat: 59, lon: 5.7 }, 350, 20, LOOKS.astern).bearing, 170);
});

test('the bridge bar line', () => {
  assert.equal(bridgeLine({ speedOverGround: 12.34 }, 5.6), '12.3 kn · heading 006°');
  assert.equal(bridgeLine({ speedOverGround: 102.3 }, null), '');
  assert.equal(bridgeLine({}, 359.7), 'heading 000°');
});

test('from its own bridge a ship shows its hull, deck and cargo, not the deckhouse around the eye', async () => {
  const { hiddenFromBridge } = await import('../public/shipmodels.js');
  for (const n of ['deckhouse', 'windows', 'wheelhouse', 'funnel', 'mast', 'radar', '', undefined]) assert.equal(hiddenFromBridge(n), true, n);
  for (const n of ['hull', 'deck', 'bulbous_bow', 'transom', 'containers', 'hatch_cover', 'crane']) assert.equal(hiddenFromBridge(n), false, n);
});

test('dragging looks around and up or down, within limits; the wheel zooms within limits', async () => {
  const { dragLook, zoomFov, PITCH_RANGE, FOV_RANGE } = await import('../public/pov.js');
  const right = dragLook({ look: 0, pitch: 82 }, 100, 0);
  assert.equal(right.look, 20, 'drag right turns the view to the right');
  assert.equal(dragLook({ look: 170, pitch: 82 }, 100, 0).look, -170, 'all the way round');
  assert.ok(dragLook({ look: 0, pitch: 82 }, 0, 100).pitch < 82, 'drag down looks down');
  assert.equal(dragLook({ look: 0, pitch: 82 }, 0, -1000).pitch, PITCH_RANGE[1]);
  assert.equal(dragLook({ look: 0, pitch: 82 }, 0, 10000).pitch, PITCH_RANGE[0]);
  assert.ok(zoomFov(36.87, 2) < 20);
  assert.equal(zoomFov(36.87, 100), FOV_RANGE[0]);
  assert.equal(zoomFov(36.87, 0.01), FOV_RANGE[1]);
});
