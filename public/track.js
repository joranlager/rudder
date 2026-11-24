// Recorded AIS tracks: what is stored, and how a ship is placed between its recorded positions.
// Pure, so it is tested.
//
// Storing: every position report could be kept, but a ship lying alongside reports the same place
// all day. A report is kept when the ship has moved or turned noticeably since the last kept one,
// or some minutes have passed (so it is still known to be there).
//
// Playing back: between two kept positions the ship follows a smooth curve, not a straight line.
// Each position has a speed and a course, so the curve leaves the first at the ship's velocity
// there and arrives at the second at its velocity there (a cubic Hermite curve). Turns come out as
// arcs and speed changes as easing. When the velocities do not fit the gap (a bad course, a gap of
// many minutes) the curve falls back to the straight line between the two.

const R = 6371008.8;
const KNOT = 1852 / 3600;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export const KEEP = { moveM: 25, turnDeg: 5, quietMs: 10 * 60e3 };
export const MAX_GAP_MS = 30 * 60e3; // a longer silence is not bridged: the ship waits at its last place, then is gone
export const HOLD_MS = 15 * 60e3; // how long a ship is shown at its last place after its last kept position
export const SPEEDS = [1, 2, 5, 10, 30, 60, 120, 300, 600];
export const TRACE_COLORS = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#ffffff'];

const finite = (x) => Number.isFinite(x);
const validCourse = (c) => finite(c) && c >= 0 && c < 360;
const round = (x, n) => Math.round(x * 10 ** n) / 10 ** n;

/** An AIS report as a compact record: { m: MMSI, t: time ms, la, lo, s: knots, c: course, h: heading }. */
export function toRecord(v) {
  const t = Date.parse(v?.msgtime);
  if (!v?.mmsi || !finite(t) || !finite(v.latitude) || !finite(v.longitude)) return null;
  if (Math.abs(v.latitude) > 90 || Math.abs(v.longitude) > 180) return null;
  const rec = { m: Number(v.mmsi), t, la: round(v.latitude, 6), lo: round(v.longitude, 6) };
  if (finite(v.speedOverGround) && v.speedOverGround < 102.3) rec.s = round(v.speedOverGround, 1);
  if (validCourse(v.courseOverGround)) rec.c = round(v.courseOverGround, 1);
  if (validCourse(v.trueHeading)) rec.h = v.trueHeading;
  return rec;
}

/** The ship's description, kept once per ship (and when it changes). */
export function staticOf(v) {
  const keep = ['name', 'shipType', 'callSign', 'imoNumber', 'destination', 'draught', 'dimensionA', 'dimensionB', 'dimensionC', 'dimensionD', 'shipLength', 'shipWidth'];
  const out = { m: Number(v.mmsi) };
  for (const k of keep) if (v[k] != null && v[k] !== '') out[k] = v[k];
  return out;
}

export const sameStatic = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function distanceM(a, b) {
  const dLat = rad(b.la - a.la), dLon = rad(b.lo - a.lo);
  return Math.hypot(dLat * R, dLon * R * Math.cos(rad((a.la + b.la) / 2)));
}
const angleDiff = (a, b) => ((((a - b) % 360) + 540) % 360) - 180;

/** Whether a new record is worth keeping after the last kept one for the same ship. */
export function shouldKeep(prev, rec, keep = KEEP) {
  if (!prev) return true;
  if (rec.t <= prev.t) return false;
  if (rec.t - prev.t >= keep.quietMs) return true;
  if (distanceM(prev, rec) >= keep.moveM) return true;
  const hp = prev.h ?? prev.c, hr = rec.h ?? rec.c;
  return hp != null && hr != null && Math.abs(angleDiff(hr, hp)) >= keep.turnDeg;
}

/** Velocity in metres per second, east and north, from a record's speed and course (null if unknown). */
function velocity(r) {
  if (!finite(r.s) || !validCourse(r.c)) return null;
  const v = r.s * KNOT;
  return [v * Math.sin(rad(r.c)), v * Math.cos(rad(r.c))];
}

