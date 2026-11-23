import { BASEMAPS, OVERLAYS, buildStyle, mergeSettings } from './layers.js';
import { formatPosition, compassPoint, msToKnots } from './nav.js';
import {
  tideUrl, parseTide, tideSummary, oceanUrl, weatherUrl, nearestStep, depthUrl, parseDepth, formatDepth,
  placeUrl, parsePlaces,
} from './marine.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const STORE_KEY = 'rudder.map.v1';

// ---------- settings (remembered on this device) ----------
function loadSettings() {
  try { return mergeSettings(JSON.parse(localStorage.getItem(STORE_KEY))); } catch { return mergeSettings(null); }
}
let settings = loadSettings();
const saveSettings = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch { /* private mode */ } };

// ---------- map ----------
const map = new maplibregl.Map({
  container: 'map',
  style: buildStyle(settings),
  center: [5.55, 59.0], // Boknafjorden, off Stavanger
  zoom: 9,
  hash: 'at',
  maxZoom: 19,
  attributionControl: false,
  dragRotate: true,
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-left');
map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'nautical' }), 'bottom-left');
map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');
map.addControl(new maplibregl.AttributionControl({
  compact: true,
  customAttribution: 'Open data under <a href="https://data.norge.no/nlod/en/2.0" target="_blank" rel="noopener">NLOD</a> / CC BY 4.0 · Ocean and weather © <a href="https://www.met.no/" target="_blank" rel="noopener">MET Norway</a>',
}), 'bottom-right');
map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true } }), 'top-left');

// ---------- layer panel ----------
function renderLayerPanel() {
  $('#basemaps').innerHTML = BASEMAPS.map((b) => `
    <label class="opt"><input type="radio" name="basemap" value="${b.id}" ${settings.basemap === b.id ? 'checked' : ''}>
      <span>${esc(b.name)}</span><small>${esc(b.note)}</small></label>`).join('');
  const groups = [...new Set(OVERLAYS.map((o) => o.group))];
  $('#overlays').innerHTML = groups.map((g) => `<section><h3>${esc(g)}</h3>${OVERLAYS.filter((o) => o.group === g).map((o) => {
    const s = settings.overlays[o.id];
    return `<div class="opt" data-overlay="${o.id}">
      <input type="checkbox" id="ov-${o.id}" ${s.on ? 'checked' : ''}>
      <label for="ov-${o.id}">${esc(o.name)}</label>
      <small>${esc(o.note)}</small>
      <span class="zoomhint" data-minzoom="${o.minzoom}" hidden>Zoom in to see it (from zoom ${o.minzoom})</span>
      <input type="range" min="0" max="1" step="0.05" value="${s.opacity}" aria-label="${esc(o.name)} opacity" ${s.on ? '' : 'hidden'}>
    </div>`;
  }).join('')}</section>`).join('');
  updateZoomHints();
}

$('#basemaps').addEventListener('change', (e) => {
  settings.basemap = e.target.value;
  for (const b of BASEMAPS) map.setLayoutProperty(b.id, 'visibility', b.id === settings.basemap ? 'visible' : 'none');
  saveSettings();
});
$('#overlays').addEventListener('input', (e) => {
  const row = e.target.closest('[data-overlay]');
  if (!row) return;
  const id = row.dataset.overlay, s = settings.overlays[id];
  if (e.target.type === 'checkbox') {
    s.on = e.target.checked;
    map.setLayoutProperty(id, 'visibility', s.on ? 'visible' : 'none');
    row.querySelector('input[type=range]').hidden = !s.on;
    updateZoomHints();
  } else {
    s.opacity = Number(e.target.value);
    map.setPaintProperty(id, 'raster-opacity', s.opacity);
  }
  saveSettings();
});
function updateZoomHints() {
  const z = map.getZoom();
  for (const h of document.querySelectorAll('.zoomhint')) {
    const on = settings.overlays[h.closest('[data-overlay]').dataset.overlay].on;
    h.hidden = !on || z >= Number(h.dataset.minzoom);
  }
}

