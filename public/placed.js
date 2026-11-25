// Ships the user places on the chart from the ship inspector (Ships → Place on the map): drawn and
// handled like AIS ships (aismap.js, helm.js), with a report of their own that Rudder keeps moving.
// Left to themselves (the helm handed back), they carry on at the speed and course they had, straight
// on, until something stops them (land or shallow water ahead: aismap.js sounds ahead of them).
//
// Their MMSIs are in a range no real ship has (MID 999). Kept on this device (localStorage), so they
// are still there after a reload, where dead reckoning puts them. Pure apart from storage, so tested.

import { predict } from './motion.js';

export const PLACED_KEY = 'rudder.placed.v1';
export const PLACED_BASE = 999_990_000;
export const isPlacedMmsi = (m) => Number(m) >= PLACED_BASE && Number(m) < PLACED_BASE + 10_000;

/** An AIS ship type for the inspector's vessel kinds (presets.js). */
export const SHIP_TYPE = {
  container: 70, bulk: 70, cargo: 70, tanker: 80, cruise: 60, ferry: 60, liner: 60,
  warship: 35, carrier: 35, sailing: 36, yacht: 37, tug: 52,
};

/** The next free MMSI for a placed ship. */
export function nextMmsi(taken) {
  let m = PLACED_BASE + 1;
  const used = new Set([...taken].map(Number));
  while (used.has(m)) m++;
  return m;
}

/**
 * A placed ship's first report: `spec` { name, kind, length, beam, draft } (the inspector's ship),
 * at { lat, lon }, heading in degrees, still. The antenna is put amidships.
 */
export function placedReport(spec, at, heading, mmsi, now = Date.now()) {
  const L = Math.max(3, Math.round(spec.length)), B = Math.max(1, Math.round(spec.beam));
  return {
    mmsi,
    name: String(spec.name || 'MY SHIP').toUpperCase().slice(0, 30),
    shipType: SHIP_TYPE[spec.kind] ?? 70,
    latitude: at.lat,
    longitude: at.lon,
    trueHeading: Math.round((((heading % 360) + 360) % 360) * 10) / 10,
    courseOverGround: Math.round((((heading % 360) + 360) % 360) * 10) / 10,
    speedOverGround: 0,
    rateOfTurn: 0,
    navigationalStatus: 0,
    dimensionA: Math.ceil(L / 2), dimensionB: Math.floor(L / 2),
    dimensionC: Math.ceil(B / 2), dimensionD: Math.floor(B / 2),
    draught: Math.round(Math.max(0.3, spec.draft) * 10),
    msgtime: new Date(now).toISOString(),
    placed: true,
    kind: spec.kind,
  };
}

/** The report handed back by the helm, made to carry on straight at its speed and course (no turn). */
export function carryOn(v, now = Date.now()) {
  return { ...v, rateOfTurn: 0, msgtime: new Date(now).toISOString(), simulated: false, placed: true };
}

/** A placed ship moved on to time `now` by dead reckoning: a fresh report where it has got to. */
export function advance(v, now = Date.now()) {
  if (!(v.speedOverGround >= 0.1)) return { ...v, msgtime: new Date(now).toISOString() };
  const p = predict({ ...v, rateOfTurn: 0 }, now);
  return { ...v, latitude: p.lat, longitude: p.lon, rateOfTurn: 0, msgtime: new Date(now).toISOString() };
}

/** Stopped (it ran aground or would): speed 0, where it is. */
export const stopped = (v, now = Date.now()) => ({ ...v, speedOverGround: 0, rateOfTurn: 0, msgtime: new Date(now).toISOString() });

/** Placed ships from storage, sound ones only. */
export function parsePlaced(json) {
  const list = Array.isArray(json) ? json : [];
  return list.filter((v) => v && isPlacedMmsi(v.mmsi) && Number.isFinite(v.latitude) && Number.isFinite(v.longitude) && v.dimensionA + v.dimensionB > 0)
    .map((v) => ({ ...v, placed: true, simulated: false }));
}

export function loadPlaced(storage = globalThis.localStorage) {
  try { return parsePlaced(JSON.parse(storage.getItem(PLACED_KEY))); } catch { return []; }
}
export function savePlaced(list, storage = globalThis.localStorage) {
  try { storage.setItem(PLACED_KEY, JSON.stringify(list)); } catch { /* private mode: kept for this visit */ }
}
