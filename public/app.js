import { BASEMAPS, OVERLAYS, buildStyle, mergeSettings } from './layers.js';
import { formatPosition, compassPoint, msToKnots } from './nav.js';
import { createAisLayer } from './aismap.js';
import { createBridgeView } from './pov.js';
import { createHelm } from './helm.js';
import { openTrackStore } from './trackstore.js';
import { createRecorder } from './recorder.js';
import { createPlayback } from './playback.js';
import { createTracker } from './tracker.js';
import { createLiveTraces } from './livetraces.js';
import { createLandHeights, TILT as TERRAIN_TILT } from './landheights.js';
import { createInfra } from './infralayer.js';
import { createWebcams } from './webcamlayer.js';
import { createWebcamView, shipsInView } from './webcamview.js';
import { createFarView } from './farview.js';
import { DEM_MIN_ZOOM } from './terrain.js';
import { modelPlacement } from './shipmodels.js';
import { createSettings } from './settings.js';
import { enableLogoReload } from './reload.js';
import { readHandoff, shortcutUrl } from './handoff.js';
import { typeName, navStatusText, draughtM, vesselSize, ageMinutes } from './ais.js';
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

// Back from the Shortcuts app with a BarentsWatch token (handoff.js)? Take it out of the address
// before the map reads it, so the chart opens where it was and the token is not left in the history.
const handoff = readHandoff(location.href);
if (handoff) history.replaceState(null, '', handoff.cleanUrl);

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

// Ships from AIS (BarentsWatch), drawn over the chart when switched on in the layers panel.
const ais = createAisLayer(map);
// Land heights in 3D (landheights.js), switched in the layers panel and remembered.
const land = createLandHeights(map, { basemapIds: BASEMAPS.map((b) => b.id), onError: (m) => console.warn(m) });
if (settings.terrain) land.setOn(true);
// Roads, bridges and buildings (infralayer.js), over the background and overlays, under the ships.
const infra = createInfra(map, { belowIds: [...BASEMAPS, ...OVERLAYS].map((x) => x.id), onError: (m) => console.warn(m) });
if (settings.infra) infra.setOn(true);
// View from the bridge of a ship (pov.js), from its card.
const far = createFarView(map);
let helm = null; // the helm of a ship, once taken (helm.js); created below, after the bridge view
const bridge = createBridgeView(map, {
  ais,
  bar: $('#bridge-bar'),
  far,
  onEnter: () => { togglePanel('info', false); togglePanel('layers', false); togglePanel('settings', false); land.setTrueScale(true); far.setLand(land.on); },
  onExit: (message) => { land.setTrueScale(false); if (message && !helm?.active) alert(message); },
});
// The Ships tracker: every ship's positions recorded on this device, and played back (tracker.js).
const trackStore = openTrackStore();
trackStore.catch((e) => console.warn('track store:', e.message));
let tracker = null;
const recorder = createRecorder({ ais, storePromise: trackStore, onChange: () => tracker?.render() });
const playback = createPlayback(map, {
  ais, storePromise: trackStore,
  onTick: () => tracker?.tick(),
  onEnd: () => tracker?.render(),
});
// Traces behind live ships (livetraces.js), rebuilt from the recording after a reload when there is one.
const liveTraces = createLiveTraces(map, { ais, storePromise: trackStore });
tracker = createTracker($('#tracker-body'), { recorder, playback, liveTraces, storePromise: trackStore, canRecord: () => ais.canSearch() });
// Taking the helm of a ship: the bridge console (helm.js).
helm = createHelm(map, { ais, bridge, el: $('#helm'), onStatus: (m) => console.info(m) });
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-bridge-helm]') && bridge.mmsi !== null) {
    const v = ais.vessel(bridge.mmsi);
    if (v) helm.take(v);
  }
});
// Webcams (webcamlayer.js): open cameras turned the way they look; tap one for its sector and card, its
// eye for the view through it with the ships on it (webcamview.js).
const webcams = createWebcams(map, { onView: (c) => webcamView.enter(c), onError: (m) => alert(m) });
const webcamView = createWebcamView(map, {
  el: $('#webcam-view'), ais, webcams,
  onEnter: () => { togglePanel('info', false); togglePanel('layers', false); togglePanel('settings', false); togglePanel('tracker', false); },
  onExit: (c) => { if (webcams.on) { webcams.select(c.id); showWebcam(webcams.camerasAt(map.project([c.lon, c.lat])), c.id); } },
  onShip: (v) => showVessel(v),
});
if (settings.webcams) webcams.setOn(true);
webcams.onChange(() => { const c = webcams.selected; if (c && !$('#info').hidden && $('#info-body [data-webcam]')) showWebcam(webcams.camerasAt(map.project([c.lon, c.lat])), c.id); });

