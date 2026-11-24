// Taking the helm of a ship: the user commands it from a bridge console (engine telegraph, steering stick,
// thrusters where the type has them, and the usual instruments), and the ship moves by the handling
// model in shiphandling.js. Its real AIS reports are ignored meanwhile (aismap.js); handing it back
// lets the next real report put it where it really is. It cannot sail through other ships or onto
// the bottom or the shore (contact.js).
//
// As on a real bridge, orders take time: the rudder turns at a few degrees a second, thrusters
// spool up, and the engine's speed builds up or dies away with the ship's inertia. Every couple of
// seconds the hull is sounded at its bow, stern, antenna and sides (Kartverket's height service:
// depth at sea, height on land); land, or less water than the draught, at any of them is aground.

import {
  TELEGRAPH, RUDDER_MAX, handlingFor, initialState, neutralControls, step, overGround, simReport, thrusterGrip, telegraphPower,
} from './shiphandling.js';
import { hullAt, deepestContact, soundingPoints, seabedUrl, parseSeabed, groundCheck, allowedMotion } from './contact.js';

const REPORT_MS = 500; // how often the chart symbols and card follow the simulated ship
const DEPTH_MS = 2000;
const NEAR_M = 2500; // other ships this close are checked for contact
const THRUSTER_RATE = 0.5; // share of full thrust gained or lost per second
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const towards = (x, target, maxStep) => x + clamp(target - x, -maxStep, maxStep);

/** Rudder speed, degrees per second: about 28 s hard over to hard over on a big ship, quicker on a small one. */
export const rudderRate = (length) => (length < 60 ? 6 : 2.5);

/** The telegraph order nearest to a speed, so taking the helm does not change what the engine is doing. */
export function orderForSpeed(u, h) {
  const share = u >= 0 ? u / h.aheadMs : u / h.asternMs;
  let best = TELEGRAPH[4];
  for (const t of TELEGRAPH) if (Math.abs(t.power - share) < Math.abs(best.power - share)) best = t;
  return best.order;
}

/**
 * The steering stick: its position across its track (0 = hard to port, 1 = hard to starboard) as a
 * rudder order in whole degrees, with a small dead band at midships so it is easy to centre.
 */
export function stickToRudder(frac) {
  const deg = (Math.min(1, Math.max(0, frac)) * 2 - 1) * RUDDER_MAX;
  return Math.abs(deg) < 1.5 ? 0 : Math.round(deg);
}

/** Where a rudder angle sits on the stick's track, 0..100 %. */
export const rudderToStick = (deg) => 50 + (Math.max(-RUDDER_MAX, Math.min(RUDDER_MAX, deg)) / RUDDER_MAX) * 50;

/** Short telegraph labels for the one-row telegraph. */
const SHORT = { 4: 'Full', 3: 'Half', 2: 'Slow', 1: 'D.slow', 0: 'Stop' };

