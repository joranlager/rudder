import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASEMAPS, OVERLAYS, buildStyle, defaultSettings, mergeSettings, wmsTileUrl, wmtsUrl } from '../public/layers.js';

test('WMTS tiles use the web mercator matrix of the Kartverket cache', () => {
  assert.equal(wmtsUrl('sjokartraster'), 'https://cache.kartverket.no/v1/wmts/1.0.0/sjokartraster/default/webmercator/{z}/{y}/{x}.png');
});

test('WMS tile URLs keep the bbox placeholder unescaped', () => {
  const u = wmsTileUrl('https://example.org/wms', ['A', 'B'], { size: 512 });
  assert.ok(u.endsWith('&bbox={bbox-epsg-3857}'));
  const p = new URL(u.replace('{bbox-epsg-3857}', '0,0,1,1')).searchParams;
  assert.equal(p.get('layers'), 'A,B');
  assert.equal(p.get('srs'), 'EPSG:3857');
  assert.equal(p.get('width'), '512');
  assert.equal(p.get('transparent'), 'true');
});

test('style has one layer per background and overlay, only the chosen background visible', () => {
  const s = buildStyle(defaultSettings());
  assert.equal(s.layers.length, 1 + BASEMAPS.length + OVERLAYS.length);
  const visible = s.layers.filter((l) => BASEMAPS.some((b) => b.id === l.id) && l.layout.visibility === 'visible');
  assert.deepEqual(visible.map((l) => l.id), ['sjokart']);
  for (const o of OVERLAYS) assert.ok(s.sources[o.id].attribution, `${o.id} credits its source`);
});

test('stored settings are merged safely', () => {
  const s = mergeSettings({ basemap: 'nope', overlays: { 'depth-areas': { on: true, opacity: 7 }, ghost: { on: true } } });
  assert.equal(s.basemap, 'sjokart');
  assert.equal(s.overlays['depth-areas'].on, true);
  assert.equal(s.overlays['depth-areas'].opacity, 1);
  assert.equal(s.overlays.ghost, undefined);
  assert.deepEqual(mergeSettings('garbage'), defaultSettings());
});
