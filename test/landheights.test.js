import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hillshadeBefore, HILLSHADE_ID, TRUE_SCALE } from '../public/landheights.js';
import { defaultSettings, mergeSettings } from '../public/layers.js';
import { EXAGGERATION } from '../public/terrain.js';

test('the hillshade goes over the background maps and under everything else', () => {
  const layers = [{ id: 'bg', type: 'background' }, { id: 'sjokart' }, { id: 'topo' }, { id: 'depth-areas' }, { id: 'ais-hull' }];
  assert.equal(hillshadeBefore(layers, ['sjokart', 'topo']), 'depth-areas');
  assert.equal(hillshadeBefore([{ id: 'bg', type: 'background' }, { id: HILLSHADE_ID }, { id: 'x' }], []), 'x');
  assert.equal(hillshadeBefore([{ id: 'sjokart' }], ['sjokart']), undefined, 'on top when nothing else');
});

test('heights are true from the bridge, taller than true on the chart', () => {
  assert.equal(TRUE_SCALE, 1);
  assert.ok(EXAGGERATION > 1);
});

test('the land heights switch is remembered, off by default', () => {
  assert.equal(defaultSettings().terrain, false);
  assert.equal(mergeSettings({ terrain: true }).terrain, true);
  assert.equal(mergeSettings({ terrain: 'yes' }).terrain, false);
});
