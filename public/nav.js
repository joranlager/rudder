// Navigation helpers: positions in seaman's notation, nautical miles, bearings.

export const NM = 1852; // metres in one nautical mile
const R = 6371008.8;    // mean earth radius, metres
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** Great-circle distance in metres. */
export function distanceM(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial true bearing from point 1 to point 2, 0-360 degrees. */
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** One coordinate as degrees and decimal minutes: 59°58.123'N. */
export function formatDM(value, axis) {
  const hemi = axis === 'lat' ? (value < 0 ? 'S' : 'N') : (value < 0 ? 'W' : 'E');
  const abs = Math.abs(value);
  let d = Math.floor(abs);
  let m = Number(((abs - d) * 60).toFixed(3));
  if (m >= 60) { d += 1; m = 0; }
  const dd = String(d).padStart(axis === 'lat' ? 2 : 3, '0');
  return `${dd}°${m.toFixed(3).padStart(6, '0')}'${hemi}`;
}

export const formatPosition = (lat, lon) => `${formatDM(lat, 'lat')} ${formatDM(lon, 'lon')}`;

/** Distance for a chart reader: cables (0.1 nm) are shown as metres, longer as nm. */
export function formatDistance(m) {
  if (m < NM / 2) return `${Math.round(m)} m`;
  const nm = m / NM;
  return `${nm < 10 ? nm.toFixed(2) : nm.toFixed(1)} nm`;
}

/** Compass point (16-wind) for a bearing in degrees. */
export function compassPoint(d) {
  const pts = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return pts[Math.round((((d % 360) + 360) % 360) / 22.5) % 16];
}

export const msToKnots = (ms) => ms * 3600 / NM;
