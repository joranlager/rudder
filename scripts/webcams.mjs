// Works out where each webcam looks and writes public/webcams.json: npm run webcams.
//
// Statens vegvesen's cameras say which place they look towards, not a bearing (public/webcams.js).
// For each, the place is looked up in Kartverket's place-name register (ws.geonorge.no/stedsnavn),
// the nearest of that name chosen, and the bearing from the camera to it stored, with how sure it is.
// The ground height under each camera comes from the full DATEX record (for the view's horizon).
// Run it again now and then: cameras come and go. The page works without it (no sectors then).
import { writeFile } from 'node:fs/promises';
import { WFS, camerasUrl, parseCameras, readLooks, pickPlace, directionTo } from '../public/webcams.js';

const PLACES = 'https://ws.geonorge.no/stedsnavn/v1/navn';

async function json(url) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
      return await r.json();
    } catch (e) {
      if (i >= 3) throw e;
      await new Promise((res) => setTimeout(res, 1000 * (i + 1)));
    }
  }
}

/** Every place of exactly that name (any type), as { name, lat, lon, type }. */
async function places(name) {
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const q = new URLSearchParams({ sok: name, fuzzy: 'false', treffPerSide: '100', side: String(page), utkoordsys: '4258' });
    const j = await json(`${PLACES}?${q}`);
    for (const n of j.navn ?? []) {
      const p = n.representasjonspunkt;
      if (p) out.push({ name: n['skrivemåte'], lat: p.nord, lon: p['øst'], type: n.navneobjekttype });
    }
    if ((j.metadata?.totaltAntallTreff ?? 0) <= page * 100) break;
  }
  return out;
}

/** Ground height under each camera (metres above sea), from the full DATEX records. */
async function grounds() {
  const q = new URLSearchParams({ service: 'WFS', request: 'GetFeature', version: '2.0.0', typeNames: 'datex_3_1:Cctv', outputFormat: 'application/json' });
  const j = await json(`${WFS}?${q}`);
  const out = {};
  for (const f of j.features ?? []) {
    const id = f.properties?.recordId;
    const h = f.properties?.data?.[0]?.datex?.cctvCameraLocation?.pointByCoordinates?.pointCoordinates?.heightCoordinate?.[0]?.heightValue;
    if (id && Number.isFinite(h)) out[id] = Math.round(h * 10) / 10;
  }
  return out;
}

const cams = parseCameras(await json(camerasUrl()));
const ground = await grounds().catch((e) => { console.warn('no ground heights:', e.message); return {}; });
const cache = new Map();
const directions = {};
let found = 0, compass = 0, none = 0;
// a few at a time, to be kind to the register
const queue = [...cams];
await Promise.all(Array.from({ length: 4 }, async () => {
  while (queue.length) {
    const c = queue.shift();
    const want = readLooks(c.looks);
    const entry = Number.isFinite(ground[c.id]) ? { ground: ground[c.id] } : {};
    if (want?.bearing !== undefined) {
      directions[c.id] = { ...entry, bearing: want.bearing, target: c.looks, quality: 'rough' };
      compass++;
      continue;
    }
    if (want?.place) {
      const key = want.place.toLowerCase();
      if (!cache.has(key)) cache.set(key, places(want.place).catch(() => []));
      const p = pickPlace(c, await cache.get(key), want.place);
      if (p) {
        directions[c.id] = { ...entry, ...directionTo(c, p) };
        found++;
        continue;
      }
    }
    if (entry.ground !== undefined) directions[c.id] = entry;
    none++;
  }
}));

const sorted = Object.fromEntries(Object.entries(directions).sort(([a], [b]) => a.localeCompare(b)));
await writeFile('public/webcams.json', JSON.stringify({
  about: 'Where each Statens vegvesen webcam looks, worked out from the place it says it looks towards (npm run webcams, scripts/webcams.mjs). bearing: degrees true; target: the place; distance: metres to it; quality: good (place within 15 km), rough, very rough; ground: metres above sea under the camera.',
  made: new Date().toISOString().slice(0, 10),
  directions: sorted,
}, null, 1) + '\n');
console.log(`${cams.length} cameras: ${found} towards a place, ${compass} by compass word, ${none} unknown`);