/** Place on the smooth curve between records a and b at time t (a.t <= t <= b.t). */
export function between(a, b, t) {
  const T = (b.t - a.t) / 1000;
  const u = T > 0 ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
  const cos = Math.cos(rad(a.la));
  // b in metres east/north of a
  const bx = rad(b.lo - a.lo) * R * cos, by = rad(b.la - a.la) * R;
  const chord = Math.hypot(bx, by);
  let va = velocity(a), vb = velocity(b);
  // Velocities that do not fit the gap (wrong course, long silence) would loop: use the straight line.
  const fits = (v) => v && T > 0 && Math.hypot(v[0], v[1]) * T < 3 * chord + 50 && (chord < 5 || (v[0] * bx + v[1] * by) > 0);
  if (!fits(va) || !fits(vb)) { va = [bx / (T || 1), by / (T || 1)]; vb = va; }
  const u2 = u * u, u3 = u2 * u;
  const h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  const x = h10 * T * va[0] + h01 * bx + h11 * T * vb[0];
  const y = h10 * T * va[1] + h01 * by + h11 * T * vb[1];
  // Direction of travel along the curve, for ships with no heading.
  const d10 = 3 * u2 - 4 * u + 1, d01 = -6 * u2 + 6 * u, d11 = 3 * u2 - 2 * u;
  const dx = d10 * T * va[0] + d01 * bx + d11 * T * vb[0], dy = d10 * T * va[1] + d01 * by + d11 * T * vb[1];
  const travel = Math.hypot(dx, dy) > 1e-6 ? (deg(Math.atan2(dx, dy)) + 360) % 360 : null;
  const ha = a.h ?? null, hb = b.h ?? null;
  let heading = null;
  if (ha != null && hb != null) heading = (ha + angleDiff(hb, ha) * u + 360) % 360;
  else heading = ha ?? hb ?? travel;
  const sog = finite(a.s) && finite(b.s) ? a.s + (b.s - a.s) * u : a.s ?? b.s ?? (T > 0 ? chord / T / KNOT : 0);
  return {
    lat: a.la + deg(y / R), lon: a.lo + deg(x / (R * cos)),
    heading, cog: travel ?? a.c ?? null, sog,
  };
}

/** Index of the last record at or before t in records sorted by time (-1 if none). */
export function lastAtOrBefore(recs, t) {
  let lo = 0, hi = recs.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (recs[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/**
 * Where a ship is at time t from its records (sorted by time): on the curve between the records
 * around t; at its last place for a while after a record when the next is far off or there is none;
 * null before its first record or after that.
 */
export function positionAt(recs, t) {
  if (!recs?.length) return null;
  const i = lastAtOrBefore(recs, t);
  if (i < 0) return null;
  const a = recs[i], b = recs[i + 1];
  if (b && b.t - a.t <= MAX_GAP_MS) return between(a, b, t);
  if (t - a.t > HOLD_MS) return null;
  return { lat: a.la, lon: a.lo, heading: a.h ?? a.c ?? null, cog: a.c ?? null, sog: 0 };
}

/** The ship's path from t0 to t1 as [lon, lat] points, `perSegment` points per gap between records. */
export function traceCoords(recs, t0, t1, perSegment = 6) {
  const out = [];
  const push = (p) => { if (p) out.push([round(p.lon, 6), round(p.lat, 6)]); };
  if (!recs?.length || t1 <= t0) return out;
  push(positionAt(recs, t0));
  for (let i = 0; i < recs.length; i++) {
    const a = recs[i], b = recs[i + 1];
    if (a.t > t1) break;
    if (!b || b.t < t0) continue;
    if (b.t - a.t > MAX_GAP_MS) continue;
    for (let k = 1; k <= perSegment; k++) {
      const t = a.t + ((b.t - a.t) * k) / perSegment;
      if (t > t0 && t < t1) push(between(a, b, t));
    }
  }
  push(positionAt(recs, t1));
  return out;
}

/** "1:30" (hours:minutes), "90" (minutes) or "2h" as milliseconds; null if it cannot be read. */
export function parseAgo(text) {
  const s = String(text ?? '').trim().toLowerCase();
  let m = /^(\d+):([0-5]?\d)$/.exec(s);
  if (m) return (Number(m[1]) * 60 + Number(m[2])) * 60e3;
  m = /^(\d+(?:\.\d+)?)\s*h$/.exec(s);
  if (m) return Number(m[1]) * 3600e3;
  m = /^(\d+)\s*(m|min)?$/.exec(s);
  if (m) return Number(m[1]) * 60e3;
  return null;
}

/** A span of time as "2 d 3 h", "3 h 05 min" or "12 min". */
export function formatSpan(ms) {
  const min = Math.max(0, Math.round(ms / 60e3));
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), mm = min % 60;
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${String(mm).padStart(2, '0')} min`;
  return `${mm} min`;
}

/** A report for the AIS layer from a ship's description and its played-back place at time t. */
export function playbackReport(stat, p, t) {
  return {
    ...stat, mmsi: stat.m, latitude: p.lat, longitude: p.lon,
    trueHeading: p.heading ?? 511, courseOverGround: p.cog ?? 360, speedOverGround: p.sog ?? 0,
    msgtime: new Date(t).toISOString(), playback: true,
  };
}
