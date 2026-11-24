// Moving ships between AIS reports, for the 3D models on the chart (shipmodels.js).
//
// A ship reports its position, speed and course every few seconds to minutes, and Rudder asks
// BarentsWatch every 30 seconds. In between, each ship is moved by dead reckoning from its last
// report: along its course over ground at its speed over ground, curving with its rate of turn while
// that is plausible. When a new report comes, the difference between where the ship was shown and
// where the report puts it is eased away over a few seconds, so no ship jumps. Pure, so it is tested.
//
// Ships lying still (alongside, at anchor, or creeping under 1 knot) are held steady: their GPS
// position wanders a few metres and their heading a few degrees from report to report, and their
// course over ground points anywhere. Turned about the antenna, that made a docked ship's stern swing
// to and fro. So a steady ship keeps its shown place and heading unless a report moves it more than
// STEADY_M or turns it more than STEADY_DEG, and its heading never comes from its course.

import { drawHeading } from './ais.js';

const R = 6371008.8; // mean earth radius, metres
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const KNOT = 1852 / 3600; // m/s

export const MAX_PREDICT_MS = 5 * 60e3; // beyond this without a report, the ship is held where it got to
export const MAX_TURN_MS = 60e3; // a turn is followed for a minute, then the ship goes straight on
export const EASE_MS = 4000; // how long a correction from a new report takes
export const MIN_SPEED_KN = 1; // slower, the course over ground is GPS noise: no dead reckoning
export const STEADY_M = 10; // a steady ship is not moved for less than this
export const STEADY_DEG = 5; // nor turned for less than this
const MOORED = new Set([1, 5, 6]); // at anchor, moored, aground

/** Lying still: under 1 knot, or at anchor, moored or aground and under 3 knots. */
export function isSteady(v) {
  const sog = Number(v.speedOverGround);
  if (!(sog >= MIN_SPEED_KN)) return true;
  return MOORED.has(Number(v.navigationalStatus)) && sog < 3;
}

/** The heading of a steady ship: its compass heading only (course over ground is noise when still). */
const steadyHeading = (v) => (Number.isFinite(v.trueHeading) && v.trueHeading >= 0 && v.trueHeading < 360 ? v.trueHeading : null);

const wrap360 = (a) => ((a % 360) + 360) % 360;
/** Shortest signed difference a - b in degrees, -180..180. */
export const angleDiff = (a, b) => ((((a - b) % 360) + 540) % 360) - 180;

/** Move [lat, lon] by metres north and east. */
function moveBy(lat, lon, north, east) {
  return [lat + deg(north / R), lon + deg(east / (R * Math.cos(rad(lat))))];
}

/** Rate of turn in degrees per second, or 0 when not given or not believable. */
function turnRate(v) {
  const rot = Number(v.rateOfTurn);
  // AIS reports up to 708 degrees a minute; ±720 or more means "no information" or a pending turn indicator.
  if (!Number.isFinite(rot) || Math.abs(rot) >= 708) return 0;
  return rot / 60;
}

/**
 * Where the ship is at time `t` (ms), by dead reckoning from its last report.
 * Returns { lat, lon, heading } (heading null when unknown), and `moving` when it is under way.
 */
export function predict(v, t) {
  const at = Date.parse(v.msgtime);
  const sog = Number(v.speedOverGround);
  const cog = Number(v.courseOverGround);
  if (isSteady(v)) return { lat: v.latitude, lon: v.longitude, heading: steadyHeading(v), moving: false };
  const heading0 = drawHeading(v);
  const still = { lat: v.latitude, lon: v.longitude, heading: heading0, moving: false };
  if (!Number.isFinite(at) || sog > 102 || !(cog >= 0 && cog < 360)) return still;
  const dt = Math.min(Math.max(0, t - at), MAX_PREDICT_MS) / 1000; // seconds
  const speed = sog * KNOT;
  const w = rad(turnRate(v)); // rad/s, clockwise positive like courses
  const tTurn = Math.min(dt, MAX_TURN_MS / 1000);
  const c0 = rad(cog);
  let north, east;
  if (Math.abs(w) < 1e-6) {
    north = speed * dt * Math.cos(c0);
    east = speed * dt * Math.sin(c0);
  } else {
    // Along an arc while turning, then straight on along the course it ended with.
    const c1 = c0 + w * tTurn;
    north = (speed / w) * (Math.sin(c1) - Math.sin(c0)) + speed * (dt - tTurn) * Math.cos(c1);
    east = (speed / w) * (Math.cos(c0) - Math.cos(c1)) + speed * (dt - tTurn) * Math.sin(c1);
  }
  const [lat, lon] = moveBy(v.latitude, v.longitude, north, east);
  const turned = deg(w * tTurn);
  return { lat, lon, heading: heading0 === null ? null : wrap360(heading0 + turned), moving: dt < MAX_PREDICT_MS / 1000 };
}

