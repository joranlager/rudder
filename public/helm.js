// Taking the helm of a ship: the user commands it from a bridge console (engine telegraph, wheel,
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

/** A ship's wheel, drawn as SVG: rim, eight spokes with handles, hub. The group turns with the helm. */
function wheelSvg() {
  const spokes = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4, x = Math.sin(a), y = -Math.cos(a);
    return `<line x1="${50 + 9 * x}" y1="${50 + 9 * y}" x2="${50 + 47 * x}" y2="${50 + 47 * y}"/>
      <circle class="handle" cx="${50 + 47 * x}" cy="${50 + 47 * y}" r="3.2"/>`;
  }).join('');
  return `<svg viewBox="0 0 100 100" class="wheel-svg" aria-hidden="true"><g class="wheel-turn">
    <circle class="rim" cx="50" cy="50" r="36"/><circle class="rim-in" cx="50" cy="50" r="33"/>${spokes}
    <circle class="hub" cx="50" cy="50" r="9"/><circle class="king" cx="50" cy="${50 - 36}" r="2.4"/></g></svg>`;
}

/** The rudder angle indicator: an arc from 35° port (red) to 35° starboard (green), with the order and the actual angle. */
function rudderGauge() {
  const arc = (from, to, cls) => {
    const p = (a) => { const r = ((a / RUDDER_MAX) * 70 - 90) * Math.PI / 180; return [60 + 46 * Math.cos(r), 56 + 46 * Math.sin(r)]; };
    const [x1, y1] = p(from), [x2, y2] = p(to);
    return `<path class="${cls}" d="M${x1.toFixed(1)},${y1.toFixed(1)} A46,46 0 0 1 ${x2.toFixed(1)},${y2.toFixed(1)}"/>`;
  };
  return `<svg viewBox="0 0 120 64" class="rudder-gauge" aria-hidden="true">
    ${arc(-RUDDER_MAX, 0, 'port')}${arc(0, RUDDER_MAX, 'stbd')}
    <g class="order-mark"><line x1="60" y1="6" x2="60" y2="16"/></g>
    <g class="needle"><line x1="60" y1="56" x2="60" y2="14"/></g><circle class="pivot" cx="60" cy="56" r="3"/>
    <text x="10" y="62">P</text><text x="106" y="62">S</text></svg>`;
}

/** The compass card of the gyro repeater, turning so the heading is at the top. */
function gyroSvg() {
  const ticks = Array.from({ length: 36 }, (_, i) => {
    const a = (i * 10 * Math.PI) / 180, long = i % 9 === 0, r1 = long ? 33 : 37;
    return `<line x1="${50 + r1 * Math.sin(a)}" y1="${50 - r1 * Math.cos(a)}" x2="${50 + 42 * Math.sin(a)}" y2="${50 - 42 * Math.cos(a)}"${long ? ' class="major"' : ''}/>`;
  }).join('');
  const labels = ['N', 'E', 'S', 'W'].map((t, i) => {
    const a = (i * 90 * Math.PI) / 180;
    return `<text x="${50 + 25 * Math.sin(a)}" y="${54 - 25 * Math.cos(a)}">${t}</text>`;
  }).join('');
  return `<svg viewBox="0 0 100 100" class="gyro" aria-hidden="true"><g class="card">${ticks}${labels}</g>
    <path class="lubber" d="M50,3 L46,12 L54,12 Z"/></svg>`;
}

