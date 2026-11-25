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

// ---------- switching on while tiles are still loading ----------

import { createLandHeights, SOURCE_ID } from '../public/landheights.js';
import { createInfra } from '../public/infralayer.js';
import { styleReady } from '../public/mapready.js';

/** A map whose style is read but whose tiles never all load: isStyleLoaded() stays false, no 'idle'. */
function busyMap({ loaded = true } = {}) {
  const handlers = {};
  const sources = {}, layers = [];
  let terrain = null;
  return {
    style: { _loaded: loaded },
    isStyleLoaded: () => false,
    on() {}, off() {},
    once(ev, f) { (handlers[ev] ??= []).push(f); },
    fire(ev) { for (const f of handlers[ev]?.splice(0) ?? []) f(); },
    getSource: (id) => sources[id],
    addSource: (id, s) => { sources[id] = { ...s, setData() {} }; },
    removeSource: (id) => { delete sources[id]; },
    getLayer: (id) => layers.find((l) => l.id === id),
    addLayer: (l) => { layers.push(l); },
    removeLayer: (id) => { layers.splice(layers.findIndex((l) => l.id === id), 1); },
    getStyle: () => ({ layers }),
    setTerrain: (t) => { terrain = t; },
    getTerrain: () => terrain,
    getZoom: () => 10,
    querySourceFeatures: () => [],
    get terrain() { return terrain; },
    handlers,
  };
}

test('land heights come on at once while tiles are still loading', () => {
  globalThis.maplibregl ??= { addProtocol() {} };
  const map = busyMap();
  createLandHeights(map, { basemapIds: [] }).setOn(true);
  assert.equal(map.terrain?.source, SOURCE_ID, 'not left waiting for an idle map');
  assert.equal(map.handlers.idle, undefined);
});

test('before the style is read, land heights and roads wait for it, then come on', () => {
  globalThis.maplibregl ??= { addProtocol() {} };
  const map = busyMap({ loaded: false });
  assert.equal(styleReady(map), false);
  createLandHeights(map, { basemapIds: [] }).setOn(true);
  createInfra(map).setOn(true);
  assert.equal(map.terrain, null);
  map.style._loaded = true;
  map.fire('style.load');
  assert.equal(map.terrain?.source, SOURCE_ID);
  assert.ok(map.getSource('infra'), 'roads and buildings added');
});
