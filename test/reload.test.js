import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tapCounter, reloadTargets } from '../public/reload.js';

test('four taps within 2.5 seconds trigger, then counting starts over', () => {
  const tap = tapCounter();
  assert.deepEqual([0, 300, 600].map(tap), [false, false, false]);
  assert.equal(tap(900), true);
  assert.equal(tap(1000), false, 'a fifth tap starts a new count');
});

test('slow taps do not add up', () => {
  const tap = tapCounter();
  assert.deepEqual([0, 1000, 2000, 3000].map(tap), [false, false, false, false], 'the first tap is too old by the fourth');
  assert.equal(tap(3500), true, 'taps at 1000-3500 are within the window');
});

test('only the page and its own files are fetched again, once each, without the fragment', () => {
  const urls = reloadTargets('https://joranlager.github.io/rudder/#at=10/59/5.5', [
    'https://joranlager.github.io/rudder/app.js',
    'https://joranlager.github.io/rudder/style.css',
    'https://joranlager.github.io/rudder/app.js',
    'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js',
    'https://cache.kartverket.no/v1/wmts/1.0.0/sjokartraster/default/webmercator/9/1/2.png',
    'icons/icon-180.png',
    'not a url ::',
  ]);
  assert.deepEqual(urls, [
    'https://joranlager.github.io/rudder/',
    'https://joranlager.github.io/rudder/app.js',
    'https://joranlager.github.io/rudder/style.css',
    'https://joranlager.github.io/rudder/icons/icon-180.png',
    'https://joranlager.github.io/rudder/not%20a%20url%20::',
  ]);
});
