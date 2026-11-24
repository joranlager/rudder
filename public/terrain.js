// 3D terrain from Kartverket's terrain model (hoydedata.no). Pure, so it is unit tested.
//
// MapLibre draws 3D terrain from "raster-dem" tiles: pictures whose colours encode heights. No
// public service offers such tiles for the Norwegian terrain model, but Kartverket's WCS serves the
// heights themselves, so a tile is made on the fly:
//
//   1. ask the WCS for the elevation of the tile's area (a 128 x 128 GeoTIFF of 32-bit floats)
//   2. decode the GeoTIFF                                       (parseGeoTiff)
//   3. resample its rows from latitude to Web Mercator rows     (resampleToMercator)
//   4. write the heights as a "Terrarium" picture               (encodeTerrarium)
//
// Service (read from its capabilities, and checked with real requests): the WCS at
// https://wcs.geonorge.no/skwms1/wcs.hoyde-dtm-nhm-25833, coverage nhm_dtm_topo_25833, a 1 m terrain
// model (Float32 metres), output as GeoTIFF in EPSG:4326, CORS open. The file is uncompressed and
// tiled in 128 x 128 blocks, so a 128 x 128 request is exactly one block (about 66 KB).
// Shaded from this data, the terrain matched Kartverket's own hillshade picture of the same tile
// with a correlation of 0.93, so the orientation and the heights are read correctly.

export const DEM_SERVICE = 'https://wcs.geonorge.no/skwms1/wcs.hoyde-dtm-nhm-25833';
export const DEM_COVERAGE = 'nhm_dtm_topo_25833';
export const DEM_SIZE = 128;      // pixels per side of a height tile
export const DEM_MIN_ZOOM = 8;    // below this one tile spans too much; the terrain is flat
export const DEM_MAX_ZOOM = 13;   // the best detail asked for (about 18 m per pixel); beyond it tiles are enlarged
export const EXAGGERATION = 1.5;  // heights are drawn a little taller than true, as is usual for a map
export const TILT = 60;           // degrees the camera is tilted when the terrain is switched on
export const PROTOCOL = 'kvdem';

const R = 6378137;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const latToY = (lat) => Math.log(Math.tan(Math.PI / 4 + (clamp(lat, -85.0511, 85.0511) * Math.PI) / 360)) * R;
const yToLat = (y) => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI);

/** The area of a Web Mercator tile as { west, south, east, north } in degrees. */
export function tileBounds(z, x, y) {
  const n = 2 ** z;
  const lat = (t) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * t) / n))) * 180) / Math.PI;
  return { west: (x / n) * 360 - 180, east: ((x + 1) / n) * 360 - 180, north: lat(y), south: lat(y + 1) };
}

/** 'kvdem://11/1071/576' -> { z: 11, x: 1071, y: 576 }, or null if it is not a tile address. */
export function parseTileUrl(url) {
  const m = /^kvdem:\/\/(\d+)\/(\d+)\/(\d+)$/.exec(String(url));
  if (!m) return null;
  const [z, x, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const n = 2 ** z;
  return z <= 24 && x < n && y < n ? { z, x, y } : null;
}

/** The WCS 1.0.0 GetCoverage request for an area: one GeoTIFF of heights, size x size pixels. */
export function demUrl(b, size = DEM_SIZE) {
  const box = [b.west, b.south, b.east, b.north].map((v) => v.toFixed(7)).join(',');
  return `${DEM_SERVICE}?SERVICE=WCS&VERSION=1.0.0&REQUEST=GetCoverage&COVERAGE=${DEM_COVERAGE}&CRS=EPSG:4326&FORMAT=GeoTIFF&BBOX=${box}&WIDTH=${size}&HEIGHT=${size}`;
}

// ---------- GeoTIFF ----------

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8 };

/**
 * Reads a single-band, uncompressed, 32-bit float GeoTIFF, striped or tiled, either byte order.
 * Anything else throws, so a surprise from the service is a clear error instead of garbage heights.
 * Returns { width, height, data } with the rows running north to south, as in the file.
 */
