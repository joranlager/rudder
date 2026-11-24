import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEM_SERVICE, DEM_COVERAGE, DEM_SIZE, DEM_MIN_ZOOM, DEM_MAX_ZOOM, EXAGGERATION, TILT,
  tileBounds, parseTileUrl, demUrl, parseGeoTiff, cleanHeights, resampleToMercator,
  encodeTerrarium, decodeTerrarium, flatHeights,
} from '../public/terrain.js';

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// ---- a small TIFF writer, shaped like the service's files (and a few variants) ----
// Everything is laid out first (pixel blocks, then arrays too long for an entry, then the directory),
// so every offset is known before a byte is written.
function buildTiff({ width, height, data, tile = null, rowsPerStrip = null, little = true, compression = 1, bits = 32, format = 3 }) {
  // 1. the pixel blocks: tiles (padded at the right and bottom edge) or strips of rows
  const blocks = [];
  if (tile) {
    for (let ty = 0; ty < Math.ceil(height / tile); ty++) for (let tx = 0; tx < Math.ceil(width / tile); tx++) {
      const block = new Float32Array(tile * tile);
      for (let r = 0; r < tile; r++) for (let c = 0; c < tile; c++) {
        const y = ty * tile + r, x = tx * tile + c;
        block[r * tile + c] = y < height && x < width ? data[y * width + x] : 0;
      }
      blocks.push(block);
    }
  } else {
    const rps = rowsPerStrip ?? height;
    for (let y0 = 0; y0 < height; y0 += rps) blocks.push(data.slice(y0 * width, Math.min(height, y0 + rps) * width));
  }
  let cursor = 8;
  const blockOffsets = blocks.map((b) => { const at = cursor; cursor += b.length * 4; return at; });
  const blockCounts = blocks.map((b) => b.length * 4);

  // 2. the directory entries; a value list that does not fit in 4 bytes is stored after the pixels
  const list = [[256, 3, [width]], [257, 3, [height]], [258, 3, [bits]], [259, 3, [compression]], [262, 3, [1]], [277, 3, [1]], [339, 3, [format]]];
  if (tile) list.push([322, 3, [tile]], [323, 3, [tile]], [324, 4, blockOffsets], [325, 4, blockCounts]);
  else list.push([273, 4, blockOffsets], [278, 3, [rowsPerStrip ?? height]], [279, 4, blockCounts]);
  list.sort((x, y) => x[0] - y[0]);
  const entries = list.map(([tag, type, values]) => {
    const bytes = values.length * (type === 3 ? 2 : 4);
    if (bytes <= 4) return { tag, type, values, at: null };
    const at = cursor; cursor += bytes;
    return { tag, type, values, at };
  });
  const ifdAt = cursor;
  cursor += 2 + entries.length * 12 + 4;

  // 3. write it all
  const buf = new ArrayBuffer(cursor);
  const dv = new DataView(buf);
  const put = (type, at, v) => (type === 3 ? dv.setUint16(at, v, little) : dv.setUint32(at, v, little));
  dv.setUint16(0, little ? 0x4949 : 0x4d4d, false);
  dv.setUint16(2, 42, little);
  dv.setUint32(4, ifdAt, little);
  blocks.forEach((block, i) => block.forEach((v, k) => dv.setFloat32(blockOffsets[i] + 4 * k, v, little)));
  dv.setUint16(ifdAt, entries.length, little);
  entries.forEach(({ tag, type, values, at }, i) => {
    const e = ifdAt + 2 + i * 12;
    dv.setUint16(e, tag, little); dv.setUint16(e + 2, type, little); dv.setUint32(e + 4, values.length, little);
    const size = type === 3 ? 2 : 4;
    if (at === null) values.forEach((v, k) => put(type, e + 8 + size * k, v));
    else { dv.setUint32(e + 8, at, little); values.forEach((v, k) => put(type, at + size * k, v)); }
  });
  return buf;
}
const pattern = (w, h) => Float32Array.from({ length: w * h }, (_, i) => Math.floor(i / w) * 1000 + (i % w));

test('it asks the elevation service that was checked, for tiles of 128 pixels', () => {
  assert.equal(DEM_SERVICE, 'https://wcs.geonorge.no/skwms1/wcs.hoyde-dtm-nhm-25833');
  assert.equal(DEM_COVERAGE, 'nhm_dtm_topo_25833');
  assert.equal(DEM_SIZE, 128);
  assert.ok(DEM_MIN_ZOOM >= 6 && DEM_MAX_ZOOM <= 15 && DEM_MIN_ZOOM < DEM_MAX_ZOOM);
  assert.ok(EXAGGERATION >= 1 && EXAGGERATION <= 3);
  assert.ok(TILT >= 30 && TILT <= 75);
});

