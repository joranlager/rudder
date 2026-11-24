// How a ship answers its controls: engine telegraph, rudder and thrusters. Pure, so it is tested.
//
// A simple three-way model (surge, sway, yaw) with first-order responses, tuned from rules of thumb
// rather than one ship's trials:
//  - speed: the engine order sets a target speed (astern about half of ahead); the ship gets there
//    with a time constant growing with its length, and slows more lazily than it speeds up
//  - rudder: turns the ship only while water flows past it (its own speed, plus the propeller's
//    wash when going ahead); hard over gives a turning circle of about 4 ship lengths across, and
//    the ship loses speed in the turn
//  - thrusters (where the type has them): push the bow or stern sideways, turning the ship on the
//    spot or moving it sideways; they lose their grip above about 5 knots
//  - yaw and sway follow with their own time constants, so turns start and stop gradually

import { vesselSize, hullFromAis } from './ais.js';

const KNOT = 1852 / 3600;
const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Engine orders, as on a bridge telegraph, with the share of full power each gives. */
export const TELEGRAPH = [
  { order: -4, label: 'Full astern', power: -1 },
  { order: -3, label: 'Half astern', power: -0.65 },
  { order: -2, label: 'Slow astern', power: -0.4 },
  { order: -1, label: 'Dead slow astern', power: -0.2 },
  { order: 0, label: 'Stop', power: 0 },
  { order: 1, label: 'Dead slow ahead', power: 0.2 },
  { order: 2, label: 'Slow ahead', power: 0.4 },
  { order: 3, label: 'Half ahead', power: 0.65 },
  { order: 4, label: 'Full ahead', power: 1 },
];
export const telegraphPower = (order) => TELEGRAPH.find((t) => t.order === order)?.power ?? 0;
export const RUDDER_MAX = 35; // degrees, hard over

/** Service speed (knots) and thrusters by ship type. Tugs have no thrusters but turn very tightly. */
export const HANDLING = {
  container: { speed: 21, bow: true, stern: false },
  tanker: { speed: 14, bow: true, stern: false },
  bulk: { speed: 14, bow: true, stern: false },
  cargo: { speed: 14, bow: true, stern: false },
  cruise: { speed: 21, bow: true, stern: true },
  ferry: { speed: 16, bow: true, stern: true },
  liner: { speed: 24, bow: true, stern: false },
  warship: { speed: 28, bow: true, stern: false },
  carrier: { speed: 30, bow: true, stern: false },
  sailing: { speed: 9, bow: false, stern: false },
  yacht: { speed: 25, bow: true, stern: false },
  tug: { speed: 12, bow: false, stern: false, tight: true },
};

/** Handling of a ship from its AIS report: its type and size decide speed, inertia and turning. */
export function handlingFor(v) {
  const { params } = hullFromAis(v);
  const L = Math.max(8, vesselSize(v).length || params.length);
  const h = HANDLING[params.kind] ?? HANDLING.cargo;
  // Small ships are slower: a 30 m ferry does not make 16 knots.
  const speedKn = h.speed * clamp(0.55 + L / 250, 0.6, 1);
  return {
    kind: params.kind,
    length: L,
    draught: params.draft,
    aheadMs: speedKn * KNOT,
    asternMs: speedKn * KNOT * 0.5,
    tauSpeed: 15 + 0.35 * L, // seconds to get most of the way to a new speed
    tauYaw: 4 + L / 25,
    tauSway: 8 + L / 15,
    turnRadius: (h.tight ? 1.4 : 2.6) * L, // hard over, without the propeller's wash
    bow: h.bow,
    stern: h.stern,
    thrusterYaw: rad(clamp(160 / L, 0.4, 4)), // rad/s with one thruster at full
    thrusterSway: clamp(0.012 * L, 0.3, 1.2) * 0.5, // m/s with both pushing the same way
  };
}

/** The ship as the simulation holds it: place, heading (degrees) and motion in the ship's frame. */
export function initialState(v) {
  const sog = Number(v.speedOverGround);
  const hdg = [v.trueHeading, v.courseOverGround].find((x) => Number.isFinite(x) && x >= 0 && x < 360) ?? 0;
  return { lat: v.latitude, lon: v.longitude, heading: hdg, u: Number.isFinite(sog) && sog < 102 ? sog * KNOT : 0, v: 0, r: 0 };
}

