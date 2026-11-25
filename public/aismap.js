// The AIS layer on the chart: fetching from BarentsWatch, drawing the ships, and the AIS part of the
// layers panel. The decoding and shapes are in ais.js (tested).
//
// The client ID and secret (or a pasted access token) are entered in Settings and kept on this
// device only (credentials.js). Nothing is fetched until the layer is switched on.

import {
  TOKEN_URL, LATEST_URL, TYPE_GROUPS, tokenRequestBody, parseToken, pastedToken, latestRequest, bboxPolygon, bboxInside,
  mergeVessels, pruneVessels, toGeoJson, directoryRequest, matchVessels, movedReport, reportedHeading, vesselSize,
} from './ais.js';
import { loadCredentials, accessKind } from './credentials.js';
import { scaleBarMetres, modelsAtScale } from './scalebar.js';
import { createShipModels, pickShips, boxAround, MAX_MODELS, POV_RADIUS_M } from './shipmodels.js';
import { nearestShore, guessHeading } from './shoreline.js';
import { TILEJSON } from './infra.js';
import { loadPlaced, savePlaced, nextMmsi, placedReport, carryOn, advance, stopped, isPlacedMmsi } from './placed.js';
import { soundingPoints, seabedUrl, parseSeabed, groundCheck } from './contact.js';

const STORE_KEY = 'rudder.ais.v1';
const MIN_ZOOM = 7; // wider views would ask for most of the coast at once
const REFRESH_MS = 30_000;
const PAD = 0.3; // fetch 30 % beyond the view each way, so small pans need no new request
const LAYERS = ['ais-hull', 'ais-hull-line', 'ais-hull-guess', 'ais-arrow', 'ais-dot'];
// The shore, for ships that tell no heading (shoreline.js): OpenFreeMap's water outlines and piers,
// loaded by an invisible layer while ships are near enough to be drawn at true size.
const SHORE = 'ais-shore', SHORE_PROBE = 'ais-shore-probe', GUESS_ZOOM = 12.5;
const GUESS_DOT = ['any', ['!', ['get', 'guessed']], ['<', ['zoom'], 13]]; // dots step aside for guessed outlines

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function load() {
  try { return { on: Boolean(JSON.parse(localStorage.getItem(STORE_KEY))?.on) }; } catch { return { on: false }; }
}

/** A ship-shaped arrow (bow up), drawn white so MapLibre can colour it per ship (SDF icon). */
function arrowImage() {
  const S = 48, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.beginPath();
  g.moveTo(S / 2, 3);
  g.lineTo(S * 0.78, S * 0.42);
  g.lineTo(S * 0.72, S - 4);
  g.lineTo(S * 0.28, S - 4);
  g.lineTo(S * 0.22, S * 0.42);
  g.closePath();
  g.fill();
  return g.getImageData(0, 0, S, S);
}