// Settings: BarentsWatch access, kept on this device.
const settingsPanel = createSettings($('#settings-body'), { ais, openPanel: () => togglePanel('settings', true) });
// Getting a BarentsWatch token: Shortcuts (iPhone, iPad, Mac), the bookmark on BarentsWatch (any
// browser, bwlogin.js), or "Get a new token", which picks the way that suits this device.
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-shortcut]')) location.href = shortcutUrl(location.href);
  else if (e.target.closest('[data-bwlogin]')) settingsPanel.bookmarkLogin();
  else if (e.target.closest('[data-renew]')) settingsPanel.renew();
});

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
  $('#terrain-settings').innerHTML = `<h3>Land</h3>
    <div class="opt" data-overlay-terrain>
      <input type="checkbox" id="ov-terrain" ${settings.terrain ? 'checked' : ''}>
      <label for="ov-terrain">Land heights in 3D</label>
      <small>The chart over Kartverket's terrain model (hoydedata.no). Tilt with two fingers or right-drag. Also seen from a ship's bridge.</small>
      <span class="zoomhint" data-minzoom="${DEM_MIN_ZOOM}" data-terrain-hint hidden>Zoom in to see it (from zoom ${DEM_MIN_ZOOM})</span>
    </div>
    <div class="opt" data-overlay-infra>
      <input type="checkbox" id="ov-infra" ${settings.infra ? 'checked' : ''}>
      <label for="ov-infra">Roads, bridges and buildings</label>
      <small>From OpenStreetMap: roads and railways by class, buildings raised to their height, and bridges built in 3D over the water. Best on the Satellite background, tilted. Bridge heights are estimated.</small>
      <span class="zoomhint" data-minzoom="13" data-infra-hint hidden>Zoom in for every road, buildings and 3D bridges (from zoom 13)</span>
    </div>`;
  $('#webcam-settings').innerHTML = `<h3>Webcams</h3>
    <div class="opt">
      <input type="checkbox" id="ov-webcams" ${settings.webcams ? 'checked' : ''}>
      <label for="ov-webcams">Webcams</label>
      <small>Statens vegvesen's open cameras at ferry quays, bridges, harbours and roads, turned the way they look. Tap one for what it sees; its eye opens the view with the ships in it marked.</small>
    </div>`;
  updateZoomHints();
  ais.renderPanel($('#ais-settings'));
}
$('#terrain-settings').addEventListener('change', (e) => {
  if (e.target.id === 'ov-infra') {
    settings.infra = e.target.checked;
    infra.setOn(settings.infra);
    saveSettings();
    updateZoomHints();
    // Buildings and bridges stand up: tilt the chart a little to show them, as for land heights.
    if (settings.infra && !bridge.active && map.getZoom() >= 13 && map.getPitch() < 20) map.easeTo({ pitch: 45, duration: 900 });
    return;
  }
  if (e.target.id !== 'ov-terrain') return;
  settings.terrain = e.target.checked;
  land.setOn(settings.terrain);
  saveSettings();
  updateZoomHints();
  // Heights show best tilted; switched off, the chart lies flat again.
  if (!bridge.active) {
    if (settings.terrain && map.getPitch() < 20) map.easeTo({ pitch: TERRAIN_TILT, duration: 900 });
    else if (!settings.terrain) map.easeTo({ pitch: 0, duration: 900 });
  }
});
$('#webcam-settings').addEventListener('change', (e) => {
  if (e.target.id !== 'ov-webcams') return;
  settings.webcams = e.target.checked;
  webcams.setOn(settings.webcams);
  saveSettings();
  if (!settings.webcams && $('#info-body [data-webcam]')) togglePanel('info', false);
});
for (const type of ['change', 'click', 'submit']) $('#ais-settings').addEventListener(type, (e) => ais.onPanelEvent(e));

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
    const on = h.hasAttribute('data-terrain-hint') ? settings.terrain
      : h.hasAttribute('data-infra-hint') ? settings.infra
        : settings.overlays[h.closest('[data-overlay]').dataset.overlay].on;
    h.hidden = !on || z >= Number(h.dataset.minzoom);
  }
}