/** Controls: telegraph order (-4..4), rudder (degrees, + = starboard), thrusters (-1..1, + = push to starboard). */
export const neutralControls = () => ({ order: 0, rudder: 0, bow: 0, stern: 0 });

/** Thrusters lose their grip as the ship gathers way: full at rest, none from about 5 knots. */
export const thrusterGrip = (u) => clamp(1 - Math.abs(u) / (5 * KNOT), 0, 1);

/** Advance the ship by `dt` seconds. Returns a new state. */
export function step(s, c, h, dt) {
  dt = clamp(dt, 0, 1); // a long pause (a hidden tab) is not taken as one huge step
  const power = telegraphPower(c.order);
  // Speed through the water: towards the engine's target, slower to lose way than to gain it.
  const rudder = clamp(c.rudder, -RUDDER_MAX, RUDDER_MAX) / RUDDER_MAX;
  // A ship turning hard loses a good part of its speed.
  const target = (power >= 0 ? power * h.aheadMs * (1 - 0.35 * Math.abs(rudder)) : power * h.asternMs);
  const slowing = Math.abs(target) < Math.abs(s.u) || Math.sign(target) !== Math.sign(s.u);
  const tau = h.tauSpeed * (slowing ? 1.4 : 1);
  const u = s.u + (target - s.u) * (1 - Math.exp(-dt / tau));
  // Rudder: water past it is the ship's speed, plus the propeller's wash going ahead; astern it is weak.
  const flow = u >= 0 ? u + Math.max(0, power) * h.aheadMs * 0.3 : u * 0.4;
  const rRudder = (rudder * flow) / h.turnRadius;
  // Thrusters: bow to starboard turns to starboard, stern to starboard turns to port; both push sideways.
  const grip = thrusterGrip(u);
  const bow = h.bow ? clamp(c.bow, -1, 1) : 0, stern = h.stern ? clamp(c.stern, -1, 1) : 0;
  const rThrust = (bow - stern) * h.thrusterYaw * grip;
  const vThrust = ((bow + stern) / (h.bow && h.stern ? 2 : 1)) * h.thrusterSway * grip;
  const r = s.r + (rRudder + rThrust - s.r) * (1 - Math.exp(-dt / h.tauYaw));
  const v = s.v + (vThrust - s.v) * (1 - Math.exp(-dt / h.tauSway));
  // Move: surge along the heading, sway to starboard of it.
  const heading = (((s.heading + deg(r * dt)) % 360) + 360) % 360;
  const p = rad(heading);
  const north = (u * Math.cos(p) - v * Math.sin(p)) * dt;
  const east = (u * Math.sin(p) + v * Math.cos(p)) * dt;
  return {
    lat: s.lat + deg(north / R),
    lon: s.lon + deg(east / (R * Math.cos(rad(s.lat)))),
    heading, u, v, r,
  };
}

/** Speed over ground (knots) and course over ground (degrees) of a state. */
export function overGround(s) {
  const p = rad(s.heading);
  const north = s.u * Math.cos(p) - s.v * Math.sin(p), east = s.u * Math.sin(p) + s.v * Math.cos(p);
  const sog = Math.hypot(north, east) / KNOT;
  return { sog, cog: sog < 0.05 ? s.heading : (deg(Math.atan2(east, north)) + 360) % 360 };
}

/** The ship's AIS report as the simulation would send it, so the chart, card and model follow it. */
export function simReport(v, s, now = Date.now()) {
  const { sog, cog } = overGround(s);
  return {
    ...v, latitude: s.lat, longitude: s.lon, trueHeading: Math.round(s.heading * 10) / 10,
    speedOverGround: Math.round(sog * 10) / 10, courseOverGround: Math.round(cog * 10) / 10,
    rateOfTurn: Math.round(deg(s.r) * 60), navigationalStatus: 0, msgtime: new Date(now).toISOString(), simulated: true,
  };
}
