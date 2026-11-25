// A heading for a ship that reports none. Many small craft send no compass heading (AIS 511), and a
// ship lying still has no course worth trusting, so the chart could only draw a dot. Lying still, a
// ship is most often moored alongside, so it is drawn along the nearest quay or shore (OpenStreetMap's
// water outlines and piers from OpenFreeMap's tiles); else on the heading it had earlier, else on its
// last course, else north. The guess says how it was made, and the chart marks it as a guess.
//
// Pure (no MapLibre), so it is unit tested; aismap.js fetches the shore and keeps the guesses.

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const wrap = (a) => ((a % 360) + 360) % 360;

export const SHORE_ZOOM = 14; // OpenFreeMap's deepest tiles: their edges are where features are cut
export const SHORE_REACH_M = 30; // a quay this far from the ship's side counts as the one it lies at

/** A [lon, lat] in tile units at zoom `z` (x east, y south; whole numbers are tile edges). */
export function tileXY([lon, lat], z = SHORE_ZOOM) {
  const n = 2 ** z;
  return [((lon + 180) / 360) * n, ((1 - Math.log(Math.tan(rad(lat)) + 1 / Math.cos(rad(lat))) / Math.PI) / 2) * n];
}

/**
 * A segment the tiles made, not the real shore: tiles cut the water outlines with straight lines just
 * beyond their edges (inside a small buffer). So: exactly north-south or east-west, and within 5 % of
 * a tile's width from its edge. (A real quay so placed is missed, and the next guess is used.)
 */
export function cutByTile(a, b, z = SHORE_ZOOM) {
  const [ax, ay] = tileXY(a, z), [bx, by] = tileXY(b, z);
  const nearEdge = (t) => Math.abs(t - Math.round(t)) < 0.05;
  return (Math.abs(ax - bx) < 1e-6 && nearEdge(ax)) || (Math.abs(ay - by) < 1e-6 && nearEdge(ay));
}

/**
 * The nearest stretch of shore to (lon, lat) within `maxM` metres: { distance, along } with `along`
 * the shore's direction there (0-180 degrees: it runs both ways). `lines` are lists of [lon, lat]
 * (water outlines' rings, pier lines). null when none is that near.
 */
export function nearestShore(lon, lat, lines, maxM = 60, z = SHORE_ZOOM) {
  const kx = R * Math.cos(rad(lat)) * (Math.PI / 180), ky = R * (Math.PI / 180);
  let best = null;
  for (const line of lines) {
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i], b = line[i + 1];
      const ax = (a[0] - lon) * kx, ay = (a[1] - lat) * ky, bx = (b[0] - lon) * kx, by = (b[1] - lat) * ky;
      // quick reject: both ends far off on the same side
      if ((ax > maxM && bx > maxM) || (ax < -maxM && bx < -maxM) || (ay > maxM && by > maxM) || (ay < -maxM && by < -maxM)) continue;
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      if (len2 < 0.25) continue; // under half a metre: no direction to speak of
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d > maxM || (best && d >= best.distance)) continue;
      if (cutByTile(a, b, z)) continue;
      best = { distance: d, along: wrap(deg(Math.atan2(dx, dy))) % 180 };
    }
  }
  return best;
}

/** Of a line's two directions (a, a + 180), the one nearer `hint` (degrees); `a` without a hint. */
export function nearerWay(a, hint) {
  if (!Number.isFinite(hint)) return a;
  const diff = (x) => Math.abs(((((x - hint) % 360) + 540) % 360) - 180);
  return diff(a) <= diff(a + 180) ? wrap(a) : wrap(a + 180);
}

/**
 * A heading for a ship that reports none: { deg, how }. `v` its report (with knownHeading: the heading
 * it reported earlier, if any), `shore` nearestShore's answer (or null), `beam` its beam in metres.
 */
export function guessHeading(v, shore, beam = 0) {
  const known = Number.isFinite(v.knownHeading) ? v.knownHeading : null;
  const cog = Number.isFinite(v.courseOverGround) && v.courseOverGround >= 0 && v.courseOverGround < 360 ? v.courseOverGround : null;
  if (shore && shore.distance <= beam / 2 + SHORE_REACH_M) {
    // Alongside: which way the bow points along the quay, the earlier heading or course tells (else either).
    return { deg: Math.round(nearerWay(shore.along, known ?? cog) * 10) / 10, how: 'along the quay' };
  }
  if (known !== null) return { deg: known, how: 'as reported earlier' };
  if (cog !== null) return { deg: cog, how: 'its last course' };
  return { deg: 0, how: 'not known (drawn north)' };
}