function togglePanel(id, open) {
  const el = $(`#${id}`);
  el.hidden = open === undefined ? !el.hidden : !open;
  if (!el.hidden) closeShips(); // a chart panel brings the chart back
  // Layers, Settings and the tracker share the same corner: one at a time.
  const corner = ['layers', 'settings', 'tracker'];
  if (!el.hidden && corner.includes(id)) for (const other of corner) if (other !== id && !$(`#${other}`).hidden) togglePanel(other, false);
  if (id === 'tracker') { $('#tracker-btn').setAttribute('aria-expanded', String(!el.hidden)); tracker?.setOpen(!el.hidden); }
  if (id === 'layers') $('#layers-btn').setAttribute('aria-expanded', String(!el.hidden));
  if (id === 'settings') $('#settings-btn').setAttribute('aria-expanded', String(!el.hidden));
  if (id === 'info' && el.hidden) {
    clearClick();
    // the camera's sector and eye go with its card (not while looking through it: they come back after)
    if (typeof webcams !== 'undefined' && !webcamView.active) webcams.deselect();
  }
}
$('#layers-btn').addEventListener('click', () => togglePanel('layers'));
$('#settings-btn').addEventListener('click', () => togglePanel('settings'));
$('#tracker-btn').addEventListener('click', () => togglePanel('tracker'));
// Links between panels, e.g. "Set it up in Settings" in the layers panel.
document.addEventListener('click', (e) => { const o = e.target.closest('[data-open]'); if (o) togglePanel(o.dataset.open, true); });
// The "Rudder token" bookmark clicked here instead of on BarentsWatch (bwlogin.js): explain in Settings.
window.addEventListener('rudder-bookmark', () => settingsPanel.bookmarkClickedHere());
// A banner left by the first version of the bookmark, which had no way to close: a click removes it.
document.addEventListener('click', (e) => { if (e.target.closest('#rudder-bw')) e.target.closest('#rudder-bw').remove(); }, true);
document.addEventListener('click', (e) => { const c = e.target.closest('[data-close]'); if (c) togglePanel(c.dataset.close, false); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // In the ship inspector, Escape in a field only leaves the field.
  if (shipsOpen()) { if (!e.target.closest?.('#ships input, #ships select')) closeShips(); return; }
  togglePanel('layers', false); togglePanel('settings', false); togglePanel('info', false);
});

// ---------- ships ----------
// "Ships" in the top bar covers the chart with the 3D ship inspector (public/ships/). It is loaded the
// first time it is opened, so the chart never waits for three.js, and it stops drawing while closed.
let ships = null, shipsLoading = null;
const shipsOpen = () => !$('#ships').hidden;
async function openShips() {
  togglePanel('layers', false); togglePanel('settings', false); togglePanel('info', false);
  $('#ships').hidden = false;
  $('#ships-btn').setAttribute('aria-expanded', 'true');
  if (ships) { ships.resume(); return; }
  shipsLoading ??= import('./ships/ui.js')
    .then((m) => { ships = m.createShipInspector($('#ships'), { onClose: closeShips }); })
    .catch((err) => {
      shipsLoading = null;
      $('#ships').innerHTML = `<p class="ships-noview">Could not load the ship inspector (${esc(err.message)}).</p>`;
    });
  await shipsLoading;
  if (!shipsOpen()) ships?.pause(); // closed again while it was loading
}
function closeShips() {
  if (!shipsOpen()) return;
  $('#ships').hidden = true;
  $('#ships-btn').setAttribute('aria-expanded', 'false');
  ships?.pause();
}
$('#ships-btn').addEventListener('click', () => (shipsOpen() ? closeShips() : openShips()));

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

// A tap on a ship shows the ship; anywhere else, the sea at that point.
map.on('click', (e) => {
  if (bridge.active) return; // from the bridge the chart is not tapped
  if (webcamView.active) return;
  const v = ais.vesselAt(e.point);
  if (v) { webcams.deselect(); showVessel(v); return; }
  const cams = webcams.camerasAt(e.point);
  if (cams.length) { showWebcam(cams); return; }
  webcams.deselect();
  showPoint(e.lngLat);
});