function togglePanel(id, open) {
  const el = $(`#${id}`);
  el.hidden = open === undefined ? !el.hidden : !open;
  if (id === 'layers') $('#layers-btn').setAttribute('aria-expanded', String(!el.hidden));
  if (id === 'info' && el.hidden) clearClick();
}
$('#layers-btn').addEventListener('click', () => togglePanel('layers'));
document.addEventListener('click', (e) => { const c = e.target.closest('[data-close]'); if (c) togglePanel(c.dataset.close, false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { togglePanel('layers', false); togglePanel('info', false); } });

// ---------- pointer readout ----------
const showZoom = () => { $('#zoom').textContent = `z${map.getZoom().toFixed(1)}`; updateZoomHints(); };
map.on('zoom', showZoom);
map.on('mousemove', (e) => { $('#cursor').textContent = formatPosition(e.lngLat.lat, e.lngLat.lng); });
map.on('load', () => { map.resize(); showZoom(); });
// Some embedders size the page after the map has measured it; measure again when the window settles.
window.addEventListener('resize', () => map.resize());
window.addEventListener('pageshow', () => map.resize());

// ---------- marine information for a tapped point ----------
let clickMarker = null, clickSeq = 0;
function clearClick() { clickMarker?.remove(); clickMarker = null; clickSeq++; }

async function getText(url, signal) {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}
async function getJson(url, signal) { return JSON.parse(await getText(url, signal)); }

const fmtTime = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Oslo' });
const fmtDay = (t) => new Date(t).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'Europe/Oslo' });
const arrow = (toDeg) => `<span class="arrow" style="transform:rotate(${Math.round(toDeg)}deg)">↑</span>`;

function section(id, title) { return `<h3>${title}</h3><div id="${id}"><span class="loading">Loading…</span></div>`; }
function fill(id, seq, html) { if (seq === clickSeq) { const el = document.getElementById(id); if (el) el.innerHTML = html; } }
const fail = (e) => `<span class="err">Not available (${esc(e.message)})</span>`;

async function showPoint(lngLat) {
  const seq = ++clickSeq;
  const { lat, lng: lon } = lngLat;
  if (!clickMarker) {
    const el = document.createElement('div'); el.className = 'click-marker';
    clickMarker = new maplibregl.Marker({ element: el });
  }
  clickMarker.setLngLat([lon, lat]).addTo(map);
  $('#info-title').textContent = 'At this position';
  $('#info-body').innerHTML = `<p class="pos">${formatPosition(lat, lon)}</p>
    ${section('i-depth', 'Depth (chart datum)')}${section('i-tide', 'Tide')}
    ${section('i-sea', 'Sea now')}${section('i-wind', 'Weather now')}`;
  togglePanel('info', true);
  const now = Date.now();

  getText(depthUrl(lat, lon)).then((gml) => {
    const band = parseDepth(gml);
    fill('i-depth', seq, `<dl class="rows"><dt>Depth band</dt><dd>${formatDepth(band)}</dd>
      ${band?.updated ? `<dt>Updated</dt><dd>${band.updated}</dd>` : ''}</dl>
      <div class="src">Kartverket depth data (dybdedata). Public grids are coarse inside 12 nm.</div>`);
  }).catch((e) => fill('i-depth', seq, fail(e)));

  Promise.all([getText(tideUrl(lat, lon, now, 'all')), getText(tideUrl(lat, lon, now, 'tab'))]).then(([a, b]) => {
    const curve = parseTide(a), ext = parseTide(b);
    if (!curve) throw new Error('no station');
    const s = tideSummary(curve, ext, now), st = s.station;
    // The API answers for the tapped point itself, derived from the named reference station.
    fill('i-tide', seq, `<dl class="rows">
      <dt>Level</dt><dd>${s.levelCm == null ? '–' : `${(s.levelCm / 100).toFixed(2)} m`} ${s.rising == null ? '' : s.rising ? '▲ rising' : '▼ falling'}</dd>
      ${s.observedCm != null ? `<dt>Observed</dt><dd>${(s.observedCm / 100).toFixed(2)} m</dd>` : ''}
      ${s.next.map((p) => `<dt>${p.flag === 'high' ? 'High' : 'Low'}</dt><dd>${fmtDay(p.t)} ${fmtTime(p.t)} · ${(p.cm / 100).toFixed(2)} m</dd>`).join('')}
      <dt>Reference</dt><dd>${esc(st.name)}${st.code ? ` (${esc(st.code)})` : ''}</dd></dl>
      ${tideGraph(curve, now)}<div class="src">Kartverket, Se havnivå. Above chart datum (CD).</div>`);
  }).catch((e) => fill('i-tide', seq, fail(e)));

  getJson(oceanUrl(lat, lon)).then((j) => {
    const d = nearestStep(j, now);
    if (!d || d.sea_surface_wave_height == null) throw new Error('outside the ocean model');
    fill('i-sea', seq, `<dl class="rows">
      <dt>Waves</dt><dd>${d.sea_surface_wave_height.toFixed(1)} m from ${compassPoint(d.sea_surface_wave_from_direction)} (${Math.round(d.sea_surface_wave_from_direction)}°)</dd>
      ${d.sea_water_speed != null ? `<dt>Current</dt><dd>${arrow(d.sea_water_to_direction)} ${msToKnots(d.sea_water_speed).toFixed(1)} kn towards ${Math.round(d.sea_water_to_direction)}°</dd>` : ''}
      ${d.sea_water_temperature != null ? `<dt>Sea temp.</dt><dd>${d.sea_water_temperature.toFixed(1)} °C</dd>` : ''}
      <dt>Valid</dt><dd>${fmtTime(d.time)}</dd></dl><div class="src">MET Norway oceanforecast.</div>`);
  }).catch((e) => fill('i-sea', seq, fail(e)));

  getJson(weatherUrl(lat, lon)).then((j) => {
    const d = nearestStep(j, now);
    if (!d) throw new Error('no forecast');
    fill('i-wind', seq, `<dl class="rows">
      <dt>Wind</dt><dd>${arrow((d.wind_from_direction + 180) % 360)} ${msToKnots(d.wind_speed).toFixed(0)} kn (${d.wind_speed.toFixed(1)} m/s) from ${compassPoint(d.wind_from_direction)}</dd>
      <dt>Air</dt><dd>${d.air_temperature?.toFixed(1)} °C · ${Math.round(d.air_pressure_at_sea_level)} hPa</dd>
      <dt>Valid</dt><dd>${fmtTime(d.time)}</dd></dl><div class="src">MET Norway locationforecast.</div>`);
  }).catch((e) => fill('i-wind', seq, fail(e)));
}