export function createAisLayer(map) {
  let creds = loadCredentials(); // read before cfg: it moves credentials out of the old store
  let cfg = load();
  const vessels = new Map();
  // Ships the user placed on the chart (placed.js): in `vessels` like the others, kept when it is
  // cleared, shown even with AIS off, and moved on by Rudder between reports.
  const placed = new Map(loadPlaced().map((v) => [v.mmsi, v]));
  const keepPlaced = () => { for (const v of placed.values()) if (v.mmsi !== controlled) vessels.set(v.mmsi, v); };
  const shownNow = () => cfg.on || playback !== null || placed.size > 0;
  const storePlaced = () => savePlaced([...placed.values()]);
  for (const v of placed.values()) vessels.set(v.mmsi, v);
  let token = null; // { token, expiresAt }
  let fetched = null; // [w, s, e, n] the last full request covered
  let lastFetch = 0;
  let timer = 0, moveTimer = 0, busy = false, seq = 0;
  let status = { text: '', tone: '' };
  let panel = null;
  const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify({ on: cfg.on })); } catch { /* private mode: kept for this visit only */ } };

  // ---------- drawing ----------

  function addLayers() {
    if (map.getSource('ais-points')) return;
    const empty = { type: 'FeatureCollection', features: [] };
    map.addSource('ais-points', { type: 'geojson', data: empty });
    map.addSource('ais-hulls', { type: 'geojson', data: empty });
    if (!map.hasImage('ais-arrow')) map.addImage('ais-arrow', arrowImage(), { sdf: true, pixelRatio: 2 });
    const fade = ['case', ['get', 'stale'], 0.45, 1];
    // True size and heading from zoom 13, where a ship is big enough to see.
    map.addLayer({ id: 'ais-hull', type: 'fill', source: 'ais-hulls', minzoom: 13, paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['*', 0.45, fade] } });
    map.addLayer({ id: 'ais-hull-line', type: 'line', source: 'ais-hulls', minzoom: 13, filter: ['!', ['get', 'guessed']], paint: { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-opacity': fade } });
    // A heading guessed, not told: the outline dashed.
    map.addLayer({ id: 'ais-hull-guess', type: 'line', source: 'ais-hulls', minzoom: 13, filter: ['get', 'guessed'], paint: { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-dasharray': [2, 1.5], 'line-opacity': fade } });
    map.addLayer({
      id: 'ais-arrow', type: 'symbol', source: 'ais-points', filter: ['get', 'hasHeading'],
      layout: {
        'icon-image': 'ais-arrow', 'icon-rotate': ['get', 'heading'], 'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true, 'icon-ignore-placement': true,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 7, 0.55, 12, 0.85, 15, 1],
      },
      paint: { 'icon-color': ['get', 'color'], 'icon-halo-color': '#ffffff', 'icon-halo-width': 1.2, 'icon-opacity': fade },
    });
    map.addLayer({
      id: 'ais-dot', type: 'circle', source: 'ais-points', filter: ['all', ['!', ['get', 'hasHeading']], GUESS_DOT],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 3, 13, 5], 'circle-color': ['get', 'color'],
        'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.2, 'circle-opacity': fade, 'circle-stroke-opacity': fade,
      },
    });
    setVisible(shownNow());
  }

  function setVisible(on) {
    for (const id of LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    updateModels();
  }

  // ---------- 3D models when the scale bar reads 200 m or less (shipmodels.js) ----------

  const models = createShipModels(map);
  let modelled = []; // MMSIs drawn as models: their arrows and outlines step aside
  let playback = null; // { now } while recorded tracks play back (playback.js)
  let pov = null; // MMSI of the ship whose bridge the view is from (pov.js): always modelled
  let controlled = null; // MMSI of the ship the user has the helm of (helm.js): its AIS reports are ignored

  function updateModels() {
    // From the bridge the chart is tilted far over, so the scale bar says little: models stay on.
    const active = shownNow() && map.getSource('ais-points') && (pov !== null || modelsAtScale(scaleBarMetres(map)));
    let list = [];
    if (active) {
      const own = pov !== null ? vessels.get(pov) : null;
      if (own) {
        // From a bridge, the ships around it, nearest first. (MapLibre's view bounds are no use here:
        // with the helm console's padding and the camera tilted far over they shrink to a few metres.)
        const at = models.shown(own);
        list = pickShips(vessels.values(), boxAround(at.lat, at.lon, POV_RADIUS_M), [at.lon, at.lat]);
      } else {
        const b = map.getBounds(), c = map.getCenter();
        const padX = (b.getEast() - b.getWest()) * 0.2, padY = (b.getNorth() - b.getSouth()) * 0.2;
        list = pickShips(vessels.values(), [b.getWest() - padX, b.getSouth() - padY, b.getEast() + padX, b.getNorth() + padY], [c.lng, c.lat]);
      }
      if (own && !list.includes(own)) list = [own, ...list].slice(0, MAX_MODELS);
    }
    const ids = list.map((v) => v.mmsi);
    if (ids.join() !== modelled.join()) {
      modelled = ids;
      // Modelled ships keep an invisible outline, so they can still be hovered and tapped.
      const isModel = ['in', ['get', 'mmsi'], ['literal', ids]];
      const fade = ['case', ['get', 'stale'], 0.45, 1];
      if (map.getLayer('ais-hull')) {
        map.setPaintProperty('ais-hull', 'fill-opacity', ['case', isModel, 0, ['*', 0.45, fade]]);
        map.setPaintProperty('ais-hull-line', 'line-opacity', ['case', isModel, 0, fade]);
        map.setPaintProperty('ais-hull-guess', 'line-opacity', ['case', isModel, 0, fade]);
        map.setFilter('ais-arrow', ['all', ['get', 'hasHeading'], ['!', isModel]]);
        map.setFilter('ais-dot', ['all', ['!', ['get', 'hasHeading']], GUESS_DOT, ['!', isModel]]);
      }
    }
    models.setShips(list).catch((e) => setStatus(`3D ships could not load (${e.message}).`, 'err'));
  }
  map.on('moveend', updateModels);

  /** The AIS sources and layers exist; if the map cannot take them yet, try again when it is idle. */
  function ensureLayers() {
    if (map.getSource('ais-points')) return true;
    try {
      addLayers();
      return true;
    } catch {
      map.once('idle', () => { if (ensureLayers()) draw(); });
      return false;
    }
  }

  // ---------- headings for ships that tell none (shoreline.js) ----------

  let lastGuess = 0, shoreTimer = 0;
  const guesses = new Map(); // mmsi -> guess { deg, how, lat, lon, shore }: kept while the ship stays put
  const stillThere = (g, v) => g && Math.abs(g.lat - v.latitude) < 1.5e-4 && Math.abs(g.lon - v.longitude) < 3e-4;

  /** Put the guesses made back on the ships (new reports, and every frame of playback, come without). */
  function applyGuesses() {
    for (const v of vessels.values()) {
      if (v.headingGuess || reportedHeading(v) !== null) continue;
      const g = guesses.get(v.mmsi);
      if (stillThere(g, v)) v.headingGuess = g;
    }
  }
  function ensureShore() {
    if (map.getSource(SHORE)) return;
    try {
      map.addSource(SHORE, { type: 'vector', url: TILEJSON });
      // Drawn with nothing to see: it only makes the map load the water tiles here.
      map.addLayer({ id: SHORE_PROBE, type: 'fill', source: SHORE, 'source-layer': 'water', minzoom: 12, paint: { 'fill-opacity': 0 } }, 'ais-hull');
      map.on('sourcedata', (e) => {
        if (e.sourceId !== SHORE || !e.isSourceLoaded) return;
        clearTimeout(shoreTimer);
        shoreTimer = setTimeout(() => { if (guessHeadings(true)) { drawSymbols(); updateModels(); } }, 200);
      });
    } catch { /* the style is busy: next time */ }
  }

  /** Water outlines and piers loaded around the view, as lines of [lon, lat]. */
  function shoreLines() {
    const lines = [];
    const add = (g) => {
      if (!g) return;
      if (g.type === 'Polygon') lines.push(...g.coordinates);
      else if (g.type === 'MultiPolygon') for (const p of g.coordinates) lines.push(...p);
      else if (g.type === 'LineString') lines.push(g.coordinates);
      else if (g.type === 'MultiLineString') lines.push(...g.coordinates);
    };
    for (const f of map.querySourceFeatures(SHORE, { sourceLayer: 'water' })) add(f.geometry);
    for (const f of map.querySourceFeatures(SHORE, { sourceLayer: 'transportation', filter: ['==', ['get', 'class'], 'pier'] })) add(f.geometry);
    return lines;
  }

  /**
   * Give the ships in view that tell no heading a guessed one (along the quay they lie at, as told
   * earlier, their last course), so they are drawn at true size and as models, not as dots. Up close
   * only, at most every second and a half unless `force`. Returns whether any guess changed.
   */
  function guessHeadings(force = false) {
    if (map.getZoom() < GUESS_ZOOM || !map.getSource('ais-points')) return false;
    if (!force && Date.now() - lastGuess < 1500) return false;
    lastGuess = Date.now();
    ensureShore();
    const b = map.getBounds();
    const padX = (b.getEast() - b.getWest()) * 0.2, padY = (b.getNorth() - b.getSouth()) * 0.2;
    let lines = null, changed = false;
    for (const v of vessels.values()) {
      if (v.longitude < b.getWest() - padX || v.longitude > b.getEast() + padX || v.latitude < b.getSouth() - padY || v.latitude > b.getNorth() + padY) continue;
      if (reportedHeading(v) !== null) continue;
      const { length, beam } = vesselSize(v);
      if (!(length > 0 && beam > 0)) continue;
      const g = v.headingGuess ?? guesses.get(v.mmsi);
      if (stillThere(g, v) && g.shore) { v.headingGuess = g; continue; }
      lines ??= map.getSource(SHORE) ? shoreLines() : [];
      // Shore data around the ship (any within 500 m) means its tile is in: the guess is final there.
      // Without, guess for now and look again when more tiles come.
      const near = lines.length ? nearestShore(v.longitude, v.latitude, lines, 500) : null;
      const shore = near && near.distance <= beam / 2 + 40 ? near : null;
      const next = { ...guessHeading(v, shore, beam), lat: v.latitude, lon: v.longitude, shore: Boolean(near) };
      if (g && stillThere(g, v) && g.deg === next.deg && g.how === next.how && g.shore === next.shore) { v.headingGuess = g; continue; }
      v.headingGuess = next;
      guesses.set(v.mmsi, v.headingGuess);
      changed = true;
    }
    return changed;
  }
  map.on('moveend', () => { if (guessHeadings(true)) { drawSymbols(); updateModels(); } });

  function draw(now = playback ? playback.now : Date.now()) {
    if (!ensureLayers()) return;
    applyGuesses();
    guessHeadings();
    drawSymbols(now);
    updateModels();
  }

  /**
   * The chart's symbols, each where its ship is drawn now: between reports a ship under way moves on
   * by dead reckoning (the same as its 3D model), so ships move at every scale, not only up close.
   * Returns how many are under way. In playback the ships handed over are already where they are.
   */
  function drawSymbols(now = playback ? playback.now : Date.now()) {
    if (!map.getSource('ais-points')) return 0;
    let moving = 0;
    const list = [];
    for (const v of vessels.values()) {
      if (playback) { list.push(v); continue; }
      const at = models.shown(v);
      if (at.moving) moving++;
      list.push(movedReport(v, at));
    }
    const { points, outlines } = toGeoJson(list, now);
    map.getSource('ais-points').setData(points);
    map.getSource('ais-hulls').setData(outlines);
    return moving;
  }

  // Keep the symbols moving a few times a second while any ship is under way (less often when a
  // great many ships are loaded, so the chart stays quick).
  let anyMoving = true;
  setInterval(() => {
    if ((!cfg.on && !placed.size) || playback || document.hidden || !map.getSource('ais-points')) return;
    if (vessels.size > 1500 && (Date.now() / 300 | 0) % 2) return; // every other tick
    if (!anyMoving) { anyMoving = [...vessels.values()].some((v) => (v.speedOverGround ?? 0) > 0.5); if (!anyMoving) return; }
    anyMoving = drawSymbols() > 0;
  }, 300);

  // Placed ships left to themselves carry on: every few seconds a fresh report where dead reckoning
  // has them; every 15 s the water under them is sounded, and land or too little water stops them.
  let lastSound = 0;
  setInterval(async () => {
    if (!placed.size || playback) return;
    const now = Date.now();
    for (const [m, v] of placed) {
      if (m === controlled) continue;
      const nv = advance(v, now);
      placed.set(m, nv);
      vessels.set(m, nv);
    }
    if (now - lastSound > 15000) {
      lastSound = now;
      for (const [m, v] of placed) {
        if (m === controlled || !(v.speedOverGround >= 0.1)) continue;
        try {
          const pts = soundingPoints(v, { lat: v.latitude, lon: v.longitude, heading: v.trueHeading });
          const sea = parseSeabed(await (await fetch(seabedUrl(pts.map((p) => p.p)))).json());
          const { hit } = groundCheck(pts, sea, (v.draught || 0) / 10);
          if (hit && placed.has(m) && m !== controlled) {
            const sv = stopped(placed.get(m));
            placed.set(m, sv);
            vessels.set(m, sv);
            setStatus(`${v.name} ran aground (${hit.name}) and stopped.`, 'err');
          }
        } catch { /* sounding unavailable: try again later */ }
      }
    }
    storePlaced();
    draw();
  }, 3000);

  // Ship name under the pointer (the chart has no font server, so no map labels).
  const tip = document.createElement('div');
  tip.className = 'ais-tip';
  tip.hidden = true;
  map.getContainer().appendChild(tip);
  for (const id of ['ais-arrow', 'ais-dot', 'ais-hull']) {
    map.on('mousemove', id, (e) => {
      const f = e.features?.[0];
      if (!f) return;
      map.getCanvas().style.cursor = 'pointer';
      tip.textContent = f.properties.name;
      tip.style.left = `${e.point.x + 12}px`;
      tip.style.top = `${e.point.y + 12}px`;
      tip.hidden = false;
    });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; tip.hidden = true; });
  }
  // The same for the moving 3D models, which are not where their (hidden) outlines are.
  let tipOnModel = false;
  map.on('mousemove', (e) => {
    const v = modelled.length ? models.vesselAt(e.point) : null;
    if (v) {
      tipOnModel = true;
      map.getCanvas().style.cursor = 'pointer';
      tip.textContent = (v.name || '').trim() || String(v.mmsi);
      tip.style.left = `${e.point.x + 12}px`;
      tip.style.top = `${e.point.y + 12}px`;
      tip.hidden = false;
    } else if (tipOnModel) {
      tipOnModel = false;
      map.getCanvas().style.cursor = '';
      tip.hidden = true;
    }
  });

  // ---------- fetching ----------

  // "Working": switched on and the last request for ships succeeded. The ship search field is shown
  // only then (app.js), so it never offers a search that cannot work.
  let working = false;
  const workingListeners = new Set();
  function setWorking(w) {
    if (Boolean(w) === working) return;
    working = Boolean(w);
    for (const f of workingListeners) f(working);
  }

  function setStatus(text, tone = '', action = '') {
    status = { text, tone, action };
    const el = panel?.querySelector('.ais-status');
    if (el) {
      el.textContent = text;
      el.dataset.tone = tone;
      if (action === 'renew') el.insertAdjacentHTML('beforeend', ' <button type="button" class="link-btn" data-renew>Get a new token</button>');
    }
  }

  async function getToken(force = false) {
    if (!force && token && token.expiresAt > Date.now()) return token.token;
    // A saved token (from Shortcuts or pasted) while it lasts; else the client ID and secret.
    const saved = creds.pasted ? pastedToken(creds.pasted) : null;
    if (saved && saved.expiresAt > Date.now()) { token = saved; return token.token; }
    if (!(creds.clientId && creds.clientSecret)) {
      if (saved) throw Object.assign(new Error('Your BarentsWatch token has expired.'), { fatal: true, expired: true });
      throw Object.assign(new Error('Set up BarentsWatch access in Settings.'), { fatal: true });
    }
    let res;
    try {
      res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: tokenRequestBody(creds.clientId, creds.clientSecret) });
    } catch {
      // A network error here, with the network up, means the login server did not let this page read its answer.
      throw Object.assign(new Error(navigator.onLine === false
        ? 'Offline.'
        : 'BarentsWatch only lets its own website log in from a browser, so Rudder cannot use the ID and secret directly. Get a token in Settings instead.'), { fatal: true, expired: Boolean(saved) });
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw Object.assign(new Error(json.error === 'invalid_client' ? 'BarentsWatch did not accept the client ID or secret.'
        : json.error === 'invalid_scope' ? 'This client may not read AIS. Create an "AIS - API" client (not BarentsWatch - API) on My Page.'
          : `Login failed (${json.error || res.status}).`), { fatal: true });
    }
    token = parseToken(json);
    return token.token;
  }

  async function fetchShips({ full = false } = {}) {
    if (!cfg.on || busy || document.hidden || playback) return;
    if (map.getZoom() < MIN_ZOOM) { setStatus(`Zoom in to see ships (from zoom ${MIN_ZOOM}).`); return; }
    const b = map.getBounds();
    const view = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    const needArea = full || !fetched || !bboxInside(view, fetched);
    const area = needArea ? bboxPolygon(view, PAD).coordinates[0] : null;
    const box = needArea ? [area[0][0], area[0][1], area[2][0], area[2][1]] : fetched;
    // Same area: only what changed since the last answer (with a minute's overlap).
    const since = needArea ? null : lastFetch - 60_000;
    busy = true;
    const mySeq = ++seq;
    try {
      let t = await getToken();
      const ask = (tok) => fetch(LATEST_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(latestRequest(box, since)),
      });
      const started = Date.now();
      let res = await ask(t);
      if (res.status === 401) { t = await getToken(true); res = await ask(t); }
      if (res.status === 403) throw Object.assign(new Error('This client may not read AIS. Create an "AIS client" (not an API client) on My Page.'), { fatal: true });
      if (!res.ok) throw new Error(`AIS request failed (HTTP ${res.status}).`);
      const list = await res.json();
      if (mySeq !== seq) return;
      mergeVessels(vessels, (Array.isArray(list) ? list : []).filter((v) => v?.mmsi !== controlled));
      pruneVessels(vessels);
      if (needArea) fetched = box;
      lastFetch = started;
      draw();
      const n = [...vessels.values()].filter((v) => v.longitude >= view[0] && v.longitude <= view[2] && v.latitude >= view[1] && v.latitude <= view[3]).length;
      setWorking(true);
      setStatus(`${n} ship${n === 1 ? '' : 's'} in view · updated ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`, 'ok');
    } catch (e) {
      setStatus(e.message, 'err', e.expired ? 'renew' : '');
      if (e.fatal) { stop(); setWorking(false); }
    } finally {
      busy = false;
    }
  }

  function start() {
    clearInterval(timer);
    timer = setInterval(() => fetchShips(), REFRESH_MS);
    fetchShips({ full: true });
  }
  function stop() { clearInterval(timer); timer = 0; setWorking(false); }

  map.on('moveend', () => {
    if (!cfg.on || !timer) return;
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => fetchShips(), 500);
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && cfg.on && timer) fetchShips(); });

  // ---------- the AIS part of the layers panel (access is set up in Settings) ----------

  function renderPanel(el) {
    panel = el;
    const ready = Boolean(accessKind(creds));
    el.innerHTML = `
      <h3>Ships (AIS)</h3>
      <label class="opt"><input type="checkbox" data-ais="on" ${cfg.on ? 'checked' : ''} ${ready ? '' : 'disabled'}>
        <span>Show ships</span><small>Live positions from Kystverket's AIS via BarentsWatch, Norwegian waters. Tap a ship for details and its 3D model.</small></label>
      ${ready ? '' : '<p class="ais-setup">Needs your BarentsWatch AIS client. <button type="button" class="link-btn" data-open="settings">Set it up in Settings</button></p>'}
      <p class="ais-status" data-tone="${status.tone}" role="status">${esc(status.text)}${status.action === 'renew' ? ' <button type="button" class="link-btn" data-renew>Get a new token</button>' : ''}</p>
      <div class="ais-legend">${TYPE_GROUPS.map((g) => `<span><i style="background:${g.color}"></i>${esc(g.label)}</span>`).join('')}</div>`;
  }

  function onPanelEvent(e) {
    const t = e.target;
    if (e.type === 'change' && t.dataset.ais === 'on') {
      cfg.on = t.checked;
      save();
      setVisible(shownNow());
      if (cfg.on) start(); else { stop(); setStatus(''); }
      return true;
    }
    return false;
  }

  /** Settings saved or removed new credentials: drop the old token and start again. */
  function credentialsChanged() {
    creds = loadCredentials();
    token = null;
    if (!accessKind(creds)) {
      cfg.on = false;
      save();
      stop();
      setVisible(shownNow());
      vessels.clear();
      keepPlaced();
      draw();
      setStatus('');
    } else if (cfg.on) {
      setStatus('');
      start();
    }
    if (panel) renderPanel(panel);
  }

  /**
   * Check the stored access from Settings: get a token, then ask AIS for a small area (the harbour
   * of Bergen), so a wrong kind of client shows up here and not later on the chart.
   */
  async function testAccess() {
    creds = loadCredentials();
    token = null;
    try {
      const t = await getToken(true);
      const res = await fetch(LATEST_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(latestRequest([5.25, 60.38, 5.34, 60.42])),
      });
      if (res.status === 401 || res.status === 403) throw new Error('Logged in, but this client may not read AIS. Create an "AIS - API" client on My Page.');
      if (!res.ok) throw new Error(`Logged in, but the AIS service answered HTTP ${res.status}.`);
      const list = await res.json();
      const n = Array.isArray(list) ? list.length : 0;
      return { ok: true, message: `Connected. BarentsWatch answered with ${n} ship${n === 1 ? '' : 's'} in Bergen harbour.` };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  }

  // 'style.load' comes as soon as the style is read; 'load' waits for every chart tile, which on a
  // slow or failing tile service can be very late or never.
  if (map.isStyleLoaded()) addLayers(); else map.once('style.load', ensureLayers);
  if (cfg.on) setTimeout(start, 0);

  // ---------- every ship, for the search box ----------
  // BarentsWatch has no search by name, but answers with every ship heard in Norwegian waters in the
  // last 24 hours when no area is given. That list is fetched on the first ship search and kept for
  // DIRECTORY_MS; searching it happens here, on the device.
  const DIRECTORY_MS = 10 * 60e3;
  let directory = null, directoryAt = 0, directoryLoading = null;

  /** Every ship's latest report in Norwegian waters (only those changed since `since`, when given). */
  async function fetchAll(since = null) {
    if (!accessKind(loadCredentials())) throw new Error('Set up BarentsWatch access in Settings.');
    creds = loadCredentials();
    const body = directoryRequest();
    if (since) body.since = new Date(since).toISOString();
    let t = await getToken();
    const ask = (tok) => fetch(LATEST_URL, {
      method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    let res = await ask(t);
    if (res.status === 401) { t = await getToken(true); res = await ask(t); }
    if (!res.ok) throw new Error(`AIS answered HTTP ${res.status}`);
    const list = await res.json();
    return Array.isArray(list) ? list : [];
  }

  async function shipDirectory() {
    if (directory && Date.now() - directoryAt < DIRECTORY_MS) return directory;
    directoryLoading ??= fetchAll().then((list) => {
      directory = list;
      directoryAt = Date.now();
      return directory;
    }).finally(() => { directoryLoading = null; });
    return directoryLoading;
  }

  // ---------- playback of recorded positions (playback.js) ----------
  // While it plays, live updates pause; the ships drawn are those the playback hands over, at its time.

  function setPlayback(where) {
    if (where) {
      playback = { now: Date.now() };
      stop();
      ensureLayers();
      setVisible(true);
      models.setPlayback(where);
    } else if (playback) {
      playback = null;
      models.setPlayback(null);
      vessels.clear();
      keepPlaced();
      setVisible(shownNow());
      draw();
      if (cfg.on) start();
    }
  }

  /** Switch the layer on or off (as the checkbox does). */
  function setOn(on) {
    if (cfg.on === on) return;
    cfg.on = on;
    save();
    setVisible(shownNow());
    if (on) start(); else { stop(); setStatus(''); }
    if (panel) renderPanel(panel);
  }

  return {
    renderPanel,
    onPanelEvent,
    setOn,
    credentialsChanged,
    testAccess,
    /** The vessel under a map point (a little slack around small symbols), or null. */
    vesselAt(point) {
      if (!shownNow() || !map.getLayer('ais-dot')) return null;
      // A 3D model is where the ship is now, which can be ahead of its last report.
      const hit = modelled.length ? models.vesselAt(point) : null;
      if (hit) return vessels.get(hit.mmsi) ?? hit;
      const box = [[point.x - 8, point.y - 8], [point.x + 8, point.y + 8]];
      const f = map.queryRenderedFeatures(box, { layers: LAYERS.filter((l) => map.getLayer(l)) })[0];
      return f ? vessels.get(Number(f.properties.mmsi)) ?? null : null;
    },
    fetchAll,
    /** Play back recorded positions: `where(v)` places each ship every frame; null goes back to live. */
    setPlayback,
    get playingBack() { return playback !== null; },
    /** The ships at playback time `now` (their reports), drawn on the chart. */
    playbackFrame(list, now) {
      if (!playback) return;
      playback.now = now;
      vessels.clear();
      for (const v of list) vessels.set(v.mmsi, v);
      keepPlaced();
      draw(now);
    },
    /** MMSIs drawn as 3D models now (for checking). */
    get modelled() { return [...modelled]; },
    vessel: (mmsi) => vessels.get(Number(mmsi)) ?? null,
    /** Ships reported within `metres` of a point (by their last report; good enough to find those that could touch). */
    vesselsNear(lat, lon, metres) {
      const dLat = metres / 111_320, dLon = metres / (111_320 * Math.cos((lat * Math.PI) / 180));
      return [...vessels.values()].filter((v) => Math.abs(v.latitude - lat) < dLat && Math.abs(v.longitude - lon) < dLon);
    },
    /** Whether ships can be searched: BarentsWatch access is set up on this device. */
    canSearch: () => Boolean(accessKind(loadCredentials())),
    /** Whether the layer is on and its last request for ships succeeded. */
    get working() { return working; },
    /** Be told when that changes. */
    onWorking(fn) { workingListeners.add(fn); fn(working); },
    /**
     * Ships matching `query`: those already loaded around the map at once, and every ship heard in
     * Norwegian waters in the last 24 hours (fetched once, kept 10 minutes). If that list cannot be
     * fetched, the loaded ones are still searched, and `error` says why.
     */
    async searchShips(query, signal) {
      const local = [...vessels.values()];
      let all = local, error = '';
      if (accessKind(loadCredentials())) {
        try {
          creds = loadCredentials();
          all = mergeVessels(new Map((await shipDirectory()).map((v) => [v.mmsi, v])), local);
          all = [...all.values()];
        } catch (e) {
          error = `Only ships near the map could be searched: ${e.message}`;
        }
      }
      if (signal?.aborted) return { hits: [], error: '' };
      return { hits: matchVessels(all, query), error };
    },
    /** Put a ship found by search on the chart (the layer is switched on) and return its newest report. */
    showShip(v) {
      mergeVessels(vessels, [v]);
      setOn(true);
      draw();
      return vessels.get(v.mmsi) ?? v;
    },
    /**
     * The user has the helm of this ship (or none): its real AIS reports are ignored and its model is
     * drawn where `where()` says each frame. Handing it back drops the simulated report, so the next
     * real one puts the ship back where it really is.
     */
    setControlled(mmsi, where = null) {
      const was = controlled;
      controlled = mmsi === null ? null : Number(mmsi);
      models.setOverride(controlled, where);
      if (was !== null && controlled === null) {
        if (placed.has(was)) {
          // a placed ship carries on at the speed and course it was handed back with
          const v = carryOn(vessels.get(was) ?? placed.get(was));
          placed.set(was, v);
          vessels.set(was, v);
          storePlaced();
          draw();
        } else { lastFetch = 0; fetchShips({ full: true }); } // its simulated report gives way to the next real one
      }
      updateModels();
    },
    /** The simulation's report for the ship under command: the chart symbols, card and search follow it. */
    setReport(v) {
      if (v.mmsi !== controlled) return;
      vessels.set(v.mmsi, v);
      if (placed.has(v.mmsi)) placed.set(v.mmsi, { ...v, placed: true });
      draw();
    },
    /** Put a ship of the user's on the chart (placed.js): `spec` { name, kind, length, beam, draft }. Returns its report. */
    placeShip(spec, at, heading) {
      const v = placedReport(spec, at, heading, nextMmsi([...placed.keys(), ...vessels.keys()]));
      placed.set(v.mmsi, v);
      vessels.set(v.mmsi, v);
      storePlaced();
      ensureLayers();
      setVisible(true);
      draw();
      return v;
    },
    /** Take a placed ship off the chart. */
    removePlaced(mmsi) {
      const m = Number(mmsi);
      if (!placed.delete(m)) return;
      vessels.delete(m);
      models.setShips([]).then(() => updateModels());
      storePlaced();
      setVisible(shownNow());
      draw();
    },
    isPlaced: (mmsi) => placed.has(Number(mmsi)),
    /** Where a ship is drawn now: moved on from its last report, as its 3D model is. */
    shownShip: (v) => models.shown(v),
    /** The bridge view is from this ship (or none): keep it, and the 3D models, drawn whatever the scale. */
    setPov(mmsi) {
      pov = mmsi === null ? null : Number(mmsi);
      models.setOwn(pov);
      updateModels();
    },
  };
}