// ---------- a webcam ----------
/** The card of a camera (and the other cameras at its site), with its sector and eye on the map. */
function showWebcam(cams, id = null) {
  if (!cams.length) return;
  clearClick();
  const c = webcams.select(id ?? webcams.selected?.id ?? cams[0].id) ?? cams[0];
  const site = cams.length > 1 ? cams : [];
  const v = c.view;
  const seen = shipsInView(c, ais);
  const rows = [
    ['Looks', v.bearing === null ? 'Direction unknown' : `${Math.round(v.bearing)}° ${compassPoint(v.bearing)}${v.target ? ` towards ${v.target}` : ''}`],
    ['Direction', v.bearing === null ? 'Set it in the view (Adjust view)' : v.quality === 'set here' ? 'Set on this device' : `Worked out from ${v.target ?? 'its place'} (${v.quality})`],
    ['Says it looks to', c.looks || null],
    ['Road', c.road || null],
    ['Status', c.ok ? null : 'Camera fault: no new pictures'],
    ['Ships in view', ais.working && v.bearing !== null ? (seen.length ? seen.slice(0, 4).map((x) => (x.s.name || '').trim() || x.s.mmsi).join(', ') + (seen.length > 4 ? ` and ${seen.length - 4} more` : '') : 'none with AIS now') : null],
  ].filter(([, x]) => x != null && x !== '');
  $('#info-title').textContent = c.name;
  $('#info-body').innerHTML = `<div data-webcam="${esc(c.id)}">
    ${site.length ? `<div class="webcam-site" role="tablist">${site.map((x) => `<button type="button" role="tab" aria-selected="${x.id === c.id}" data-webcam-pick="${esc(x.id)}">${esc(x.looks || x.id)}</button>`).join('')}</div>` : ''}
    <button type="button" class="webcam-shot" data-webcam-view="${esc(c.id)}" title="Look through this camera">
      <img src="${esc(c.image)}?t=${Math.floor(Date.now() / 60000)}" alt="Latest picture from ${esc(c.name)}" loading="lazy">
      <span class="webcam-shot-eye" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 5C6.5 5 2.7 9.2 1.5 12c1.2 2.8 5 7 10.5 7s9.3-4.2 10.5-7C21.3 9.2 17.5 5 12 5Zm0 11.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9Z"/></svg></span>
    </button>
    <dl class="rows">${rows.map(([k, x]) => `<dt>${k}</dt><dd>${esc(x)}</dd>`).join('')}</dl>
    <div class="info-actions">
      <button type="button" class="info-btn primary" data-webcam-view="${esc(c.id)}">Look through it</button>
      ${c.forecast ? `<a class="info-btn" href="${esc(c.forecast)}" target="_blank" rel="noopener">Weather here (yr)</a>` : ''}
    </div>
    <div class="src">Camera and picture © Statens vegvesen (NLOD). Its direction is worked out from the place it looks to and can be off by some degrees.</div>
  </div>`;
  togglePanel('info', true);
  // On a phone the card covers the lower half: move the camera (and its eye) into the space above it.
  const card = $('#info').getBoundingClientRect(), mapBox = map.getContainer().getBoundingClientRect();
  const at = map.project([c.lon, c.lat]);
  if (card.width > mapBox.width * 0.8 && at.y > card.top - mapBox.top - 50) {
    map.easeTo({ center: [c.lon, c.lat], offset: [0, (card.top - mapBox.top) / 2 - mapBox.height / 2], duration: 500 });
  }
}
$('#info-body').addEventListener('click', (e) => {
  const pick = e.target.closest('[data-webcam-pick]');
  if (pick) { const c = webcams.camera(pick.dataset.webcamPick); if (c) showWebcam(webcams.camerasAt(map.project([c.lon, c.lat])), c.id); return; }
  const look = e.target.closest('[data-webcam-view]');
  if (look) { const c = webcams.camera(look.dataset.webcamView); if (c) webcamView.enter(c); }
});

