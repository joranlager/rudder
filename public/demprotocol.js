// The "kvdem://z/x/y" tile source for MapLibre's 3D terrain: each height tile is made on demand from
// Kartverket's elevation service (see terrain.js for the steps and what was checked).
//
//  - at most a few requests at a time, so panning does not flood the service
//  - tiles already made are kept (and shared if two requests ask at once)
//  - an area the service does not cover, or an answer that is not a height file, becomes a flat tile
//    (kept, since it will not change)
//  - a real failure (no network, a server error) is retried once and then reported as an error. The
//    map then treats the tile as missing and asks again when it is next needed. (A flat tile returned
//    instead would be kept by the map itself, and a moment's trouble would flatten the ground for good.)
//  - MapLibre may hand the data it receives to another thread, so every caller gets its own copy

import {
  PROTOCOL, DEM_SIZE, parseTileUrl, tileBounds, demUrl, parseGeoTiff, cleanHeights,
  resampleToMercator, encodeTerrarium, flatHeights,
} from './terrain.js';

const MAX_PARALLEL = 4;
const CACHE_MAX = 160;       // tiles of about 64 KB: roughly 10 MB at most
const TIMEOUT_MS = 20_000;
const RETRY_MS = 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function toPng(rgba, size) {
  const image = new ImageData(rgba, size, size);
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(size, size);
    canvas.getContext('2d').putImageData(image, 0, 0);
    return (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
  }
  const canvas = document.createElement('canvas'); // older Safari has no OffscreenCanvas
  canvas.width = size;
  canvas.height = size;
  canvas.getContext('2d').putImageData(image, 0, 0);
  const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not encode the tile'))), 'image/png'));
  return blob.arrayBuffer();
}

/** Registers the protocol. Returns { stats, clear } for the debug overlay and for tests. */
export function registerDemProtocol(maplibregl, { log = () => {}, fetchImpl = (...a) => fetch(...a) } = {}) {
  const cache = new Map(); // "z/x/y" -> Promise<ArrayBuffer> of a PNG
  const stats = { made: 0, flat: 0, failed: 0, cacheHits: 0, requests: 0 };
  let running = 0;
  const waiting = [];

  const slot = (signal) => new Promise((resolve, reject) => {
    const start = () => { running++; resolve(); };
    if (running < MAX_PARALLEL) return start();
    const entry = { start, reject };
    waiting.push(entry);
    signal?.addEventListener('abort', () => {
      const i = waiting.indexOf(entry);
      if (i >= 0) { waiting.splice(i, 1); reject(new DOMException('aborted', 'AbortError')); }
    }, { once: true });
  });
  const release = () => { running--; waiting.shift()?.start(); };

  async function fetchHeights(url) {
    let failure;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await sleep(RETRY_MS);
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (res.ok) return res.arrayBuffer();
        failure = new Error(`the elevation service answered ${res.status}`);
        if (res.status < 500) break; // a 4xx will not get better by asking again
      } catch (err) {
        failure = err;
      }
    }
    throw failure;
  }

  async function build(tile, key) {
    const bounds = tileBounds(tile.z, tile.x, tile.y);
    stats.requests++;
    let buffer;
    try {
      buffer = await fetchHeights(demUrl(bounds));
    } catch (err) {
      stats.failed++;
      log('warn', `terrain tile ${key}: ${err.message}`);
      throw err; // not kept, and the map is told this tile is missing
    }
    let heights;
    try {
      const tiff = parseGeoTiff(buffer);
      heights = resampleToMercator({ width: tiff.width, height: tiff.height, data: cleanHeights(tiff.data) }, bounds, DEM_SIZE);
      stats.made++;
    } catch {
      heights = flatHeights(); // not a height file: an area without data
      stats.flat++;
    }
    return toPng(encodeTerrarium(heights, DEM_SIZE), DEM_SIZE);
  }

  maplibregl.addProtocol(PROTOCOL, async (params, abortController) => {
    const tile = parseTileUrl(params.url);
    if (!tile) throw new Error('not a terrain tile address');
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    let promise = cache.get(key);
    if (promise) {
      stats.cacheHits++;
      cache.delete(key); // keep the most recently used last
      cache.set(key, promise);
    } else {
      promise = (async () => {
        await slot(abortController?.signal);
        try { return await build(tile, key); } finally { release(); }
      })();
      promise.catch(() => cache.delete(key)); // an aborted wait is not remembered
      cache.set(key, promise);
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    }
    return { data: (await promise).slice(0) };
  });

  return { stats, clear: () => cache.clear() };
}
