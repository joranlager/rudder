// AIS from BarentsWatch (Kystverket's AIS, open for Norwegian waters): requests, decoding and the
// shapes drawn on the chart. Pure, so it is unit tested. The page side is in aismap.js.
//
// Access: a BarentsWatch "AIS client" (created on My Page at barentswatch.no) gets a token with the
// OAuth client-credentials flow, sent as a bearer token to the live API. The client ID and secret
// are typed into the layers panel and kept only on this device. Checked against the API's own
// OpenAPI document (live.ais.barentswatch.no/live/openapi/ais/openapi.json) on 2026-11-23.

import { defaultParams } from './ships/presets.js';

export const TOKEN_URL = 'https://id.barentswatch.no/connect/token';
export const LATEST_URL = 'https://live.ais.barentswatch.no/live/v1/latest/combined';
export const OPEN_AREA_URL = 'https://live.ais.barentswatch.no/live/v1/openaisarea';

const R = 6371008.8; // mean earth radius, metres
const rad = (d) => (d * Math.PI) / 180;

// ---------- token ----------

/** Form body for the client-credentials token request. */
export function tokenRequestBody(clientId, clientSecret) {
  return new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: 'ais' }).toString();
}

/** The token answer, with the time it stops being used (a minute early, so a request never carries a dying token). */
export function parseToken(json, now = Date.now()) {
  if (!json?.access_token) throw new Error(json?.error_description || json?.error || 'No access token in the answer');
  const life = Number(json.expires_in) > 0 ? Number(json.expires_in) : 3600;
  return { token: json.access_token, expiresAt: now + Math.max(30, life - 60) * 1000 };
}

/**
 * A pasted access token (for when the browser may not call the login server): JWT expiry from its
 * payload when it has one, else an hour.
 */
export function pastedToken(text, now = Date.now()) {
  const token = String(text ?? '').trim().replace(/^Bearer\s+/i, '');
  if (!token) return null;
  let expiresAt = now + 3600 * 1000;
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.exp) expiresAt = payload.exp * 1000 - 30 * 1000;
  } catch { /* not a JWT: assume an hour */ }
  return { token, expiresAt };
}

// ---------- request ----------

/** A closed GeoJSON polygon around [west, south, east, north], grown by `pad` (0.2 = 20 % each way). */
export function bboxPolygon([w, s, e, n], pad = 0) {
  const dx = (e - w) * pad, dy = (n - s) * pad;
  const W = Math.max(-180, w - dx), E = Math.min(180, e + dx);
  const S = Math.max(-85, s - dy), N = Math.min(85, n + dy);
  return { type: 'Polygon', coordinates: [[[W, S], [E, S], [E, N], [W, N], [W, S]]] };
}

/** Body for POST latest/combined: full static data, plain JSON, inside the area, optionally only newer than `since`. */
export function latestRequest(bbox, since) {
  const body = { modelType: 'Full', modelFormat: 'Json', geometry: bboxPolygon(bbox) };
  if (since) body.since = new Date(since).toISOString();
  return body;
}

/** Is [west, south, east, north] `inner` inside `outer`? */
export const bboxInside = (inner, outer) => inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];

// ---------- decoding ----------

/** Ship type groups for colour and the legend (ITU-R M.1371 ship and cargo type, first digit mostly). */
export const TYPE_GROUPS = [
  { id: 'passenger', label: 'Passenger', color: '#2f6fd6' },
  { id: 'cargo', label: 'Cargo', color: '#2e9e5b' },
  { id: 'tanker', label: 'Tanker', color: '#c8432f' },
  { id: 'fishing', label: 'Fishing', color: '#d98a1c' },
  { id: 'tug', label: 'Tug, pilot, service', color: '#7b5cc4' },
  { id: 'highspeed', label: 'High speed', color: '#d1b21f' },
  { id: 'pleasure', label: 'Sailing, pleasure', color: '#c13fa1' },
  { id: 'military', label: 'Military, law enforcement', color: '#5b6670' },
  { id: 'other', label: 'Other, unknown', color: '#8b98a5' },
];
const GROUP = Object.fromEntries(TYPE_GROUPS.map((g) => [g.id, g]));

export function typeGroup(code) {
  const t = Number(code);
  if (t >= 60 && t <= 69) return GROUP.passenger;
  if (t >= 70 && t <= 79) return GROUP.cargo;
  if (t >= 80 && t <= 89) return GROUP.tanker;
  if (t === 30) return GROUP.fishing;
  if ([31, 32, 33, 50, 51, 52, 53, 54].includes(t)) return GROUP.tug;
  if (t >= 40 && t <= 49) return GROUP.highspeed;
  if (t === 36 || t === 37) return GROUP.pleasure;
  if (t === 35 || t === 55) return GROUP.military;
  return GROUP.other;
}