// ---------- a ship from AIS ----------
/** The bridge view needs a heading (or a course while moving) and a size to place the eye. */
const bridgeOk = (v) => modelPlacement(v) !== null;
function showVessel(v) {
  clearClick();
  const { length, beam } = vesselSize(v);
  const t = draughtM(v);
  const age = Math.max(0, Math.round(ageMinutes(v)));
  const rows = [
    ['Type', typeName(v.shipType)],
    ['Status', navStatusText(v.navigationalStatus)],
    ['Speed', v.speedOverGround != null ? `${v.speedOverGround.toFixed(1)} kn` : null],
    ['Course', v.courseOverGround != null && v.courseOverGround < 360 ? `${Math.round(v.courseOverGround)}°` : null],
    ['Heading', v.trueHeading != null && v.trueHeading < 360 ? `${v.trueHeading}°` : null],
    ['Size', length > 0 ? `${length} × ${beam} m` : null],
    ['Draught', t ? `${t.toFixed(1)} m` : null],
    ['Destination', v.destination?.trim() || null],
    ['ETA', v.eta || null],
    ['MMSI', v.mmsi],
    ['IMO', v.imoNumber || null],
    ['Call sign', v.callSign || null],
    v.playback ? ['Played back at', new Date(Date.parse(v.msgtime)).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })]
      : ['Last report', age < 1 ? 'just now' : `${age} min ago`],
  ].filter(([, x]) => x != null && x !== '');
  $('#info-title').textContent = (v.name || '').trim() || `MMSI ${v.mmsi}`;
  $('#info-body').innerHTML = `<p class="pos">${formatPosition(v.latitude, v.longitude)}</p>
    <dl class="rows">${rows.map(([k, x]) => `<dt>${k}</dt><dd>${esc(x)}</dd>`).join('')}</dl>
    <div class="info-actions">
      <button type="button" class="info-btn primary" data-bridge="${v.mmsi}" ${bridgeOk(v) ? '' : 'disabled title="Needs a size and heading from AIS"'}>View from the bridge</button>
      <button type="button" class="info-btn" data-helm-take="${v.mmsi}" ${bridgeOk(v) ? '' : 'disabled title="Needs a size and heading from AIS"'}>Take the helm</button>
      <button type="button" class="info-btn" data-open3d="${v.mmsi}">Open 3D model</button>
      <button type="button" class="info-btn" data-sea-here="${v.mmsi}">Sea and weather here</button>
    </div>
    ${tracker.cardHtml(v)}
    <div class="src">${v.playback ? 'Recorded on this device from Kystverket\'s AIS via BarentsWatch.' : 'AIS from Kystverket via BarentsWatch.'} Size and draught as the ship reports them.</div>`;
  togglePanel('info', true);
}
$('#info-body').addEventListener('click', (e) => {
  const b = e.target.closest('[data-trace="add"], [data-trace="remove"], [data-trace="clear"]');
  const card = b?.closest('[data-m]');
  if (!card) return;
  const m = Number(card.dataset.m);
  const set = tracker.traceSet();
  if (b.dataset.trace === 'add') set.setTrace(m); else if (b.dataset.trace === 'clear') set.clearTrace(m); else set.removeTrace(m);
  const v = ais.vessel(m);
  if (v) showVessel(v);
  tracker.render();
});
$('#info-body').addEventListener('change', (e) => {
  const t = e.target, card = t.closest('[data-m]');
  if (!t.dataset.trace || !card) return;
  const m = Number(card.dataset.m);
  if (t.dataset.trace === 'on') tracker.traceSet().showTrace(m, t.checked);
  if (t.dataset.trace === 'color') { tracker.traceSet().setTrace(m, t.value); t.style.background = t.value; }
  tracker.render();
});
$('#info-body').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const v = ais.vessel(b.dataset.open3d ?? b.dataset.seaHere ?? b.dataset.bridge ?? b.dataset.helmTake);
  if (!v) return;
  if (b.dataset.helmTake) { if (ais.playingBack) { alert('Go back to live AIS (Ships tracker) to take the helm.'); return; } helm.take(v); }
  else if (b.dataset.bridge) bridge.enter(v);
  else if (b.dataset.open3d) { await openShips(); ships?.showAisVessel(v); }
  else showPoint({ lat: v.latitude, lng: v.longitude });
});

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
list.addEventListener('click', (e) => { const li = e.target.closest('li[data-i]'); if (li) choose(results[Number(li.dataset.i)]); });
input.addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 150));
input.addEventListener('focus', () => { list.hidden = !results.length; });