test('tile bounds follow the Web Mercator tiling', () => {
  const world = tileBounds(0, 0, 0);
  assert.ok(close(world.west, -180) && close(world.east, 180));
  assert.ok(close(world.north, 85.0511287798, 1e-6) && close(world.south, -85.0511287798, 1e-6));
  const nw = tileBounds(1, 0, 0);
  assert.ok(close(nw.west, -180) && close(nw.east, 0) && close(nw.south, 0, 1e-9));
  const jotun = tileBounds(11, 1071, 576); // checked against the service while building this
  assert.ok(close(jotun.west, 8.2617, 1e-3) && close(jotun.east, 8.4375, 1e-3) && close(jotun.south, 61.5227, 1e-3) && close(jotun.north, 61.6064, 1e-3), JSON.stringify(jotun));
});

test('tile addresses are parsed strictly', () => {
  assert.deepEqual(parseTileUrl('kvdem://11/1071/576'), { z: 11, x: 1071, y: 576 });
  assert.deepEqual(parseTileUrl('kvdem://0/0/0'), { z: 0, x: 0, y: 0 });
  for (const bad of ['kvdem://11/1071', 'kvdem://11/1071/576/1', 'https://11/1/1', 'kvdem://a/b/c', 'kvdem://3/9/0', 'kvdem://3/0/8', 'kvdem://-1/0/0', '', null]) {
    assert.equal(parseTileUrl(bad), null, String(bad));
  }
});

test('the GetCoverage request carries what the service expects', () => {
  const u = new URL(demUrl({ west: 8.2617, south: 61.5227, east: 8.4375, north: 61.6064 }));
  assert.equal(`${u.origin}${u.pathname}`, DEM_SERVICE);
  const p = u.searchParams;
  assert.deepEqual([p.get('SERVICE'), p.get('VERSION'), p.get('REQUEST')], ['WCS', '1.0.0', 'GetCoverage']);
  assert.equal(p.get('COVERAGE'), 'nhm_dtm_topo_25833');
  assert.equal(p.get('CRS'), 'EPSG:4326');
  assert.equal(p.get('FORMAT'), 'GeoTIFF');
  assert.equal(p.get('WIDTH'), '128');
  assert.equal(p.get('HEIGHT'), '128');
  assert.deepEqual(p.get('BBOX').split(',').map(Number), [8.2617, 61.5227, 8.4375, 61.6064]); // west, south, east, north
});

test('a tiled GeoTIFF, as the service sends it, is read correctly', () => {
  const data = pattern(128, 128);
  const t = parseGeoTiff(buildTiff({ width: 128, height: 128, data, tile: 128 }));
  assert.equal(t.width, 128); assert.equal(t.height, 128);
  assert.deepEqual([t.data[0], t.data[127], t.data[128], t.data[127 * 128 + 5]], [0, 127, 1000, 127005]);
});

test('several tiles, with the edge padded, land in the right place', () => {
  const data = pattern(200, 150); // 2 x 2 blocks of 128, the last ones partly padding
  const t = parseGeoTiff(buildTiff({ width: 200, height: 150, data, tile: 128 }));
  assert.equal(t.data.length, 200 * 150);
  assert.deepEqual(Array.from(t.data), Array.from(data));
});

test('striped files and big-endian files are read too', () => {
  const data = pattern(37, 23);
  for (const little of [true, false]) {
    for (const rowsPerStrip of [null, 5, 1]) {
      const t = parseGeoTiff(buildTiff({ width: 37, height: 23, data, rowsPerStrip, little }));
      assert.deepEqual(Array.from(t.data), Array.from(data), `little=${little} rps=${rowsPerStrip}`);
    }
  }
});