const TYPE_NAMES = {
  30: 'Fishing', 31: 'Towing', 32: 'Towing, large', 33: 'Dredging or underwater operations', 34: 'Diving operations',
  35: 'Military operations', 36: 'Sailing', 37: 'Pleasure craft', 50: 'Pilot vessel', 51: 'Search and rescue',
  52: 'Tug', 53: 'Port tender', 54: 'Anti-pollution', 55: 'Law enforcement', 58: 'Medical transport', 59: 'Non-combatant ship',
};
/** Readable ship type for an AIS ship and cargo type code. */
export function typeName(code) {
  const t = Number(code);
  if (!t) return 'Not given';
  if (TYPE_NAMES[t]) return TYPE_NAMES[t];
  const tens = Math.floor(t / 10);
  const cargo = ['', 'carrying dangerous goods (A)', 'carrying dangerous goods (B)', 'carrying dangerous goods (C)', 'carrying dangerous goods (D)'][t % 10] ?? '';
  const base = { 2: 'Wing in ground', 4: 'High speed craft', 6: 'Passenger', 7: 'Cargo', 8: 'Tanker', 9: 'Other' }[tens];
  return base ? `${base}${cargo ? `, ${cargo}` : ''}` : `Type ${t}`;
}

const NAV_STATUS = [
  'Under way using engine', 'At anchor', 'Not under command', 'Restricted manoeuvrability', 'Constrained by draught',
  'Moored', 'Aground', 'Engaged in fishing', 'Under way sailing', '', '', 'Towing astern', 'Pushing ahead or towing alongside',
  '', 'AIS-SART, MOB or EPIRB', '',
];
export const navStatusText = (s) => NAV_STATUS[Number(s)] || 'Not defined';

/** Heading to draw: true heading when given (511 = not available), else course over ground when moving. */
export function drawHeading(v) {
  if (Number.isFinite(v.trueHeading) && v.trueHeading >= 0 && v.trueHeading < 360) return v.trueHeading;
  if (Number.isFinite(v.courseOverGround) && v.courseOverGround < 360 && (v.speedOverGround ?? 0) > 0.5) return v.courseOverGround;
  return null;
}

/** Length, beam and where the GPS antenna sits, from the AIS reference dimensions (metres). */
export function vesselSize(v) {
  const a = v.dimensionA ?? 0, b = v.dimensionB ?? 0, c = v.dimensionC ?? 0, d = v.dimensionD ?? 0;
  const length = a + b > 0 ? a + b : v.shipLength ?? 0;
  const beam = c + d > 0 ? c + d : v.shipWidth ?? 0;
  // With no reference point given, assume the antenna amidships.
  const toBow = a + b > 0 ? a : length / 2;
  const toPort = c + d > 0 ? c : beam / 2;
  return { length, beam, toBow, toPort };
}

/** Draught in metres (AIS sends tenths of a metre; 0 = not given). */
export const draughtM = (v) => (v.draught > 0 ? v.draught / 10 : null);

/** Move a [lon, lat] point by metres north and east (fine for ship-sized offsets). */
function offset([lon, lat], north, east) {
  return [lon + (east / (R * Math.cos(rad(lat)))) * (180 / Math.PI), lat + (north / R) * (180 / Math.PI)];
}

/**
 * The ship's outline at true size and heading, placed so the reported position is where the antenna
 * is: a hull with a pointed bow, as a closed [lon, lat] ring. null when the size or heading is unknown.
 */
export function vesselOutline(v) {
  const hdg = drawHeading(v);
  const { length, beam, toBow, toPort } = vesselSize(v);
  if (hdg === null || !(length > 0) || !(beam > 0) || !Number.isFinite(v.latitude)) return null;
  // Ship frame: x forward from the antenna, y to starboard from the antenna.
  const fwd = toBow, aft = toBow - length, port = -toPort, stb = beam - toPort;
  const shoulder = fwd - Math.min(length * 0.18, beam * 1.4);
  const local = [[aft, port], [shoulder, port], [fwd, (port + stb) / 2], [shoulder, stb], [aft, stb], [aft, port]];
  const h = rad(hdg);
  return local.map(([x, y]) => offset([v.longitude, v.latitude], x * Math.cos(h) - y * Math.sin(h), x * Math.sin(h) + y * Math.cos(h)));
}

/** Minutes since the last position report. */
export const ageMinutes = (v, now = Date.now()) => (now - Date.parse(v.msgtime)) / 60000;

/** Merge a batch of reports into the map of vessels by MMSI, keeping the newest of each. */
export function mergeVessels(byMmsi, batch) {
  for (const v of batch) {
    if (!v?.mmsi || !Number.isFinite(v.latitude) || !Number.isFinite(v.longitude)) continue;
    const old = byMmsi.get(v.mmsi);
    if (!old || Date.parse(v.msgtime) >= Date.parse(old.msgtime)) byMmsi.set(v.mmsi, { ...old, ...v });
  }
  return byMmsi;
}

/** Forget vessels not heard from for `maxMinutes`. */
export function pruneVessels(byMmsi, now = Date.now(), maxMinutes = 120) {
  for (const [k, v] of byMmsi) if (ageMinutes(v, now) > maxMinutes) byMmsi.delete(k);
  return byMmsi;
}