// ---------- ship search (AIS) ----------
// Its own field next to "Ships", shown while the AIS layer is on and working. It searches the ships
// already loaded around the map and every ship heard in Norwegian waters in the last 24 hours
// (aismap.js), by name, MMSI, IMO number or call sign. Choosing one flies to it and opens its card.
const shipForm = $('#ship-search'), shipInput = $('#ship-search-input'), shipList = $('#ship-search-results');
let shipTimer = 0, shipCtl = null, shipHits = [], shipActive = -1, shipNote = '';
function renderShips() {
  shipList.hidden = !shipHits.length && !shipNote;
  shipList.innerHTML = shipHits.map((v, i) => {
    const age = Math.max(0, Math.round(ageMinutes(v)));
    const heard = age < 1 ? 'just now' : age < 120 ? `${age} min ago` : `${Math.round(age / 60)} h ago`;
    return `<li role="option" data-i="${i}" aria-selected="${i === shipActive}">${esc((v.name || '').trim() || `MMSI ${v.mmsi}`)}
      <small>${esc(typeName(v.shipType))} · MMSI ${v.mmsi}${v.callSign ? ` · ${esc(v.callSign)}` : ''} · heard ${heard}</small></li>`;
  }).join('') + (shipNote ? `<li class="hit-note" aria-disabled="true">${esc(shipNote)}</li>` : '');
}
ais.onWorking((working) => {
  shipForm.hidden = !working;
  document.body.classList.toggle('ais-working', working);
  if (!working) { shipHits = []; shipNote = ''; renderShips(); }
});
function chooseShip(v0) {
  shipHits = []; shipNote = ''; renderShips(); shipInput.blur();
  // Close enough that ships are drawn as 3D models (scale bar 200 m or less).
  const v = ais.showShip(v0);
  map.flyTo({ center: [v.longitude, v.latitude], zoom: Math.max(map.getZoom(), 15.5) });
  map.once('moveend', () => showVessel(ais.vessel(v.mmsi) ?? v));
}
shipInput.addEventListener('input', () => {
  clearTimeout(shipTimer);
  const q = shipInput.value.trim();
  if (q.length < 2) { shipHits = []; shipNote = ''; renderShips(); return; }
  shipTimer = setTimeout(async () => {
    shipCtl?.abort(); shipCtl = new AbortController();
    const signal = shipCtl.signal;
    if (!shipHits.length) { shipNote = 'Searching…'; renderShips(); }
    try {
      const { hits, error } = await ais.searchShips(q, signal);
      if (signal.aborted) return;
      shipHits = hits;
      shipActive = -1;
      shipNote = error || (hits.length ? '' : 'No ship by that name, MMSI or call sign heard in the last 24 hours.');
    } catch (e) {
      if (signal.aborted) return;
      shipHits = [];
      shipNote = `Ship search failed: ${e.message}`;
    }
    renderShips();
  }, 250);
});
shipInput.addEventListener('keydown', (e) => {
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && shipHits.length) {
    e.preventDefault();
    shipActive = (shipActive + (e.key === 'ArrowDown' ? 1 : -1) + shipHits.length) % shipHits.length;
    renderShips();
  }
});
shipForm.addEventListener('submit', (e) => { e.preventDefault(); const v = shipHits[Math.max(shipActive, 0)]; if (v) chooseShip(v); });
shipList.addEventListener('click', (e) => { const li = e.target.closest('li[data-i]'); if (li) chooseShip(shipHits[Number(li.dataset.i)]); });
shipInput.addEventListener('blur', () => setTimeout(() => { shipList.hidden = true; }, 150));
shipInput.addEventListener('focus', () => { shipList.hidden = !shipHits.length && !shipNote; });

renderLayerPanel();

// Four quick taps on the logo: hard reload (see reload.js).
enableLogoReload($('#brand'), { onReload: () => { $('#reloading').hidden = false; } });

// Back from Shortcuts: show the result in Settings, and the ships once there is a token.
if (handoff) {
  togglePanel('settings', true);
  settingsPanel.fromToken(handoff, 'Got a new token from Shortcuts.');
}

// The simulator (vessel, controls) builds on this map; expose it for development in the console.
window.rudder = { map, settings, showPoint, showVessel, openShips, closeShips, ais, bridge, helm, recorder, playback, trackStore, liveTraces };
