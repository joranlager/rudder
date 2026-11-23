// Marine information for a point at sea: depth (Kartverket), tide (Kartverket "Se havnivå"),
// waves, current and sea temperature (MET Norway oceanforecast) and wind (MET Norway locationforecast).
// URL builders and parsers are pure, so they are tested in Node; fetching is in app.js.

import { WMS } from './layers.js';

export const TIDE_API = 'https://vannstand.kartverket.no/tideapi.php';
export const OCEAN_API = 'https://api.met.no/weatherapi/oceanforecast/2.0/complete';
export const WEATHER_API = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';

// MET asks for at most 4 decimals (about 10 m), which also lets their cache work.
const r4 = (n) => Number(n.toFixed(4));

/** Local Norwegian wall-clock time as the tide API wants it: 2026-11-23T14:00. */
export function tideTime(ms) {
  const f = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false });
  return f.format(new Date(ms)).replace(' ', 'T');
}

/** Tide request: datatype 'all' gives the curve (prediction, observation, forecast), 'tab' the highs and lows. */
export function tideUrl(lat, lon, nowMs, datatype = 'all') {
  const p = new URLSearchParams({
    tide_request: 'locationdata', lat: String(r4(lat)), lon: String(r4(lon)),
    fromtime: tideTime(nowMs - 6 * 3600e3), totime: tideTime(nowMs + 30 * 3600e3),
    datatype, refcode: 'cd', lang: 'en', interval: '10', dst: '1',
  });
  return `${TIDE_API}?${p}`;
}

const attr = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

/** Parse the tide API's XML: the station and one series per data type, in cm above chart datum. */
export function parseTide(xml) {
  const loc = xml.match(/<location\b[^>]*>/)?.[0];
  if (!loc) return null;
  const station = { name: attr(loc, 'name'), code: attr(loc, 'code'),
    lat: Number(attr(loc, 'latitude')), lon: Number(attr(loc, 'longitude')), descr: attr(loc, 'descr') };
  const series = {};
  for (const m of xml.matchAll(/<data\b([^>]*)>([\s\S]*?)<\/data>/g)) {
    const type = attr(m[1], 'type');
    series[type] = [...m[2].matchAll(/<waterlevel\b[^>]*>/g)].map(([w]) => ({
      t: Date.parse(attr(w, 'time')), cm: Number(attr(w, 'value')), flag: attr(w, 'flag') ?? null,
    })).filter((p) => Number.isFinite(p.t) && Number.isFinite(p.cm));
  }
  return { station, datum: xml.match(/<reflevelcode>([^<]*)/)?.[1] ?? 'CD', series };
}

/** Value of a time series at a moment, linearly between neighbours; null outside it. */
export function valueAt(points, t) {
  if (!points?.length || t < points[0].t || t > points.at(-1).t) return null;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (t <= b.t) return b.t === a.t ? a.cm : a.cm + ((b.cm - a.cm) * (t - a.t)) / (b.t - a.t);
  }
  return null;
}

/** The tide now: best available level (forecast, else prediction), whether it is rising, next high and low. */
export function tideSummary(curve, extremes, now) {
  const s = curve?.series ?? {};
  const line = s.forecast?.length ? s.forecast : s.prediction;
  const level = valueAt(line, now);
  const soon = valueAt(line, now + 10 * 60e3);
  const ext = (extremes?.series?.prediction ?? []).filter((p) => p.t > now && (p.flag === 'high' || p.flag === 'low'));
  return {
    station: curve?.station ?? extremes?.station ?? null,
    levelCm: level,
    rising: level != null && soon != null ? soon > level : null,
    observedCm: valueAt(s.observation, now) ?? s.observation?.at(-1)?.cm ?? null,
    next: ext.slice(0, 2),
  };
}

/** The forecast step closest to now from a MET timeseries. */
export function nearestStep(json, now) {
  const ts = json?.properties?.timeseries;
  if (!ts?.length) return null;
  let best = ts[0], bestD = Infinity;
  for (const step of ts) {
    const d = Math.abs(Date.parse(step.time) - now);
    if (d < bestD) { best = step; bestD = d; }
  }
  return { time: Date.parse(best.time), ...best.data?.instant?.details };
}

export const oceanUrl = (lat, lon) => `${OCEAN_API}?lat=${r4(lat)}&lon=${r4(lon)}`;
export const weatherUrl = (lat, lon) => `${WEATHER_API}?lat=${r4(lat)}&lon=${r4(lon)}`;

/** GetFeatureInfo on the depth bands, for a tiny box around the point. */
export function depthUrl(lat, lon) {
  const d = 0.0005;
  const p = new URLSearchParams({
    service: 'WMS', version: '1.1.1', request: 'GetFeatureInfo', layers: 'Dybdelag', query_layers: 'Dybdelag',
    styles: '', srs: 'EPSG:4326', bbox: [lon - d, lat - d, lon + d, lat + d].map((n) => n.toFixed(6)).join(','),
    width: '11', height: '11', x: '5', y: '5', info_format: 'application/vnd.ogc.gml', feature_count: '10',
  });
  return `${WMS.depth}?${p}`;
}

/**
 * Depth band at the point from the GML answer, in metres below chart datum.
 * Several surveys can overlap; the narrowest band is the most detailed one.
 * Returns null when the point is not in any depth area (land, or not charted).
 */
export function parseDepth(gml) {
  const bands = [...gml.matchAll(/<Dybdelag_feature>([\s\S]*?)<\/Dybdelag_feature>/g)].map(([, f]) => ({
    min: Number(f.match(/<minimumsdybde>([^<]*)/)?.[1]),
    max: Number(f.match(/<maksimumsdybde>([^<]*)/)?.[1]),
    updated: f.match(/<oppdateringsdato>(\d{4}-\d\d-\d\d)/)?.[1] ?? null,
  })).filter((b) => Number.isFinite(b.min));
  if (!bands.length) return null;
  const width = (b) => (Number.isFinite(b.max) ? b.max - b.min : Infinity);
  return bands.sort((a, b) => width(a) - width(b) || b.min - a.min)[0];
}

export function formatDepth(band) {
  if (!band) return 'Land, or no depth data';
  if (band.min < 0) return `Dries (${-band.min} m above datum)`;
  return Number.isFinite(band.max) ? `${band.min}–${band.max} m` : `over ${band.min} m`;
}

/** Place search in Kartverket's place-name register. */
export const placeUrl = (q) =>
  `https://ws.geonorge.no/stedsnavn/v1/navn?${new URLSearchParams({ sok: `${q}*`, treffPerSide: '8', utkoordsys: '4258' })}`;

export function parsePlaces(json) {
  return (json?.navn ?? []).map((n) => ({
    name: n['skrivemåte'],
    type: n.navneobjekttype,
    where: [n.kommuner?.[0]?.kommunenavn, n.fylker?.[0]?.fylkesnavn].filter(Boolean).join(', '),
    lat: n.representasjonspunkt?.nord,
    lon: n.representasjonspunkt?.['øst'],
  })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
}
