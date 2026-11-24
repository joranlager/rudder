// Contact for the ship under the user's command (helm.js): with other ships, and with the bottom or
// the shore. Pure, so it is tested.
//
// Ships: every ship is a convex outline (a box with a pointed bow, placed by its GPS antenna, as on
// the chart: ais.js vesselOutline). Two outlines touch when no line separates them; how far they
// overlap (the penetration) is the smallest push along any edge's normal that would part them
// (separating axis test). A move that makes the overlap with any ship deeper is refused.
//
// Ground: Kartverket's height service (hoydedata) answers for any point with either the sea
// ("Havflate", with the depth from the chart's depth contours) or the land and its height. The hull is
// sounded at its bow, stern, antenna and both sides; land at any of them, or less water than the
// draught, is aground there.

import { vesselOutline, vesselSize } from './ais.js';

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** [lon, lat] to metres east (x) and north (y) of `origin`. */
export function toLocal([lon, lat], origin) {
  return [rad(lon - origin.lon) * R * Math.cos(rad(origin.lat)), rad(lat - origin.lat) * R];
}

/** A ship's outline as metres around `origin`, for a report moved to `at` ({ lat, lon, heading }). null if it has no size. */
export function hullAt(v, at, origin) {
  if (!at || at.heading == null) return null;
  const ring = vesselOutline({ ...v, latitude: at.lat, longitude: at.lon, trueHeading: at.heading, courseOverGround: at.heading, speedOverGround: 0 });
  if (!ring) return null;
  return ring.slice(0, -1).map((p) => toLocal(p, origin)); // the ring repeats its first point
}

const project = (poly, [ax, ay]) => {
  let min = Infinity, max = -Infinity;
  for (const [x, y] of poly) { const d = x * ax + y * ay; if (d < min) min = d; if (d > max) max = d; }
  return [min, max];
};

/** How deep two convex outlines overlap, in metres (0 when they do not touch). */
export function penetration(a, b) {
  let best = Infinity;
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (!len) continue;
      const axis = [-(y2 - y1) / len, (x2 - x1) / len];
      const [amin, amax] = project(a, axis), [bmin, bmax] = project(b, axis);
      const overlap = Math.min(amax, bmax) - Math.max(amin, bmin);
      if (overlap <= 0) return 0;
      if (overlap < best) best = overlap;
    }
  }
  return best === Infinity ? 0 : best;
}

/** The deepest overlap of `own` with any of `others` ([{ v, hull }]), and with which ship. */
export function deepestContact(own, others) {
  let worst = { depth: 0, v: null };
  if (!own) return worst;
  for (const o of others) {
    if (!o.hull) continue;
    const d = penetration(own, o.hull);
    if (d > worst.depth) worst = { depth: d, v: o.v };
  }
  return worst;
}

// ---------- ground ----------

/** The points to sound: bow, stern, antenna and both sides, as [lon, lat], named. */
export function soundingPoints(v, at) {
  const { length, beam, toBow, toPort } = vesselSize(v);
  const h = rad(at.heading ?? 0);
  // Ship frame from the antenna: x forward, y to starboard; metres north and east.
  const put = (x, y) => {
    const north = x * Math.cos(h) - y * Math.sin(h), east = x * Math.sin(h) + y * Math.cos(h);
    return [at.lon + deg(east / (R * Math.cos(rad(at.lat)))), at.lat + deg(north / R)];
  };
  const mid = toBow - length / 2; // amidships, forward of the antenna
  return [
    { name: 'bow', p: put(toBow * 0.97, beam / 2 - toPort) },
    { name: 'stern', p: put(-(length - toBow) * 0.97, beam / 2 - toPort) },
    { name: 'antenna', p: put(0, 0) },
    { name: 'port side', p: put(mid, -toPort * 0.95) },
    { name: 'starboard side', p: put(mid, (beam - toPort) * 0.95) },
  ];
}

/** Kartverket's height service for several points at once (WGS 84 lon/lat). */
export const seabedUrl = (points) =>
  `https://ws.geonorge.no/hoydedata/v1/punkt?punkter=${encodeURIComponent(JSON.stringify(points.map(([lon, lat]) => [+lon.toFixed(6), +lat.toFixed(6)])))}&koordsys=4258&geojson=false`;

/** Its answer as, per point, { sea: true, depth } (metres of water) or { sea: false, height } (land). */
export function parseSeabed(json) {
  return (json?.punkter ?? []).map((p) => {
    const z = Number(p.z);
    if (p.terreng === 'Havflate') return { sea: true, depth: Number.isFinite(z) ? Math.max(0, -z) : null };
    return { sea: false, height: Number.isFinite(z) ? z : null };
  });
}

/**
 * Aground? Land under any sounded point, or less water than the draught. Returns the first such
 * point ({ name, reason: 'land' | 'shallow', depth }) or null, and the depth under the antenna.
 */
export function groundCheck(points, seabed, draught) {
  let hit = null, depth = null;
  points.forEach((pt, i) => {
    const s = seabed[i];
    if (!s) return;
    if (pt.name === 'antenna' && s.sea) depth = s.depth;
    if (hit) return;
    if (!s.sea) hit = { name: pt.name, reason: 'land' };
    else if (s.depth != null && s.depth < draught) hit = { name: pt.name, reason: 'shallow', depth: s.depth };
  });
  return { hit, depth };
}

/** Which way the ship may still move when aground at a point: away from it, never towards it. */
export function allowedMotion(hit, s) {
  if (!hit) return s;
  const out = { ...s };
  if (hit.name === 'bow' && out.u > 0) out.u = 0;
  if (hit.name === 'stern' && out.u < 0) out.u = 0;
  if (hit.name === 'antenna') { out.u = Math.min(0, out.u); out.v = 0; }
  if (hit.name === 'port side' && out.v < 0) out.v = 0;
  if (hit.name === 'starboard side' && out.v > 0) out.v = 0;
  return out;
}
