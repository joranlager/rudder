import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roundScale, scaleBarMetres, modelsAtScale, MODEL_SCALE_M } from '../public/scalebar.js';
import { modelPlacement, modelKey, pickShips, MAX_MODELS } from '../public/shipmodels.js';

test('the scale bar rounds like MapLibre: 1, 2, 3, 5 or 10 times a power of ten', () => {
  assert.equal(roundScale(271), 200);
  assert.equal(roundScale(199.9), 100);
  assert.equal(roundScale(350), 300);
  assert.equal(roundScale(620), 500);
  assert.equal(roundScale(1800), 1000);
  assert.equal(roundScale(0.42), 0.4);
  assert.equal(roundScale(0), 0);
});

test('models appear from a 200 m scale bar and closer', () => {
  assert.equal(MODEL_SCALE_M, 200);
  assert.equal(modelsAtScale(200), true);
  assert.equal(modelsAtScale(100), true);
  assert.equal(modelsAtScale(300), false);
  assert.equal(modelsAtScale(0), false);
});

test('the scale is measured across the middle of the map, 120 px wide', () => {
  const calls = [];
  const map = {
    getContainer: () => ({ clientHeight: 600 }),
    unproject: ([x, y]) => { calls.push([x, y]); return { distanceTo: () => 250 }; },
  };
  assert.equal(scaleBarMetres(map), 200);
  assert.deepEqual(calls, [[0, 300], [120, 300]]);
});

const ship = (o = {}) => ({
  mmsi: 257000001, name: 'NORDLYS', shipType: 60, latitude: 59.0, longitude: 5.7, trueHeading: 90,
  dimensionA: 100, dimensionB: 20, dimensionC: 5, dimensionD: 15, draught: 55, msgtime: new Date().toISOString(), ...o,
});

test('the model is turned to the heading and put on the antenna', () => {
  const east = modelPlacement(ship());
  assert.equal(east.heading, 90);
  assert.ok(Math.abs(east.rotationY) < 1e-12, 'bow (+x) already points east');
  const north = modelPlacement(ship({ trueHeading: 0 }));
  assert.ok(Math.abs(north.rotationY - Math.PI / 2) < 1e-12);
  // Turning +x by rotationY about y (three.js) must point the bow north: x east, z south.
  const r = north.rotationY;
  assert.ok(Math.abs(Math.cos(r)) < 1e-12 && Math.abs(-Math.sin(r) - -1) < 1e-12, 'bow to -z, which is north');
  // 120 m long, antenna 100 m from the bow: 40 m aft of amidships; 20 m wide, 5 m from port: 5 m to port of the middle.
  assert.deepEqual(east.antenna, { x: -40, z: -5 });
});

test('no model without a heading or a size', () => {
  assert.equal(modelPlacement(ship({ trueHeading: 511, courseOverGround: 360 })), null);
  assert.equal(modelPlacement(ship({ dimensionA: 0, dimensionB: 0, shipLength: 0 })), null);
  assert.notEqual(modelPlacement(ship({ trueHeading: 511, courseOverGround: 45, speedOverGround: 8 })), null, 'course when moving');
});

test('a model is rebuilt for a new size or name, not for a move', () => {
  assert.equal(modelKey(ship()), modelKey(ship({ latitude: 59.1, trueHeading: 180 })));
  assert.notEqual(modelKey(ship()), modelKey(ship({ draught: 70 })));
  assert.notEqual(modelKey(ship()), modelKey(ship({ name: 'OTHER' })));
});

test('ships in view are picked nearest the middle first, up to the limit', () => {
  const near = ship({ mmsi: 1, longitude: 5.701 });
  const far = ship({ mmsi: 2, longitude: 5.75 });
  const outside = ship({ mmsi: 3, longitude: 6.5 });
  const unsized = ship({ mmsi: 4, dimensionA: 0, dimensionB: 0 });
  const box = [5.6, 58.9, 5.8, 59.1];
  assert.deepEqual(pickShips([far, outside, near, unsized], box, [5.7, 59.0]).map((v) => v.mmsi), [1, 2]);
  const many = Array.from({ length: MAX_MODELS + 5 }, (_, i) => ship({ mmsi: 100 + i, longitude: 5.7 + i * 1e-4 }));
  assert.equal(pickShips(many, box, [5.7, 59.0]).length, MAX_MODELS);
});

test('hull textures are made smaller for the chart, keeping their shape', async () => {
  const { mapTextureSize } = await import('../public/shipmodels.js');
  assert.deepEqual(mapTextureSize(4096, 690), [1024, 173]);
  assert.deepEqual(mapTextureSize(4096, 2060), [1024, 515]);
  assert.deepEqual(mapTextureSize(800, 200), [800, 200], 'small ones stay');
});

test('from a bridge, the ships around it are picked by distance, whatever the camera shows', async () => {
  const { boxAround, POV_RADIUS_M } = await import('../public/shipmodels.js');
  const [w, s, e, n] = boxAround(59.43, 10.53, 1000);
  assert.ok(Math.abs((n - s) * 111_320 - 2000) < 1);
  assert.ok(Math.abs((e - w) * 111_320 * Math.cos((59.43 * Math.PI) / 180) - 2000) < 1);
  const own = ship({ mmsi: 1, latitude: 59.43, longitude: 10.53 });
  const ahead = ship({ mmsi: 2, latitude: 59.4336, longitude: 10.53 });
  const far = ship({ mmsi: 3, latitude: 59.6, longitude: 10.53 });
  const picked = pickShips([far, ahead, own], boxAround(59.43, 10.53, POV_RADIUS_M), [10.53, 59.43]).map((v) => v.mmsi);
  assert.deepEqual(picked, [1, 2]);
});

test('ships float at their freeboard: the hull depth follows the beam and draught AIS reports', async () => {
  const { hullFromAis } = await import('../public/ais.js');
  const { depthFor } = await import('../public/ships/presets.js');
  const ferry = hullFromAis({ mmsi: 1, shipType: 60, dimensionA: 25, dimensionB: 25, dimensionC: 6, dimensionD: 6, draught: 30 }).params;
  assert.equal(ferry.beam, 12);
  assert.ok(ferry.depth - ferry.draft > 3, `a 50 m ferry 12 m wide shows ${ (ferry.depth - ferry.draft).toFixed(1) } m of hull`);
  const loaded = depthFor('tanker', 20, 6.5), ballast = depthFor('tanker', 20, 3.5);
  assert.equal(loaded, ballast, 'the hull is the same, loaded or not');
  assert.ok(ballast - 3.5 > loaded - 6.5, 'in ballast it floats higher');
  assert.ok(depthFor('tug', 10, 9) >= 10, 'always at least a metre above the waterline');
});