export function parseGeoTiff(buffer) {
  if (!buffer || buffer.byteLength < 16) throw new Error('not a TIFF (too short)');
  const dv = new DataView(buffer);
  const order = dv.getUint16(0, false);
  if (order !== 0x4949 && order !== 0x4d4d) throw new Error('not a TIFF');
  const little = order === 0x4949;
  if (dv.getUint16(2, little) !== 42) throw new Error('not a TIFF');
  const ifd = dv.getUint32(4, little);
  if (ifd + 2 > buffer.byteLength) throw new Error('broken TIFF');
  const count = dv.getUint16(ifd, little);
  const tags = {};
  for (let i = 0; i < count; i++) {
    const at = ifd + 2 + i * 12;
    if (at + 12 > buffer.byteLength) throw new Error('broken TIFF');
    const tag = dv.getUint16(at, little);
    const type = dv.getUint16(at + 2, little);
    const n = dv.getUint32(at + 4, little);
    if (type !== 3 && type !== 4) continue; // only numbers that are whole are needed
    const bytes = TYPE_SIZE[type] * n;
    const start = bytes <= 4 ? at + 8 : dv.getUint32(at + 8, little);
    if (start + bytes > buffer.byteLength) throw new Error('broken TIFF');
    const values = [];
    for (let k = 0; k < n; k++) values.push(type === 3 ? dv.getUint16(start + 2 * k, little) : dv.getUint32(start + 4 * k, little));
    tags[tag] = values;
  }
  const one = (tag, fallback) => (tags[tag] ? tags[tag][0] : fallback);
  const width = one(256);
  const height = one(257);
  if (!width || !height || width * height > 4096 * 4096) throw new Error('unsupported TIFF size');
  if (one(258) !== 32 || one(339, 1) !== 3 || one(277, 1) !== 1) throw new Error('not 32-bit float, one band');
  if (one(259, 1) !== 1) throw new Error('compressed TIFF is not supported');

  const data = new Float32Array(width * height);
  const read = (offset, from, n) => { for (let k = 0; k < n; k++) data[from + k] = dv.getFloat32(offset + 4 * k, little); };
  if (tags[324]) { // tiled
    const tw = one(322);
    const th = one(323);
    const across = Math.ceil(width / tw);
    const offsets = tags[324];
    for (let t = 0; t < offsets.length; t++) {
      const x0 = (t % across) * tw;
      const y0 = Math.floor(t / across) * th;
      for (let r = 0; r < th && y0 + r < height; r++) {
        const n = Math.min(tw, width - x0);
        const src = offsets[t] + r * tw * 4;
        if (src + n * 4 > buffer.byteLength) throw new Error('broken TIFF');
        read(src, (y0 + r) * width + x0, n);
      }
    }
  } else if (tags[273]) { // striped
    const rps = one(278, height);
    tags[273].forEach((offset, s) => {
      const rows = Math.min(rps, height - s * rps);
      if (rows <= 0) return;
      if (offset + rows * width * 4 > buffer.byteLength) throw new Error('broken TIFF');
      read(offset, s * rps * width, rows * width);
    });
  } else {
    throw new Error('TIFF has no image data');
  }
  return { width, height, data };
}

// ---------- heights ----------

/** Heights that cannot be real (no data, errors) become sea level, so the terrain is flat there. */
export function cleanHeights(data) {
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    out[i] = Number.isFinite(v) && v > -1000 && v < 9000 ? v : 0;
  }
  return out;
}

/**
 * The service answers for a box that is even in latitude; a map tile is even in Web Mercator. For a
 * tile at zoom 8 or more that differs by a fraction of a pixel, but it is done properly: each
 * output row is taken at the latitude it really has, interpolating between the two nearest rows.
 * Columns are even in longitude in both, so they only need scaling. Returns size x size heights.
 */
export function resampleToMercator(src, b, size) {
  const out = new Float32Array(size * size);
  const yN = latToY(b.north);
  const yS = latToY(b.south);
  const at = (row, col) => src.data[row * src.width + col];
  for (let j = 0; j < size; j++) {
    const lat = yToLat(yN - ((j + 0.5) / size) * (yN - yS));
    const fy = clamp(((b.north - lat) / (b.north - b.south)) * src.height - 0.5, 0, src.height - 1);
    const r0 = Math.min(src.height - 2, Math.floor(fy));
    const ty = src.height > 1 ? fy - Math.max(0, r0) : 0;
    const ra = Math.max(0, r0);
    const rb = Math.min(src.height - 1, ra + 1);
    for (let i = 0; i < size; i++) {
      const fx = clamp(((i + 0.5) / size) * src.width - 0.5, 0, src.width - 1);
      const c0 = Math.min(src.width - 2, Math.floor(fx));
      const ca = Math.max(0, c0);
      const cb = Math.min(src.width - 1, ca + 1);
      const tx = src.width > 1 ? fx - ca : 0;
      const top = at(ra, ca) * (1 - tx) + at(ra, cb) * tx;
      const bottom = at(rb, ca) * (1 - tx) + at(rb, cb) * tx;
      out[j * size + i] = top * (1 - ty) + bottom * ty;
    }
  }
  return out;
}

// ---------- Terrarium ----------
// height = (R * 256 + G + B / 256) - 32768 : metres, to 1/256 m, from about -32 km to +32 km.

export function encodeTerrarium(heights, size) {
  const out = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const v = clamp(heights[i], -32768, 32767.99) + 32768;
    const whole = Math.floor(v);
    out[4 * i] = Math.floor(whole / 256);
    out[4 * i + 1] = whole % 256;
    out[4 * i + 2] = Math.floor((v - whole) * 256);
    out[4 * i + 3] = 255;
  }
  return out;
}

export const decodeTerrarium = (r, g, b) => r * 256 + g + b / 256 - 32768;

/** Sea level everywhere: the tile for an area the service does not cover, or when it cannot be reached. */
export const flatHeights = (size = DEM_SIZE) => new Float32Array(size * size);
