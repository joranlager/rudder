// Open webcams on the map: Statens vegvesen's road, ferry-quay and bridge cameras (about 900), from
// its open WFS (GeoServer, NLOD, answers any website; checked 2026-11-25), with where each looks.
//
// The cameras do not publish a compass bearing (DATEX's `bearing` is empty for every one); each says
// instead which place it looks towards (ORIENTATION_DESCRIPTION: "Stamsund", "mot Eggedal", "nord").
// scripts/webcams.mjs looks those places up in Kartverket's place-name register and stores the bearing
// from the camera to the place in public/webcams.json; the view can be fine-tuned on the device.
//
// Pure (no MapLibre, no DOM), so the parsing, directions and the projection of ships into a camera's
// picture are unit tested. The map layer is webcamlayer.js; the view with ships on it webcamview.js.

import { distanceM, bearingDeg } from './nav.js';

export const WFS = 'https://ogckart-sn1.atlas.vegvesen.no/datex_3_1/wfs';
export const ATTRIBUTION = 'Webcams © <a href="https://www.vegvesen.no/trafikkinformasjon/reiseinformasjon/webkamera/" target="_blank" rel="noopener">Statens vegvesen</a> (NLOD)';
export const DEFAULT_FOV = 60; // degrees across the picture: road cameras are mostly wide (AXIS P13xx: 35-97°)
export const DEFAULT_TILT = 2; // degrees below level: road cameras look a little down
export const MAST = 6; // metres from the ground the camera stands on to its lens
export const SECTOR_MIN_M = 800, SECTOR_MAX_M = 6000;
export const SHIP_RANGE_M = 15000; // ships further than this are not put on a picture

/** GetFeature for every camera, as GeoJSON (only the fields used). */
export function camerasUrl() {
  return `${WFS}?${new URLSearchParams({
    service: 'WFS', request: 'GetFeature', version: '2.0.0', typeNames: 'datex_3_1:CctvSimple_v2', outputFormat: 'application/json',
  })}`;
}

/** The WFS answer as cameras: { id, site, name, looks, lat, lon, image, video, ok, road, forecast }. */
export function parseCameras(json) {
  const out = [];
  for (const f of json?.features ?? []) {
    const p = f.properties ?? {};
    const [lon, lat] = f.geometry?.coordinates ?? [];
    const id = String(p.CAMERA_ID ?? p.RECORD_ID ?? '');
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon) || !p.STILL_IMAGE_URL) continue;
    out.push({
      id,
      site: id.replace(/_\d+$/, ''), // one site can have several cameras: 3000072_1, 3000072_2
      name: String(p.DESCRIPTION ?? id).trim(),
      looks: String(p.ORIENTATION_DESCRIPTION ?? '').trim(),
      lat, lon,
      image: String(p.STILL_IMAGE_URL).replace(/^http:/, 'https:'),
      video: Number(p.VIDEO_SERVICE_LEVEL) > 0,
      ok: p.STATUS_STILL_IMAGE_AVAILABILITY !== 'videoOrImagesUnavailableDueToCameraFault',
      road: p.ROAD_NUMBER ?? '',
      forecast: p.STILL_IMAGE_URL_DESCRIPTION ?? '',
    });
  }
  return out;
}

// ---------- where a camera looks ----------

const COMPASS = {
  nord: 0, nordøst: 45, øst: 90, sørøst: 135, sør: 180, sørvest: 225, vest: 270, nordvest: 315,
  nordover: 0, østover: 90, sørover: 180, vestover: 270,
  north: 0, east: 90, south: 180, west: 270, n: 0, ø: 90, s: 180, v: 270, no: 45, nø: 45, so: 135, sø: 135, sv: 225, nv: 315,
};
/** Words that name no place: a camera that turns, a generic target, the country over the border. */
const NO_PLACE = /^(skifter|roterer|varierer|ukjent|sentrum|ferjekai(en)?|kai(en)?|tunnel.*|veg(en)?|vei(en)?|krysset|rundkjøring(en)?|parkering(splass)?|bomstasjon(en)?|finland|sverige|russland|xe\d+|e\d+|rv\.?\s*\d+|fv\.?\s*\d+)$/i;

/**
 * What a camera's orientation text asks for: { bearing } for a compass word, { place } for a place
 * name to look up, or null when it names neither.
 */
