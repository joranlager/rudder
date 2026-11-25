// The view through a webcam (webcams.js), over the chart: its latest picture, with the ships that are
// in its field of view (AIS) marked on it where they are now: a frame from waterline to mast top,
// their name, type, distance, speed and course. Ships just outside the picture are shown at its edge.
//
// Where a ship goes in the picture follows from the camera's place, direction, field of view, tilt
// and height (projectShip). The direction is worked out from the place the camera looks to, so it can
// be off by some degrees: "Adjust view" lines it up (a landmark, the horizon over the sea), and that
// is kept on this device. The chart behind is moved to the camera, so the ships around it are loaded.

import { projectShip, pictureX, pictureY, horizonDip, SHIP_RANGE_M } from './webcams.js';
import { vesselSize, typeName } from './ais.js';
import { compassPoint, formatDistance } from './nav.js';

const REFRESH_MS = 60_000; // the cameras send a new picture every few minutes
const SHIPS_MS = 500;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const EYE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5C6.5 5 2.7 9.2 1.5 12c1.2 2.8 5 7 10.5 7s9.3-4.2 10.5-7C21.3 9.2 17.5 5 12 5Zm0 11.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9Z"/></svg>';

export function createWebcamView(map, { el, ais, webcams, onShip = () => {}, onEnter = () => {}, onExit = () => {} }) {
  let cam = null;
  let refresh = 0, tick = 0;
  let before = null; // the chart's view before, put back on leaving
  let aspect = 4 / 3;
  let adjusting = false;
  let loadedAt = 0;

  el.innerHTML = `
    <div class="wv-stage">
      <img class="wv-img" alt="" decoding="async">
      <div class="wv-overlay" aria-live="off"></div>
      <p class="wv-msg" hidden></p>
      <p class="wv-status"></p>
    </div>
    <div class="wv-bar">
      <div class="wv-title"><span class="wv-eye">${EYE}</span><span><b class="wv-name"></b><small class="wv-sub"></small></span></div>
      <div class="wv-actions">
        <button type="button" class="wv-btn" data-wv="adjust" aria-pressed="false">Adjust view</button>
        <button type="button" class="wv-btn" data-wv="refresh">New picture</button>
        <button type="button" class="wv-btn wv-close" data-wv="exit" aria-label="Leave the camera view">×</button>
      </div>
      <form class="wv-adjust" hidden></form>
      <p class="wv-note"></p>
    </div>`;
  const $ = (s) => el.querySelector(s);
  const img = $('.wv-img'), overlay = $('.wv-overlay'), msg = $('.wv-msg');

  img.addEventListener('load', () => {
    aspect = img.naturalWidth / img.naturalHeight || 4 / 3;
    loadedAt = Date.now();
    msg.hidden = true;
    note();
    draw();
  });
  img.addEventListener('error', () => {
    msg.hidden = false;
    msg.textContent = 'The camera\'s picture could not be loaded just now. It is tried again every minute.';
  });

  function picture() {
    if (!cam) return;
    // A new address each time, or the browser shows the picture it already has.
    img.src = `${cam.image}${cam.image.includes('?') ? '&' : '?'}t=${Math.floor(Date.now() / 1000)}`;
  }

  /** The part of the stage the picture fills (it is fitted whole, keeping its shape). */
  function rect() {
    const s = $('.wv-stage').getBoundingClientRect();
    const k = Math.min(s.width / aspect, s.height);
    const w = k * aspect, h = k;
    return { x: (s.width - w) / 2, y: (s.height - h) / 2, w, h };
  }

  function note() {
    const v = cam.view;
    const when = loadedAt ? new Date(loadedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Europe/Oslo' }) : '…';
    $('.wv-note').textContent = `Picture fetched ${when}; the camera itself sends a new one every few minutes, so ships can be a little ahead of where they are shown. ` +
      (v.bearing === null ? 'This camera\'s direction is not known: set it with Adjust view to see ships on it.'
        : v.quality === 'set here' ? 'Direction as set on this device.'
          : `Direction worked out from the place it looks to (${v.target ?? '?'}, ${v.quality}); Adjust view lines it up.`);
  }

  function header() {
    const v = cam.view;
    $('.wv-name').textContent = cam.name;
    $('.wv-sub').textContent = v.bearing === null ? 'Direction unknown'
      : `Looking ${Math.round(v.bearing)}° ${compassPoint(v.bearing)}${v.target ? ` towards ${v.target}` : ''} · ${Math.round(v.fov)}° wide · lens ${Math.round(v.height)} m above sea`;
  }

  function adjustForm() {
    const v = cam.view;
    const b = v.bearing ?? 0;
    const row = (k, label, min, max, step, val, unit) =>
      `<label><span>${label}<b data-out="${k}">${val}${unit}</b></span><input type="range" name="${k}" min="${min}" max="${max}" step="${step}" value="${val}"></label>`;
    $('.wv-adjust').innerHTML = `
      ${row('bearing', 'Direction', 0, 359.5, 0.5, b, '°')}
      ${row('fov', 'Width of view', 10, 120, 1, v.fov, '°')}
      ${row('tilt', 'Tilt down', -10, 30, 0.25, v.tilt, '°')}
      ${row('height', 'Lens above sea', 1, 400, 1, Math.round(v.height), ' m')}
      <p class="wv-hint">Turn the direction until a landmark sits under its name (▾ at the top), and tilt until the dashed line lies on the sea's horizon. Kept on this device.</p>
      <div class="wv-actions"><button type="button" class="wv-btn" data-wv="reset">Back to worked out</button></div>`;
  }

  function draw() {
    if (!cam) return;
    const r = rect();
    const v = cam.view;
    const parts = [];
    const ships = [];
    const edges = { left: [], right: [] };
    if (v.bearing !== null) {
      // the sea's horizon and the place the camera looks to, to line the view up by
      const hy = pictureY(v, horizonDip(v.height), aspect);
      if (hy > 0 && hy < 1) parts.push(`<div class="wv-horizon" style="top:${r.y + hy * r.h}px;left:${r.x}px;width:${r.w}px"></div>`);
      const target = v.target && v.targetBearing !== null ? pictureX(v, v.targetBearing) : null;
      if (target !== null) parts.push(`<div class="wv-target" style="left:${r.x + target * r.w}px;top:${r.y}px">${esc(cam.view.target)} ▾</div>`);
      for (const s of ais.vesselsNear(cam.lat, cam.lon, SHIP_RANGE_M)) {
        const at = ais.shownShip(s) ?? { lat: s.latitude, lon: s.longitude };
        const { length, beam } = vesselSize(s);
        const heading = Number.isFinite(at.heading) ? at.heading : (s.trueHeading < 360 ? s.trueHeading : null);
        const p = projectShip(cam, at, { length, beam }, heading, aspect);
        if (!p) continue;
        if (p.inView) ships.push({ s, p });
        else if (Math.abs(p.rel) < v.fov / 2 + 40 && p.distance <= SHIP_RANGE_M) edges[p.rel < 0 ? 'left' : 'right'].push({ s, p });
      }
    }
    // Nearest last, so it is drawn on top; tags are stacked so they do not cover each other.
    ships.sort((a, b) => b.p.distance - a.p.distance);
    const tags = [];
    for (const { s, p } of ships) {
      const x = r.x + p.x * r.w, y = r.y + p.y * r.h, top = r.y + p.top * r.h;
      const w = Math.max(10, p.half * 2 * r.w), h = Math.max(6, y - top);
      let ty = top - 46;
      for (const t of tags) if (Math.abs(t.x - x) < 150 && Math.abs(t.y - ty) < 40) ty = t.y - 42;
      ty = Math.max(r.y + 2, ty);
      tags.push({ x, y: ty });
      const tx = Math.min(r.x + r.w - 80, Math.max(r.x + 80, x)); // the tag stays inside the picture
      const name = (s.name || '').trim() || `MMSI ${s.mmsi}`;
      const sog = s.speedOverGround != null ? `${s.speedOverGround.toFixed(1)} kn` : '';
      const cog = s.courseOverGround != null && s.courseOverGround < 360 ? ` ${Math.round(s.courseOverGround)}°` : '';
      parts.push(`<div class="wv-box" style="left:${x - w / 2}px;top:${top}px;width:${w}px;height:${h}px"></div>
        <div class="wv-lead" style="left:${x}px;top:${ty + 34}px;height:${Math.max(0, top - ty - 34)}px"></div>
        <button type="button" class="wv-tag" data-mmsi="${s.mmsi}" style="left:${tx}px;top:${ty}px">
          <b>${esc(name)}</b><small>${esc(typeName(s.shipType))} · ${formatDistance(p.distance)}${sog ? ` · ${sog}${cog}` : ''}</small></button>`);
    }
    for (const side of ['left', 'right']) {
      edges[side].sort((a, b) => a.p.distance - b.p.distance).slice(0, 5).forEach(({ s, p }, i) => {
        const name = (s.name || '').trim() || `MMSI ${s.mmsi}`;
        parts.push(`<button type="button" class="wv-edge ${side}" data-mmsi="${s.mmsi}" style="top:${r.y + r.h - 44 - i * 34}px;${side}:${side === 'left' ? r.x + 6 : 6 + r.x}px">
          ${side === 'left' ? '◀ ' : ''}${esc(name)} · ${formatDistance(p.distance)}${side === 'right' ? ' ▶' : ''}</button>`);
      });
    }
    overlay.innerHTML = parts.join('');
    const n = ships.length;
    const st = $('.wv-status');
    st.textContent = !ais.working
      ? 'Ships (AIS) are off: switch them on under the layers button to see the ships on the picture.'
      : v.bearing === null ? 'Direction unknown: set it with Adjust view.' : n ? `${n} ship${n === 1 ? '' : 's'} in view` : 'No ships with AIS in view now';
    st.classList.toggle('warn', !ais.working);
  }

  function enter(c) {
    cam = webcams.camera(c.id) ?? c;
    before ??= { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
    // The chart goes round the camera, so the ships near it are asked for (AIS asks for the view).
    const d = SHIP_RANGE_M * 0.8, dLat = d / 111_320, dLon = d / (111_320 * Math.cos((cam.lat * Math.PI) / 180));
    map.fitBounds([[cam.lon - dLon, cam.lat - dLat], [cam.lon + dLon, cam.lat + dLat]], { duration: 0, pitch: 0, bearing: 0 });
    el.hidden = false;
    document.body.classList.add('webcam-on');
    adjusting = false;
    $('[data-wv="adjust"]').setAttribute('aria-pressed', 'false');
    $('.wv-adjust').hidden = true;
    header();
    note();
    msg.hidden = true;
    picture();
    clearInterval(refresh); clearInterval(tick);
    refresh = setInterval(picture, REFRESH_MS);
    tick = setInterval(draw, SHIPS_MS);
    onEnter(cam);
    draw();
  }

  function exit() {
    if (!cam) return;
    clearInterval(refresh); clearInterval(tick);
    el.hidden = true;
    document.body.classList.remove('webcam-on');
    img.removeAttribute('src');
    overlay.innerHTML = '';
    const was = cam;
    cam = null;
    if (before) map.jumpTo(before);
    before = null;
    onExit(was);
  }

  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !cam) return;
    if (b.dataset.mmsi) {
      const v = ais.vessel(b.dataset.mmsi);
      exit();
      if (v) onShip(v);
      return;
    }
    const a = b.dataset.wv;
    if (a === 'exit') exit();
    else if (a === 'refresh') picture();
    else if (a === 'adjust') {
      adjusting = !adjusting;
      b.setAttribute('aria-pressed', String(adjusting));
      $('.wv-adjust').hidden = !adjusting;
      if (adjusting) adjustForm();
    } else if (a === 'reset') {
      cam = webcams.calibrate(cam.id, null);
      adjustForm(); header(); note(); draw();
    }
  });
  el.addEventListener('input', (e) => {
    const t = e.target;
    if (!cam || !t.closest('.wv-adjust') || t.type !== 'range') return;
    const val = Number(t.value);
    const out = el.querySelector(`[data-out="${t.name}"]`);
    if (out) out.textContent = `${val}${t.name === 'height' ? ' m' : '°'}`;
    cam = webcams.calibrate(cam.id, { [t.name]: val });
    header(); note(); draw();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && cam && !e.target.closest?.('input')) exit(); });
  window.addEventListener('resize', () => cam && draw());

  return {
    enter,
    exit,
    get active() { return cam !== null; },
    get camera() { return cam; },
  };
}

/** The ships a camera sees now (for its card): those in its field of view within range. */
export function shipsInView(cam, ais) {
  if (!cam || cam.view.bearing === null || !ais.working) return [];
  const out = [];
  for (const s of ais.vesselsNear(cam.lat, cam.lon, SHIP_RANGE_M)) {
    const at = ais.shownShip(s) ?? { lat: s.latitude, lon: s.longitude };
    const { length, beam } = vesselSize(s);
    const p = projectShip(cam, at, { length, beam }, at.heading ?? null);
    if (p?.inView) out.push({ s, p });
  }
  return out.sort((a, b) => a.p.distance - b.p.distance);
}