test('anything unexpected is refused, not turned into garbage heights', () => {
  const ok = buildTiff({ width: 8, height: 8, data: pattern(8, 8), tile: 8 });
  assert.doesNotThrow(() => parseGeoTiff(ok));
  assert.throws(() => parseGeoTiff(buildTiff({ width: 8, height: 8, data: pattern(8, 8), tile: 8, compression: 5 })), /compressed/);
  assert.throws(() => parseGeoTiff(buildTiff({ width: 8, height: 8, data: new Float32Array(64), tile: 8, bits: 16 })), /32-bit float/);
  assert.throws(() => parseGeoTiff(buildTiff({ width: 8, height: 8, data: new Float32Array(64), tile: 8, format: 1 })), /32-bit float/);
  assert.throws(() => parseGeoTiff(new TextEncoder().encode('<?xml version="1.0"?><ServiceExceptionReport/>').buffer), /not a TIFF/);
  assert.throws(() => parseGeoTiff(new ArrayBuffer(4)), /too short/);
  assert.throws(() => parseGeoTiff(ok.slice(0, 40)), /broken|short/);
  assert.throws(() => parseGeoTiff(null));
});

test('heights that cannot be real become sea level', () => {
  const out = cleanHeights(Float32Array.from([1137.5, -3.4e38, NaN, Infinity, -Infinity, 0, -999, -1000, 9500, 2469]));
  assert.deepEqual(Array.from(out), [1137.5, 0, 0, 0, 0, 0, -999, 0, 0, 2469]);
});

test('rows are resampled to where they really are on the Web Mercator map', () => {
  const b = tileBounds(11, 1071, 576);
  // a surface that rises with latitude: value = latitude * 1000
  const h = 128, w = 128;
  const lat = Float32Array.from({ length: w * h }, (_, i) => (b.north - ((Math.floor(i / w) + 0.5) / h) * (b.north - b.south)) * 1000);
  const out = resampleToMercator({ width: w, height: h, data: lat }, b, 128);
  const R = 6378137, yOf = (la) => Math.log(Math.tan(Math.PI / 4 + (la * Math.PI) / 360)) * R;
  for (const j of [0, 31, 64, 100, 127]) {
    const y = yOf(b.north) - ((j + 0.5) / 128) * (yOf(b.north) - yOf(b.south));
    const expected = ((2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180) / Math.PI * 1000;
    assert.ok(Math.abs(out[j * 128 + 7] - expected) < 0.05, `row ${j}: ${out[j * 128 + 7]} vs ${expected}`);
  }
  // north is the top: the first row is higher than the last
  assert.ok(out[0] > out[127 * 128]);
});

test('resampling keeps flat ground flat, columns in place, and works for another size', () => {
  const b = tileBounds(10, 500, 300);
  const flat = resampleToMercator({ width: 128, height: 128, data: new Float32Array(128 * 128).fill(742.5) }, b, 128);
  assert.ok(Array.from(flat).every((v) => close(v, 742.5, 1e-3)));
  const cols = Float32Array.from({ length: 128 * 128 }, (_, i) => (i % 128) * 10); // rises to the east
  const out = resampleToMercator({ width: 128, height: 128, data: cols }, b, 128);
  assert.ok(out[0] < out[64] && out[64] < out[127]);
  assert.ok(close(out[5], 50, 1e-3) && close(out[127 * 128 + 5], 50, 1e-3));
  const small = resampleToMercator({ width: 128, height: 128, data: cols }, b, 64);
  assert.equal(small.length, 64 * 64);
  assert.ok(small[0] < small[63]);
});

test('heights round-trip through the Terrarium picture to 1/256 m', () => {
  const heights = Float32Array.from([-100.5, 0, 1137.25, 2469.9, 8000, -1, 12.5]);
  const rgba = encodeTerrarium(Float32Array.from([...heights, ...new Float32Array(42)]), 7); // 7 x 7 pixels
  heights.forEach((h, i) => {
    const back = decodeTerrarium(rgba[4 * i], rgba[4 * i + 1], rgba[4 * i + 2]);
    assert.ok(Math.abs(back - h) <= 1 / 256 + 1e-6, `${h} -> ${back}`);
    assert.equal(rgba[4 * i + 3], 255);
  });
});

test('sea level encodes as the Terrarium zero, and out-of-range values are held in range', () => {
  const rgba = encodeTerrarium(flatHeights(4), 4);
  assert.deepEqual(Array.from(rgba.slice(0, 4)), [128, 0, 0, 255]);
  const extreme = encodeTerrarium(Float32Array.from([1e9, -1e9, NaN, 0]), 2);
  assert.ok(decodeTerrarium(extreme[0], extreme[1], extreme[2]) > 32000);
  assert.ok(decodeTerrarium(extreme[4], extreme[5], extreme[6]) <= -32767);
  assert.equal(flatHeights().length, 128 * 128);
});