/**
 * Shown positions for many ships over time. `show(v, t)` gives where to draw ship `v` at time `t`:
 * the dead-reckoned position, plus what is left of the correction from its latest report.
 */
export function createMotion(easeMs = EASE_MS) {
  const ships = new Map(); // mmsi -> { msgtime, v, north, east, heading, since }

  function show(v, t) {
    let s = ships.get(v.mmsi);
    if (!s || s.msgtime !== v.msgtime) {
      // A new report: start from where the ship was shown, and ease towards the new prediction.
      const was = s ? shown(s, t) : null;
      const r = settle(v, s?.v);
      const now = predict(r, t);
      s = { msgtime: v.msgtime, v: r, north: 0, east: 0, heading: 0, since: t };
      if (was && Math.abs(was.lat - now.lat) < 0.05 && Math.abs(was.lon - now.lon) < 0.1) {
        s.north = rad(was.lat - now.lat) * R;
        s.east = rad(was.lon - now.lon) * R * Math.cos(rad(now.lat));
        s.heading = was.heading !== null && now.heading !== null ? angleDiff(was.heading, now.heading) : 0;
      }
      ships.set(v.mmsi, s);
    }
    return shown(s, t);
  }

  /**
   * A new report as it should be shown: for a steady ship, the previous place and heading when it has
   * not really moved or turned, and the previous heading when it reports none.
   */
  function settle(v, prev) {
    if (!isSteady(v) || !prev || !isSteady(prev)) return v;
    const hdg = steadyHeading(v), prevHdg = steadyHeading(prev);
    const moved = Math.hypot(rad(v.latitude - prev.latitude) * R, rad(v.longitude - prev.longitude) * R * Math.cos(rad(v.latitude)));
    const turned = hdg === null || prevHdg === null ? 0 : Math.abs(angleDiff(hdg, prevHdg));
    const keepPlace = moved < STEADY_M;
    const keepHeading = hdg === null || turned < STEADY_DEG;
    return {
      ...v,
      latitude: keepPlace ? prev.latitude : v.latitude,
      longitude: keepPlace ? prev.longitude : v.longitude,
      trueHeading: keepHeading ? (prevHdg ?? hdg ?? 511) : hdg,
    };
  }

  function shown(s, t) {
    const p = predict(s.v, t);
    const left = remaining((t - s.since) / easeMs);
    const [lat, lon] = left > 0 ? moveBy(p.lat, p.lon, s.north * left, s.east * left) : [p.lat, p.lon];
    const heading = p.heading === null ? null : wrap360(p.heading + s.heading * left);
    const correcting = left > 0 && (s.north || s.east || s.heading);
    return { lat, lon, heading, moving: p.moving || Boolean(correcting) };
  }

  return {
    show,
    forget(mmsi) { ships.delete(mmsi); },
    keepOnly(mmsis) { for (const k of [...ships.keys()]) if (!mmsis.has(k)) ships.delete(k); },
  };
}

/** Share of a correction still to go, `x` of the way through it: 1 at the start, 0 at the end, soft at both ends. */
export function remaining(x) {
  const k = Math.min(1, Math.max(0, x));
  return 1 - k * k * (3 - 2 * k);
}

/** Whether screen point `p` is on a ship drawn from `stern` to `bow` (screen points), `halfBeam` px wide each side. */
export function hitsShip(p, bow, stern, halfBeam) {
  const dx = bow.x - stern.x, dy = bow.y - stern.y;
  const len2 = dx * dx + dy * dy;
  const k = len2 ? Math.max(0, Math.min(1, ((p.x - stern.x) * dx + (p.y - stern.y) * dy) / len2)) : 0;
  const ex = p.x - (stern.x + k * dx), ey = p.y - (stern.y + k * dy);
  return Math.hypot(ex, ey) <= Math.max(halfBeam, 6);
}

/** Points along the ship's centre line from a shown position: bow and stern, as [lat, lon]. */
export function bowAndStern(lat, lon, heading, toBow, length) {
  const h = rad(heading);
  return {
    bow: moveBy(lat, lon, toBow * Math.cos(h), toBow * Math.sin(h)),
    stern: moveBy(lat, lon, -(length - toBow) * Math.cos(h), -(length - toBow) * Math.sin(h)),
  };
}