/** Small SVG of the tide curve for the next hours, with "now" marked and observations as dots. */
function tideGraph(curve, now) {
  const line = curve.series.forecast?.length ? curve.series.forecast : curve.series.prediction;
  if (!line?.length) return '';
  const pts = [...line, ...(curve.series.observation ?? [])];
  const t0 = line[0].t, t1 = line.at(-1).t;
  const lo = Math.min(...pts.map((p) => p.cm)), hi = Math.max(...pts.map((p) => p.cm));
  const W = 300, H = 70, x = (t) => ((t - t0) / (t1 - t0)) * W, y = (cm) => H - 12 - ((cm - lo) / (hi - lo || 1)) * (H - 20);
  const d = line.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.cm).toFixed(1)}`).join('');
  const obs = (curve.series.observation ?? []).filter((_, i) => i % 3 === 0)
    .map((p) => `<circle cx="${x(p.t).toFixed(1)}" cy="${y(p.cm).toFixed(1)}" r="1.4" fill="currentColor"/>`).join('');
  return `<svg class="tide-graph" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Tide curve">
    <path class="fill" d="${d}L${W},${H}L0,${H}Z"/><path class="curve" d="${d}"/>${obs}
    <line class="now" x1="${x(now)}" x2="${x(now)}" y1="0" y2="${H}"/>
    <text x="2" y="${H - 1}">${fmtTime(t0)}</text><text x="${W - 2}" y="${H - 1}" text-anchor="end">${fmtTime(t1)}</text></svg>`;
}

map.on('click', (e) => showPoint(e.lngLat));

// ---------- place search ----------
let searchTimer = 0, searchCtl = null, results = [], active = -1;
const input = $('#search-input'), list = $('#search-results');
function renderResults() {
  list.hidden = !results.length;
  list.innerHTML = results.map((p, i) => `<li role="option" data-i="${i}" aria-selected="${i === active}">
    ${esc(p.name)}<small>${esc(p.type)} · ${esc(p.where)}</small></li>`).join('');
}
function choose(p) {
  results = []; renderResults(); input.blur();
  map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 12) });
  map.once('moveend', () => showPoint({ lat: p.lat, lng: p.lon }));
}
input.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = input.value.trim();
  if (q.length < 2) { results = []; renderResults(); return; }
  searchTimer = setTimeout(async () => {
    searchCtl?.abort(); searchCtl = new AbortController();
    try { results = parsePlaces(await getJson(placeUrl(q), searchCtl.signal)); active = -1; renderResults(); } catch { /* aborted or offline */ }
  }, 250);
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % Math.max(results.length, 1);
    renderResults();
  }
});
$('#search').addEventListener('submit', (e) => { e.preventDefault(); const p = results[Math.max(active, 0)]; if (p) choose(p); });
list.addEventListener('click', (e) => { const li = e.target.closest('li'); if (li) choose(results[Number(li.dataset.i)]); });
input.addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 150));
input.addEventListener('focus', () => { list.hidden = !results.length; });

renderLayerPanel();

// The simulator (vessel, controls) builds on this map; expose it for development in the console.
window.rudder = { map, settings, showPoint };