export function readLooks(text) {
  let t = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (!t) return null;
  t = t.replace(/^(mot|retning|i retning|mot\s+retning|direction|towards)\s+/i, '').replace(/[.,;]+$/, '').trim();
  // "Rosten/E6", "Forus / E39": the place, not the road; "E134 Notodden": the road number goes
  t = t.split(/\s*\/\s*/).find((x) => !/^(e|rv|fv|xe)\.?\s*\d+$/i.test(x)) ?? t;
  t = t.replace(/^(e|rv|fv)\.?\s*\d+\s+/i, '');
  // "Nesvik fk", "Fodnes FK": the ferry quay (ferjekai) of that place
  t = t.replace(/\s+(fk|ferjekai|ferjeleie|kai)$/i, '').trim();
  const lower = t.toLowerCase();
  if (lower in COMPASS) return { bearing: COMPASS[lower] };
  if (NO_PLACE.test(t) || t.length < 2 || /^\d+$/.test(t)) return null;
  return { place: t };
}

/**
 * Of the places with that name (Kartverket's answers: { name, lat, lon, type }), the one this camera
 * looks to: the nearest that is further than 150 m (the camera's own site is often named the same)
 * and within 150 km. null when none fits.
 */
export function pickPlace(cam, places, name = null) {
  // The name itself first ("Stamsund", not "Stamsund kirke"), then places whose name starts with it.
  const same = name ? places.filter((p) => p.name?.toLowerCase() === name.toLowerCase()) : [];
  if (same.length) {
    const hit = pickPlace(cam, same);
    if (hit) return hit;
  }
  let best = null;
  for (const p of places) {
    const d = distanceM(cam.lat, cam.lon, p.lat, p.lon);
    if (d < 150 || d > 150_000) continue;
    if (!best || d < best.d) best = { ...p, d };
  }
  return best;
}

/** How sure a direction is, from how far its place is: near places pin it down; far ones are roughly along the road. */
export function directionQuality(distance) {
  return distance < 15_000 ? 'good' : distance < 60_000 ? 'rough' : 'very rough';
}

/** A camera's direction from its place: { bearing, target, distance, quality }. */
export function directionTo(cam, place) {
  const distance = distanceM(cam.lat, cam.lon, place.lat, place.lon);
  return { bearing: Math.round(bearingDeg(cam.lat, cam.lon, place.lat, place.lon) * 10) / 10, target: place.name, distance: Math.round(distance), quality: directionQuality(distance) };
}

/**
 * The camera with its view: the direction worked out ahead of time (webcams.json, by id), with what was
 * set on this device over it (calibration, by id). `view` { bearing|null, fov, tilt, height, target,
 * quality, distance, own }: own = set on this device.
 */
export function withView(cam, directions = {}, calibration = {}) {
  const d = directions[cam.id] ?? {};
  const c = calibration[cam.id] ?? {};
  const bearing = Number.isFinite(c.bearing) ? c.bearing : Number.isFinite(d.bearing) ? d.bearing : null;
  return {
    ...cam,
    view: {
      bearing,
      fov: Number.isFinite(c.fov) ? c.fov : DEFAULT_FOV,
      tilt: Number.isFinite(c.tilt) ? c.tilt : DEFAULT_TILT,
      height: Number.isFinite(c.height) ? c.height : Math.max(2, (Number.isFinite(d.ground) ? d.ground : 0) + MAST),
      target: d.target ?? null,
      targetBearing: Number.isFinite(d.bearing) ? d.bearing : null, // as worked out: the mark to line the view up by
      quality: Number.isFinite(c.bearing) ? 'set here' : d.quality ?? (bearing === null ? 'unknown' : 'rough'),
      distance: d.distance ?? null,
      own: Number.isFinite(c.bearing) || Number.isFinite(c.fov) || Number.isFinite(c.tilt) || Number.isFinite(c.height),
    },
  };
}

/** Calibration from the device's storage, kept only where it makes sense. */
export function cleanCalibration(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, c] of Object.entries(raw)) {
    if (!c || typeof c !== 'object') continue;
    const k = {};
    if (Number.isFinite(c.bearing)) k.bearing = ((c.bearing % 360) + 360) % 360;
    if (Number.isFinite(c.fov)) k.fov = Math.min(150, Math.max(5, c.fov));
    if (Number.isFinite(c.tilt)) k.tilt = Math.min(45, Math.max(-20, c.tilt));
    if (Number.isFinite(c.height)) k.height = Math.min(2000, Math.max(0.5, c.height));
    if (Object.keys(k).length) out[id] = k;
  }
  return out;
}

// ---------- on the map ----------

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** The point `m` metres from (lat, lon) on bearing `b`. */
export function destination(lat, lon, b, m) {
  const d = m / R, br = rad(b), la = rad(lat), lo = rad(lon);
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(br));
  const lo2 = lo + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return [deg(lo2), deg(la2)];
}