export function createHelm(map, { ais, bridge, el, onStatus = () => {} }) {
  let v0 = null; // the ship's last real report when the helm was taken (name, size, type)
  let h = null; // handling
  let s = null; // simulation state
  const c = neutralControls(); // orders
  const actual = { rudder: 0, bow: 0, stern: 0 }; // what the steering gear and thrusters have reached
  let frame = 0, last = 0, lastReport = 0, lastDepth = 0;
  let depth = { depth: null, text: '—', hit: null, busy: false }; // last sounding; hit: where aground
  let contact = null; // the ship we are touching, if any
  let wheelDrag = null;

  const where = () => (s ? { lat: s.lat, lon: s.lon, heading: s.heading } : null);

  function render() {
    const order = TELEGRAPH.find((t) => t.order === c.order);
    el.innerHTML = `
      <div class="helm-alarm" data-i="alarm" role="alert" hidden></div>
      <div class="helm-instruments" role="group" aria-label="Instruments">
        <div class="inst gyro-wrap">${gyroSvg()}<div><span class="inst-label">Heading</span><b data-i="hdg">—</b></div></div>
        <div class="inst"><span class="inst-label">Speed over ground</span><b data-i="sog">—</b><span class="inst-sub" data-i="stw"></span></div>
        <div class="inst"><span class="inst-label">Rate of turn</span><b data-i="rot">—</b><div class="rot-bar"><i data-i="rot-bar"></i></div></div>
        <div class="inst"><span class="inst-label">Rudder</span>${rudderGauge()}<b data-i="rudder">—</b></div>
        <div class="inst" data-i="depth-box"><span class="inst-label">Depth under the keel</span><b data-i="depth">—</b><span class="inst-sub" data-i="draught"></span></div>
      </div>
      <div class="helm-controls">
        <div class="telegraph" role="radiogroup" aria-label="Engine telegraph">
          <span class="tg-head">Ahead</span>
          ${[...TELEGRAPH].reverse().map((t) => `<button type="button" role="radio" data-order="${t.order}" aria-checked="${t.order === c.order}"
              aria-label="${esc(t.label)}" class="${t.order > 0 ? 'ahead' : t.order < 0 ? 'astern' : 'stop'}">${esc(t.label.replace(/ (ahead|astern)$/i, ''))}</button>`).join('')}
          <span class="tg-head">Astern</span>
          <div class="tg-answer" title="Engine answer"><i data-i="answer"></i></div>
        </div>
        <div class="helm-wheel">
          <div class="wheel" data-wheel title="Drag to turn the wheel (A / D)">${wheelSvg()}</div>
          <div class="wheel-buttons">
            <button type="button" data-rudder="-${RUDDER_MAX}" title="Hard to port">Hard port</button>
            <button type="button" data-rudder="0" title="Midships (X)">Midships</button>
            <button type="button" data-rudder="${RUDDER_MAX}" title="Hard to starboard">Hard stbd</button>
          </div>
        </div>
        <div class="thrusters">
          ${['bow', 'stern'].map((t) => `<label class="thruster ${h[t] ? '' : 'none'}">
            <span>${t === 'bow' ? 'Bow thruster' : 'Stern thruster'}${h[t] ? '' : ' <em>(none on this ship)</em>'}</span>
            <span class="thr-row"><small>P</small><input type="range" min="-100" max="100" step="5" value="${Math.round(c[t] * 100)}" data-thruster="${t}" ${h[t] ? '' : 'disabled'}
              aria-label="${t} thruster, port to starboard"><small>S</small></span>
            <span class="thr-value" data-i="${t}">0</span></label>`).join('')}
          <p class="helm-keys">W/S engine · A/D rudder · X midships${h.bow ? ' · Q/E bow' : ''}${h.stern ? ' · Z/C stern' : ''}</p>
          <div class="helm-buttons"><button type="button" class="helm-view" data-helm-bridge>Bridge view</button>
          <button type="button" class="helm-release" data-helm-release>Hand back the helm</button></div>
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
    el.querySelector('.gyro .card')?.setAttribute('transform', `rotate(${-s.heading} 50 50)`);
    q('sog').textContent = `${sog.toFixed(1)} kn`;
    q('stw').textContent = s.u < -0.05 ? 'going astern' : Math.abs(s.v) > 0.05 ? `sideways ${Math.abs(s.v * 3600 / 1852).toFixed(1)} kn ${s.v > 0 ? 'stbd' : 'port'}` : '';
    const rot = s.r * 180 / Math.PI * 60;
    q('rot').textContent = `${Math.abs(rot) < 0.5 ? '0' : Math.abs(rot).toFixed(0)}°/min ${rot > 0.5 ? 'stbd' : rot < -0.5 ? 'port' : ''}`;
    const bar = q('rot-bar');
    const w = clamp(Math.abs(rot) / 60, 0, 1) * 50;
    bar.style.left = rot >= 0 ? '50%' : `${50 - w}%`;
    bar.style.width = `${w}%`;
    bar.className = rot >= 0 ? 'stbd' : 'port';
    q('rudder').textContent = `${Math.abs(actual.rudder).toFixed(0)}° ${actual.rudder > 0.5 ? 'stbd' : actual.rudder < -0.5 ? 'port' : 'midships'}`;
    el.querySelector('.rudder-gauge .needle')?.setAttribute('transform', `rotate(${(actual.rudder / RUDDER_MAX) * 70} 60 56)`);
    el.querySelector('.rudder-gauge .order-mark')?.setAttribute('transform', `rotate(${(c.rudder / RUDDER_MAX) * 70} 60 56)`);
    el.querySelector('.wheel-turn')?.setAttribute('transform', `rotate(${c.rudder * 4} 50 50)`);
    for (const t of ['bow', 'stern']) {
      const tv = q(t);
      if (tv) tv.textContent = h[t] ? `${Math.round(Math.abs(actual[t]) * 100)}% ${actual[t] > 0.02 ? 'stbd' : actual[t] < -0.02 ? 'port' : ''}${thrusterGrip(s.u) < 0.99 && Math.abs(actual[t]) > 0.02 ? ` · grip ${Math.round(thrusterGrip(s.u) * 100)}%` : ''}` : '—';
    }
    const ans = q('answer');
    const share = s.u >= 0 ? s.u / h.aheadMs : s.u / h.asternMs;
    ans.style.height = `${clamp(Math.abs(share), 0, 1) * 50}%`;
    ans.style.bottom = share >= 0 ? '50%' : `${50 - clamp(Math.abs(share), 0, 1) * 50}%`;
    ans.className = share >= 0 ? 'ahead' : 'astern';
    q('depth').textContent = depth.text;
    q('draught').textContent = `draught ${h.draught.toFixed(1)} m`;
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
  // The wheel turns by dragging around its hub: four degrees of wheel for one of rudder.
  el.addEventListener('pointerdown', (e) => {
    const w = e.target.closest('[data-wheel]');
    if (!w) return;
    const r = w.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    wheelDrag = { cx, cy, angle: Math.atan2(e.clientX - cx, cy - e.clientY), start: c.rudder };
    w.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if (!wheelDrag) return;
    const a = Math.atan2(e.clientX - wheelDrag.cx, wheelDrag.cy - e.clientY);
    let d = ((a - wheelDrag.angle) * 180) / Math.PI;
    d = ((d + 540) % 360) - 180;
    wheelDrag.start += d / 4;
    wheelDrag.angle = a;
    setRudder(wheelDrag.start);
  });
  el.addEventListener('pointerup', () => { wheelDrag = null; });
  el.addEventListener('pointercancel', () => { wheelDrag = null; });

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