/** GeoJSON for the map: one point per vessel (symbol and label) and one outline per vessel with a known size. */
export function toGeoJson(vessels, now = Date.now(), staleMinutes = 15) {
  const points = [], outlines = [];
  for (const v of vessels) {
    const g = typeGroup(v.shipType);
    const hdg = drawHeading(v);
    const props = {
      mmsi: v.mmsi, name: (v.name || '').trim() || String(v.mmsi), color: g.color, group: g.id,
      heading: hdg ?? 0, hasHeading: hdg !== null, moving: (v.speedOverGround ?? 0) > 0.5,
      stale: ageMinutes(v, now) > staleMinutes,
    };
    points.push({ type: 'Feature', id: v.mmsi, geometry: { type: 'Point', coordinates: [v.longitude, v.latitude] }, properties: props });
    const ring = vesselOutline(v);
    if (ring) outlines.push({ type: 'Feature', id: v.mmsi, geometry: { type: 'Polygon', coordinates: [ring] }, properties: props });
  }
  return { points: { type: 'FeatureCollection', features: points }, outlines: { type: 'FeatureCollection', features: outlines } };
}

// ---------- to the 3D model ----------

/** The ship inspector's vessel type for an AIS ship type and size. */
export function kindFromAis(code, length = 0, beam = 0) {
  const t = Number(code);
  if (t >= 60 && t <= 69) return length >= 200 ? 'cruise' : 'ferry';
  if (t >= 40 && t <= 49) return 'ferry';
  if (t >= 80 && t <= 89) return 'tanker';
  // AIS does not tell container ships from bulk or general cargo; very large and wide is most likely boxes.
  if (t >= 70 && t <= 79) return length >= 250 && beam >= 32 ? 'container' : 'cargo';
  if ([30, 31, 32, 33, 50, 51, 52, 53, 54].includes(t)) return 'tug';
  if (t === 35 || t === 55) return 'warship';
  if (t === 36) return 'sailing';
  if (t === 37) return 'yacht';
  return 'cargo';
}

/**
 * Hull parameters from an AIS report: length, beam and draught from AIS where given (marked 'ais'),
 * the rest estimated from typical ships of the type.
 */
export function hullFromAis(v) {
  const { length, beam } = vesselSize(v);
  const kind = kindFromAis(v.shipType, length, beam);
  const params = defaultParams(kind, length > 2 ? length : undefined);
  const sources = { length: length > 2 ? 'ais' : 'estimated', beam: 'estimated', draft: 'estimated', airDraft: 'estimated' };
  if (beam > 1) { params.beam = beam; sources.beam = 'ais'; }
  const t = draughtM(v);
  if (t && t < 30) { params.draft = t; sources.draft = 'ais'; }
  params.depth = Math.max(params.depth, params.draft + 1);
  params.seed = v.mmsi % 100000;
  return { params, sources };
}

// ---------- searching ships by name, MMSI, IMO number or call sign ----------

/** Text for comparing names: lower case, Norwegian letters spelt out, accents and punctuation dropped. */
export function foldName(s) {
  return String(s ?? '').toLowerCase()
    .replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Body for POST latest/combined asking for every ship heard in the last 24 hours (no area). */
export const directoryRequest = () => ({ modelType: 'Full', modelFormat: 'Json' });

/**
 * Ships matching what was typed, best first: a whole name, a name starting with it, a word of the
 * name starting with it, then anywhere in the name; numbers match MMSI and IMO numbers from the
 * start, and call signs match from the start too. At most `max`.
 */
export function matchVessels(list, query, max = 6) {
  const q = foldName(query);
  if (q.length < 2) return [];
  const digits = /^\d{3,}$/.test(q) ? q : null;
  const sign = String(query).trim().toUpperCase().replace(/\s+/g, '');
  const scored = [];
  for (const v of list) {
    if (!v?.mmsi || !Number.isFinite(v.latitude) || !Number.isFinite(v.longitude)) continue;
    const name = foldName(v.name);
    let score = 0;
    if (name === q) score = 100;
    else if (name.startsWith(q)) score = 80;
    else if (name.split(' ').some((w) => w.startsWith(q))) score = 60;
    else if (q.length >= 3 && name.includes(q)) score = 40;
    if (digits) {
      if (String(v.mmsi) === digits || String(v.imoNumber ?? '') === digits) score = Math.max(score, 100);
      else if (String(v.mmsi).startsWith(digits) || String(v.imoNumber ?? '').startsWith(digits)) score = Math.max(score, 50);
    }
    const cs = String(v.callSign ?? '').toUpperCase();
    if (cs && sign.length >= 3 && cs.startsWith(sign)) score = Math.max(score, cs === sign ? 90 : 45);
    if (score) scored.push([score, Date.parse(v.msgtime) || 0, v]);
  }
  // Best match first; among equals, the most recently heard.
  return scored.sort((a, b) => b[0] - a[0] || b[1] - a[1]).slice(0, max).map(([, , v]) => v);
}