/** How far a camera's sector is drawn: to its place when that is near, else a few kilometres. */
export function sectorRange(view) {
  return Math.min(SECTOR_MAX_M, Math.max(SECTOR_MIN_M, view.distance ?? 3000));
}

/** The camera's sector as a closed [lon, lat] ring: from the camera out to `range` across its field of view. */
export function sectorRing(cam, range = sectorRange(cam.view)) {
  const { bearing, fov } = cam.view;
  const ring = [[cam.lon, cam.lat]];
  const steps = Math.max(8, Math.ceil(fov / 3));
  for (let i = 0; i <= steps; i++) ring.push(destination(cam.lat, cam.lon, bearing - fov / 2 + (fov * i) / steps, range));
  ring.push([cam.lon, cam.lat]);
  return ring;
}

/** Cameras as map points, with the bearing to turn the icon (and whether there is one). */
export function camerasGeoJson(cams) {
  return {
    type: 'FeatureCollection',
    features: cams.map((c) => ({
      type: 'Feature',
      properties: { id: c.id, name: c.name, bearing: c.view.bearing ?? 0, known: c.view.bearing !== null, ok: c.ok },
      geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
    })),
  };
}

// ---------- ships on the picture ----------

/** Angle from a to b in degrees, -180..180. */
export const relAngle = (b, a) => ((((b - a) % 360) + 540) % 360) - 180;

/**
 * Where a ship is in a camera's picture, as fractions of its width and height (0..1 from the left and
 * top): a pinhole camera turned to view.bearing and tilted view.tilt below level, view.fov across, the
 * picture `aspect` wide to high. The ship stands at `at` ({ lat, lon }), `size` { length, beam, height }
 * metres, heading `heading`. Returns { x, y (waterline), top (highest point), half (half its width),
 * distance, bearing, rel, inView } or null without a bearing.
 */
export function projectShip(cam, at, size = {}, heading = null, aspect = 4 / 3) {
  const v = cam.view;
  if (v.bearing === null || v.bearing === undefined) return null;
  const distance = distanceM(cam.lat, cam.lon, at.lat, at.lon);
  const bearing = bearingDeg(cam.lat, cam.lon, at.lat, at.lon);
  const rel = relAngle(bearing, v.bearing);
  const hf = Math.tan(rad(v.fov / 2));
  const vf = hf / aspect; // tan of half the vertical field
  // Across: tan of the angle off the axis (a flat picture).
  const x = 0.5 + Math.tan(rad(Math.max(-89, Math.min(89, rel)))) / hf / 2;
  // Down: the waterline lies below level by the camera's height over that distance, plus the earth's curve.
  const d = Math.max(distance, 1);
  const drop = (h) => deg(Math.atan((v.height - h) / d + d / (2 * R)));
  const toY = (a) => 0.5 + Math.tan(rad(a - v.tilt)) / vf / 2;
  const height = size.height > 0 ? size.height : Math.max(4, (size.length || 20) * 0.22);
  const length = size.length > 0 ? size.length : 20, beam = size.beam > 0 ? size.beam : length / 6;
  // How wide it looks: its length across the line of sight, and its beam along it.
  const across = Number.isFinite(heading) ? Math.abs(Math.sin(rad(heading - bearing))) * length + Math.abs(Math.cos(rad(heading - bearing))) * beam : length * 0.7;
  const a = deg(Math.atan(across / 2 / d)), lim = (t) => rad(Math.max(-89, Math.min(89, t)));
  const half = (Math.tan(lim(rel + a)) - Math.tan(lim(rel - a))) / hf / 4;
  const inView = Math.abs(rel) < v.fov / 2 + a && distance > 10 && distance <= SHIP_RANGE_M;
  return { x, y: toY(drop(0)), top: toY(drop(height)), half, distance, bearing, rel, inView };
}

/** Where an angle below level (degrees) falls in the picture, from the top (0..1). */
export function pictureY(view, below, aspect = 4 / 3) {
  const vf = Math.tan(rad(view.fov / 2)) / aspect;
  return 0.5 + Math.tan(rad(below - view.tilt)) / vf / 2;
}

/** Where a bearing falls across the picture (0..1 from the left), or null when outside it. */
export function pictureX(view, bearing) {
  if (view.bearing === null) return null;
  const rel = relAngle(bearing, view.bearing);
  if (Math.abs(rel) >= Math.min(89, view.fov / 2)) return null;
  return 0.5 + Math.tan(rad(rel)) / Math.tan(rad(view.fov / 2)) / 2;
}

/** The sea's horizon seen from `height` metres: degrees below level. */
export const horizonDip = (height) => deg(Math.sqrt((2 * Math.max(0, height)) / R));
