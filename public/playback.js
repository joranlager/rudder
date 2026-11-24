// Playing back recorded AIS positions (trackstore.js) on the chart, as if live.
//
// Playback has its own clock: it starts at a chosen time, runs at a chosen speed (1x .. 600x) and can
// be moved with a slider. Every frame each ship is placed on the smooth curve between its recorded
// positions around that time (track.js positionAt), so the 3D ships glide; the chart's symbols
// follow a few times a second. Positions are read from the store in windows of an hour around the
// clock, read again as the clock moves on.
//
// Traces: a ship can be given a coloured trace of where it has been since playback began (or since
// the trace was switched on); each trace can be shown or hidden as the ship moves.

import { positionAt, traceCoords, playbackReport, TRACE_COLORS, MAX_GAP_MS, HOLD_MS } from './track.js';

const MAX_HOLD_MS = 120 * 60e3; // the longest a ship is held after its last record (track.js holdFor)

const WINDOW_MS = 60 * 60e3; // positions read around the clock: half an hour each way
const SYMBOLS_MS = 250; // how often the chart symbols follow
const TRACE_MS = 1000; // how often traces grow
const TRACE_SOURCE = 'track-traces';

export function createPlayback(map, { ais, storePromise, onTick = () => {}, onEnd = () => {} }) {
  let active = false, playing = false, speed = 60;
  let t = 0, startT = 0, endT = 0, floorT = 0; // clock, where playback began, the newest recorded time, the earliest to go back to
  let byShip = new Map(); // mmsi -> records sorted by time, for the window loaded
  let win = null; // [t0, t1] loaded
  let loading = null;
  let ships = new Map(); // mmsi -> description
  const traces = new Map(); // mmsi -> { color, on, coords }
  let frame = 0, last = 0, lastSymbols = 0, lastTrace = 0;

  const store = () => storePromise;

  async function loadWindow(at) {
    const s = await store();
    // Far enough back for the record before the clock, and for ships lying still that are held a long while.
    const w = [at - WINDOW_MS / 2 - MAX_HOLD_MS, at + WINDOW_MS / 2];
    const recs = await s.range(w[0], w[1]);
    const map2 = new Map();
    for (const r of recs) { let a = map2.get(r.m); if (!a) map2.set(r.m, (a = [])); a.push(r); }
    byShip = map2;
    win = w;
  }

  /** Make sure the window around the clock is loaded (in the background while playing). */
  function ensure() {
    const margin = 5 * 60e3;
    if (win && t > win[0] + MAX_HOLD_MS && t < win[1] - margin) return;
    if (loading) return;
    loading = loadWindow(t).finally(() => { loading = null; });
  }

  const where = (v) => {
    const recs = byShip.get(v.mmsi);
    if (!recs) return null;
    const p = positionAt(recs, t);
    return p ? { lat: p.lat, lon: p.lon, heading: p.heading } : null;
  };

  /** The ships at the clock, as reports for the AIS layer: those near the view, so the chart stays quick. */
  function reports() {
    const b = map.getBounds();
    const padX = (b.getEast() - b.getWest()) * 0.5 + 0.02, padY = (b.getNorth() - b.getSouth()) * 0.5 + 0.02;
    const out = [];
    for (const [m, recs] of byShip) {
      const p = positionAt(recs, t);
      if (!p) continue;
      if (p.lon < b.getWest() - padX || p.lon > b.getEast() + padX || p.lat < b.getSouth() - padY || p.lat > b.getNorth() + padY) continue;
      out.push(playbackReport(ships.get(m) ?? { m }, p, t));
    }
    return out;
  }

  // ---------- traces ----------
  function traceData() {
    const features = [];
    for (const [m, tr] of traces) {
      if (!tr.on || tr.coords.length < 2) continue;
      features.push({ type: 'Feature', properties: { m, color: tr.color }, geometry: { type: 'LineString', coordinates: tr.coords } });
    }
    return { type: 'FeatureCollection', features };
  }
  function drawTraces() {
    if (!map.getSource(TRACE_SOURCE)) {
      // (Not map.isStyleLoaded(): that stays false while tiles load, which during playback is always.)
      try { map.addSource(TRACE_SOURCE, { type: 'geojson', data: traceData() }); } catch { return; }
      // Under the ships, over the chart.
      const before = ['ais-hull', 'ais-hull-line', 'ais-arrow'].find((id) => map.getLayer(id));
      map.addLayer({ id: TRACE_SOURCE, type: 'line', source: TRACE_SOURCE, layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 2, 14, 3.5, 17, 5], 'line-opacity': 0.9 } }, before);
      return;
    }
    map.getSource(TRACE_SOURCE).setData(traceData());
  }
  /** Build a trace from the store, from where playback began (or the trace was switched on) to the clock. */
  async function rebuildTrace(m) {
    const tr = traces.get(m);
    if (!tr) return;
    const s = await store();
    const recs = await s.ofShip(m, tr.from - MAX_GAP_MS, t);
    tr.coords = traceCoords(recs, tr.from, t, 6);
    tr.until = t;
    drawTraces();
  }
  /** Grow each trace along the smooth path from where it got to up to the clock (not a straight jump:
   *  at 300x a second of playback is minutes of sailing). */
  function growTraces() {
    let changed = false;
    for (const [m, tr] of traces) {
      const recs = byShip.get(m);
      if (!recs || t <= tr.until) continue;
      const pts = traceCoords(recs, tr.until, t, 6);
      tr.until = t;
      const lastPt = tr.coords.at(-1);
      for (const p of pts) {
        const prev = tr.coords.at(-1);
        if (!prev || Math.abs(prev[0] - p[0]) + Math.abs(prev[1] - p[1]) > 2e-6) tr.coords.push(p);
      }
      if (tr.coords.at(-1) !== lastPt) changed = true;
    }
    if (changed) drawTraces();
  }

  // ---------- the clock ----------
  function loop(now) {
    frame = requestAnimationFrame(loop);
    const dt = last ? Math.min(1, (now - last) / 1000) : 0;
    last = now;
    if (playing) {
      t += dt * 1000 * speed;
      if (t >= endT) { t = endT; playing = false; onTick(); }
    }
    ensure();
    const wall = performance.now();
    if (wall - lastSymbols > SYMBOLS_MS) { lastSymbols = wall; ais.playbackFrame(reports(), t); onTick(); }
    if (playing && wall - lastTrace > TRACE_MS) { lastTrace = wall; growTraces(); }
    map.triggerRepaint();
  }

  return {
    get active() { return active; },
    get playing() { return playing; },
    get time() { return t; },
    get speed() { return speed; },
    get start() { return startT; },
    get floor() { return floorT; },
    get end() { return endT; },
    /** Begin playback at time `from` (ms); the slider can go back to `floor` (the recording's start). */
    async begin(from, floor = from) {
      const s = await store();
      const st = await s.stats();
      if (!st.count) throw new Error('Nothing recorded yet: switch on recording and leave Rudder open a while.');
      ships = await s.ships();
      endT = st.last;
      t = Math.min(Math.max(from, st.first), endT);
      startT = t;
      floorT = Math.min(Math.max(floor, st.first), t);
      await loadWindow(t);
      if (!active) {
        active = true;
        ais.setPlayback(where);
        last = 0;
        frame = requestAnimationFrame(loop);
      }
      for (const tr of traces.values()) { tr.from = t; tr.until = t; tr.coords = []; }
      playing = true;
      drawTraces();
      onTick();
    },
    play() { if (active) { if (t >= endT) t = startT; playing = true; onTick(); } },
    /** Ships placed at the clock in the loaded window (0: nothing recorded around this time). */
    get shipsNow() { let n = 0; for (const recs of byShip.values()) if (positionAt(recs, t)) n++; return n; },
    pause() { playing = false; onTick(); },
    setSpeed(x) { speed = x; onTick(); },
    /** Jump to time `to`: the window is read again and the traces rebuilt up to there. */
    async seek(to) {
      if (!active) return;
      t = Math.min(Math.max(to, floorT), endT);
      await loadWindow(t);
      for (const m of traces.keys()) await rebuildTrace(m);
      onTick();
    },
    /** Back to live AIS. */
    stop() {
      if (!active) return;
      cancelAnimationFrame(frame);
      active = false;
      playing = false;
      byShip = new Map();
      win = null;
      ais.setPlayback(null);
      if (map.getLayer(TRACE_SOURCE)) map.removeLayer(TRACE_SOURCE);
      if (map.getSource(TRACE_SOURCE)) map.removeSource(TRACE_SOURCE);
      onEnd();
    },
    // ---------- traces ----------
    traces,
    /** Give a ship a trace (a colour not yet used), or change its colour. */
    setTrace(m, color) {
      const used = new Set([...traces.values()].map((x) => x.color));
      const tr = traces.get(m);
      if (tr) { tr.color = color ?? tr.color; drawTraces(); return tr; }
      const fresh = { color: color ?? TRACE_COLORS.find((c) => !used.has(c)) ?? TRACE_COLORS[traces.size % TRACE_COLORS.length], on: true, from: startT, until: startT, coords: [] };
      traces.set(m, fresh);
      rebuildTrace(m);
      return fresh;
    },
    showTrace(m, on) { const tr = traces.get(m); if (tr) { tr.on = on; drawTraces(); } },
    removeTrace(m) { traces.delete(m); drawTraces(); },
    shipName: (m) => (ships.get(m)?.name || '').trim() || `MMSI ${m}`,
    /** Ships with positions in the loaded window. */
    get shipsInWindow() { return byShip.size; },
    HOLD_MS,
  };
}