export function createHelm(map, { ais, bridge, el, onStatus = () => {} }) {
  let v0 = null; // the ship's last real report when the helm was taken (name, size, type)
  let h = null; // handling
  let s = null; // simulation state
  const c = neutralControls(); // orders
  const actual = { rudder: 0, bow: 0, stern: 0 }; // what the steering gear and thrusters have reached
  let frame = 0, last = 0, lastReport = 0, lastDepth = 0;
  let depth = { depth: null, text: '—', hit: null, busy: false }; // last sounding; hit: where aground
  let contact = null; // the ship we are touching, if any
  let stickDrag = null; // the steering stick's track while it is dragged
  let roomObserver = null;

  function makeRoom() {
    document.documentElement.style.setProperty('--helm-room', `${el.offsetHeight}px`);
    map.resize();
  }

  const where = () => (s ? { lat: s.lat, lon: s.lon, heading: s.heading } : null);

  function render() {
    const order = TELEGRAPH.find((t) => t.order === c.order);
    const thr = (t) => `<label class="thr ${h[t] ? '' : 'none'}" title="${h[t] ? `${t === 'bow' ? 'Q / E' : 'Z / C'}, double-click to stop` : 'None on this ship'}">
        <span>${t === 'bow' ? 'Bow' : 'Stern'}</span>
        <input type="range" min="-100" max="100" step="5" value="${Math.round(c[t] * 100)}" data-thruster="${t}" ${h[t] ? '' : 'disabled'} aria-label="${t} thruster, port to starboard">
        <b data-i="${t}">${h[t] ? '0' : '–'}</b></label>`;
    el.innerHTML = `
      <div class="helm-alarm" data-i="alarm" role="alert" hidden></div>
      <div class="helm-strip" role="group" aria-label="Instruments">
        <span class="ds"><i>HDG</i><b data-i="hdg">—</b></span>
        <span class="ds"><i>SOG</i><b data-i="sog">—</b><em data-i="stw"></em></span>
        <span class="ds"><i>ROT</i><b data-i="rot">—</b></span>
        <span class="ds"><i>Rudder</i><b data-i="rudder">—</b></span>
        <span class="ds" data-i="depth-box"><i>Depth</i><b data-i="depth">—</b><em data-i="draught"></em></span>
      </div>
      <div class="helm-row">
        <div class="telegraph" role="radiogroup" aria-label="Engine telegraph (W / S)">
          <span class="tg-cap astern">Astern</span><span class="tg-cap ahead">Ahead</span>
          <div class="tg-buttons">${TELEGRAPH.map((t) => `<button type="button" role="radio" data-order="${t.order}" aria-checked="${t.order === c.order}"
            aria-label="${esc(t.label)}" class="${t.order > 0 ? 'ahead' : t.order < 0 ? 'astern' : 'stop'}">${SHORT[Math.abs(t.order)]}</button>`).join('')}</div>
          <div class="tg-answer" title="Engine answer: the speed the ship has reached"><i data-i="answer"></i></div>
        </div>
        <div class="steer">
          <span class="steer-cap">Steering (A / D, X midships)</span>
          <div class="steer-row">
            <small class="port">P</small>
            <div class="stick" data-stick role="slider" tabindex="0" aria-label="Rudder order" aria-valuemin="-${RUDDER_MAX}" aria-valuemax="${RUDDER_MAX}" aria-valuenow="${c.rudder}">
              <span class="stick-scale"></span><span class="stick-actual" data-i="stick-actual" title="Where the rudder is"></span>
              <span class="stick-knob" data-i="stick-knob"></span>
            </div>
            <small class="stbd">S</small>
          </div>
          <div class="steer-buttons">
            <button type="button" data-rudder="-${RUDDER_MAX}">Hard port</button><button type="button" data-rudder="0">Midships</button><button type="button" data-rudder="${RUDDER_MAX}">Hard stbd</button>
          </div>
        </div>
        <div class="thrusters">${thr('bow')}${thr('stern')}</div>
        <div class="helm-buttons">
          <button type="button" data-helm-bridge>Bridge view</button>
          <button type="button" class="helm-release" data-helm-release>Hand back</button>
        </div>
      </div>
      <span class="sr-only" aria-live="polite" data-i="order-said">${esc(order?.label ?? '')}</span>`;
    update(true);
  }

  function update(all = false) {
    if (!s) return;
    const q = (k) => el.querySelector(`[data-i="${k}"]`);
    const { sog } = overGround(s);
    q('hdg').textContent = `${s.heading.toFixed(1).padStart(5, '0')}°`;
    q('sog').textContent = `${sog.toFixed(1)} kn`;
    q('stw').textContent = s.u < -0.05 ? 'astern' : Math.abs(s.v) > 0.05 ? `${Math.abs(s.v * 3600 / 1852).toFixed(1)} kn to ${s.v > 0 ? 'stbd' : 'port'}` : '';
    const rot = s.r * 180 / Math.PI * 60;
    q('rot').textContent = `${Math.abs(rot) < 0.5 ? '0' : Math.abs(rot).toFixed(0)}°/min ${rot > 0.5 ? 'S' : rot < -0.5 ? 'P' : ''}`;
    q('rudder').textContent = Math.abs(actual.rudder) < 0.5 ? 'mid' : `${Math.abs(actual.rudder).toFixed(0)}° ${actual.rudder > 0 ? 'S' : 'P'}`;
    q('stick-knob').style.left = `${rudderToStick(c.rudder)}%`;
    q('stick-actual').style.left = `${rudderToStick(actual.rudder)}%`;
    el.querySelector('[data-stick]')?.setAttribute('aria-valuenow', String(c.rudder));
    for (const t of ['bow', 'stern']) {
      const tv = q(t);
      if (tv) {
        tv.textContent = h[t] ? `${Math.round(Math.abs(actual[t]) * 100)}${actual[t] > 0.02 ? 'S' : actual[t] < -0.02 ? 'P' : ''}` : '–';
        tv.title = h[t] && thrusterGrip(s.u) < 0.99 ? `Grip ${Math.round(thrusterGrip(s.u) * 100)} % at this speed` : '';
      }
    }
    const ans = q('answer');
    const share = s.u >= 0 ? s.u / h.aheadMs : s.u / h.asternMs;
    ans.style.width = `${clamp(Math.abs(share), 0, 1) * 50}%`;
    ans.style.left = share >= 0 ? '50%' : `${50 - clamp(Math.abs(share), 0, 1) * 50}%`;
    ans.className = share >= 0 ? 'ahead' : 'astern';
    q('depth').textContent = depth.text;
    q('draught').textContent = `/ ${h.draught.toFixed(1)}`;
    q('depth-box').classList.toggle('shallow', depth.depth != null && depth.depth < h.draught + 2);
    const alarm = q('alarm');
    const away = { bow: 'go astern', stern: 'go ahead', antenna: 'go astern', 'port side': 'push to starboard', 'starboard side': 'push to port' };
    const msg = contact
      ? `COLLISION with ${(contact.name || '').trim() || `MMSI ${contact.mmsi}`} — back away`
      : depth.hit
        ? `AGROUND at the ${depth.hit.name}${depth.hit.reason === 'land' ? ' (land or quay)' : ` (${depth.hit.depth.toFixed(1)} m of water)`} — ${away[depth.hit.name]} to get off`
        : '';
    alarm.hidden = !msg;
    alarm.textContent = msg;
    if (all) for (const b of el.querySelectorAll('[data-order]')) b.setAttribute('aria-checked', String(Number(b.dataset.order) === c.order));
  }

  async function sound() {
    if (!s || depth.busy) return;
    depth.busy = true;
    try {
      const points = soundingPoints(v0, s);
      const res = await fetch(seabedUrl(points.map((p) => p.p)));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { hit, depth: d } = groundCheck(points, parseSeabed(await res.json()), h.draught);
      const was = depth.hit;
      depth = { depth: d, text: d != null ? `${d.toFixed(1)} m` : hit?.reason === 'land' ? 'land' : '—', hit, busy: false };
      if (hit && !was && s) { s = allowedMotion(hit, { ...s, r: 0 }); onStatus(`Aground at the ${hit.name}!`); }
    } catch {
      depth.busy = false; // offline or the service is busy: try again later
    }
  }

  /** Other ships near ours, as outlines around our position, where they are drawn now. */
  function nearbyHulls(origin) {
    const out = [];
    for (const v of ais.vesselsNear(origin.lat, origin.lon, NEAR_M)) {
      if (v.mmsi === v0.mmsi) continue;
      out.push({ v, hull: hullAt(v, ais.shownShip(v), origin) });
    }
    return out;
  }

  function loop(t) {
    frame = requestAnimationFrame(loop);
    const dt = last ? (t - last) / 1000 : 0;
    last = t;
    if (!s || dt <= 0) return;
    actual.rudder = towards(actual.rudder, c.rudder, rudderRate(h.length) * dt);
    actual.bow = towards(actual.bow, h.bow ? c.bow : 0, THRUSTER_RATE * dt);
    actual.stern = towards(actual.stern, h.stern ? c.stern : 0, THRUSTER_RATE * dt);
    let next = step(s, { order: c.order, rudder: actual.rudder, bow: actual.bow, stern: actual.stern }, h, dt);
    // Aground, the ship moves only away from where it touches.
    if (depth.hit) {
      const free = allowedMotion(depth.hit, next);
      if (free.u !== next.u || free.v !== next.v) next = { ...free, lat: s.lat, lon: s.lon };
    }
    // Other ships: a move that pushes deeper into one is refused, and the ship is stopped.
    const origin = { lat: s.lat, lon: s.lon };
    const others = nearbyHulls(origin);
    const before = deepestContact(hullAt(v0, s, origin), others).depth;
    const after = deepestContact(hullAt(v0, next, origin), others);
    // Any deepening is refused (beyond a few centimetres of touching), however small the step, so the
    // ship cannot creep in a little at a time.
    if (after.depth > before + 1e-6 && after.depth > 0.05) {
      if (!contact) onStatus(`Collision with ${(after.v.name || '').trim() || after.v.mmsi}!`);
      contact = after.v;
      next = { ...s, u: 0, v: 0, r: 0 };
    } else {
      contact = after.depth > 0 ? after.v : null;
    }
    s = next;
    const now = Date.now();
    if (now - lastReport > REPORT_MS) { lastReport = now; ais.setReport(simReport(v0, s, now)); update(); }
    if (now - lastDepth > DEPTH_MS) { lastDepth = now; sound(); }
    map.triggerRepaint();
  }

  function setOrder(order) {
    c.order = clamp(order, -4, 4);
    for (const b of el.querySelectorAll('[data-order]')) b.setAttribute('aria-checked', String(Number(b.dataset.order) === c.order));
    const said = el.querySelector('[data-i="order-said"]');
    if (said) said.textContent = TELEGRAPH.find((t) => t.order === c.order)?.label ?? '';
  }
  const setRudder = (deg) => { c.rudder = clamp(Math.round(deg), -RUDDER_MAX, RUDDER_MAX); update(); };
  function setThruster(which, value) {
    if (!h[which]) return;
    c[which] = clamp(value, -1, 1);
    const input = el.querySelector(`[data-thruster="${which}"]`);
    if (input) input.value = String(Math.round(c[which] * 100));
  }

  // ---------- console input ----------
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.order !== undefined) setOrder(Number(b.dataset.order));
    else if (b.dataset.rudder !== undefined) setRudder(Number(b.dataset.rudder));
    else if (b.hasAttribute('data-helm-release')) release();
    else if (b.hasAttribute('data-helm-bridge')) { if (bridge.active) bridge.exit(); else bridge.enter(ais.vessel(v0.mmsi) ?? v0); }
  });
  el.addEventListener('input', (e) => {
    const t = e.target.dataset.thruster;
    if (t) setThruster(t, Number(e.target.value) / 100);
  });
  // A double click (or tap) on a thruster puts it back to zero.
  el.addEventListener('dblclick', (e) => { const t = e.target.dataset?.thruster; if (t) setThruster(t, 0); });
  // The steering stick: drag (or tap) along its track; the rudder order follows the stick's position.
  const stickAt = (track, x) => { const r = track.getBoundingClientRect(); return stickToRudder((x - r.left) / r.width); };
  el.addEventListener('pointerdown', (e) => {
    const track = e.target.closest('[data-stick]');
    if (!track) return;
    stickDrag = track;
    track.setPointerCapture(e.pointerId);
    setRudder(stickAt(track, e.clientX));
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => { if (stickDrag) setRudder(stickAt(stickDrag, e.clientX)); });
  el.addEventListener('pointerup', () => { stickDrag = null; });
  el.addEventListener('pointercancel', () => { stickDrag = null; });
  el.addEventListener('dblclick', (e) => { if (e.target.closest('[data-stick]')) setRudder(0); });
  // With the stick focused, the arrow keys move it a degree at a time (Home: midships).
  el.addEventListener('keydown', (e) => {
    if (!e.target.closest('[data-stick]')) return;
    if (e.key === 'ArrowLeft') setRudder(c.rudder - 1);
    else if (e.key === 'ArrowRight') setRudder(c.rudder + 1);
    else if (e.key === 'Home') setRudder(0);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });

  function onKey(e) {
    if (!s || e.target.closest?.('input[type=search], input[type=text], textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.code;
    if (k === 'KeyW' || k === 'PageUp') setOrder(c.order + 1);
    else if (k === 'KeyS' || k === 'PageDown') setOrder(c.order - 1);
    else if (k === 'KeyA') setRudder(c.rudder - 5);
    else if (k === 'KeyD') setRudder(c.rudder + 5);
    else if (k === 'KeyX') setRudder(0);
    else if (k === 'KeyQ') setThruster('bow', c.bow - 0.25);
    else if (k === 'KeyE') setThruster('bow', c.bow + 0.25);
    else if (k === 'KeyZ') setThruster('stern', c.stern - 0.25);
    else if (k === 'KeyC') setThruster('stern', c.stern + 0.25);
    else return;
    e.preventDefault();
  }

  // ---------- taking and handing back ----------
  function take(v) {
    if (s) release();
    v0 = v;
    h = handlingFor(v);
    // Start from where the ship is shown now, at its speed, with the engine doing what it was doing.
    const at = ais.shownShip(v);
    s = { ...initialState(v), lat: at.lat, lon: at.lon, heading: at.heading ?? initialState(v).heading };
    Object.assign(c, neutralControls(), { order: orderForSpeed(s.u, h) });
    Object.assign(actual, { rudder: 0, bow: 0, stern: 0 });
    depth = { depth: null, text: '—', hit: null, busy: false };
    contact = null;
    lastDepth = 0;
    ais.setControlled(v.mmsi, where);
    ais.setReport(simReport(v0, s));
    render();
    el.hidden = false;
    document.body.classList.add('helm-on');
    // The map makes room for the console: it ends where the console begins, so the bridge view is
    // centred in the window above it (as on a real bridge) and nothing hides behind the console.
    roomObserver = new ResizeObserver(() => makeRoom());
    roomObserver.observe(el);
    makeRoom();
    document.addEventListener('keydown', onKey);
    if (!bridge.active || bridge.mmsi !== v.mmsi) bridge.enter(ais.vessel(v.mmsi) ?? v);
    last = 0;
    frame = requestAnimationFrame(loop);
    onStatus(`You have the helm of ${(v.name || '').trim() || `MMSI ${v.mmsi}`}.`);
  }

  function release() {
    if (!s) return;
    cancelAnimationFrame(frame);
    const mmsi = v0.mmsi;
    s = null;
    el.hidden = true;
    el.innerHTML = '';
    document.body.classList.remove('helm-on');
    roomObserver?.disconnect();
    roomObserver = null;
    document.documentElement.style.removeProperty('--helm-room');
    map.resize();
    document.removeEventListener('keydown', onKey);
    ais.setControlled(null);
    onStatus('The helm is handed back: the ship follows its real AIS reports again.');
    return mmsi;
  }

  return {
    take, release,
    get active() { return s !== null; },
    get mmsi() { return s ? v0.mmsi : null; },
    /** Engine power share now (for tests and the console). */
    get power() { return telegraphPower(c.order); },
  };
}
