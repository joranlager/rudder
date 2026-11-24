// Traces behind live ships: a coloured line of where a chosen ship has sailed since tracking began,
// drawn as it goes. The line follows the ship where it is drawn (between AIS reports by dead
// reckoning, as the 3D ships: aismap.js shownShip), sampled every second.
//
// The ships being tracked, their colours and whether each line is shown are remembered on this
// device, so tracking goes on after a reload. If positions are being recorded (Ships tracker), the
// line is rebuilt from the recording on reload; otherwise it starts again. "Clear trace" empties a
// line and starts it afresh from the ship's place now; recorded positions are never touched.
//
// Same controls as the traces in playback (playback.js): setTrace, showTrace, clearTrace, removeTrace.

import { TRACE_COLORS, traceCoords, MAX_GAP_MS } from './track.js';

const STORE_KEY = 'rudder.livetraces.v1';
const SOURCE = 'live-traces';
const SAMPLE_MS = 1000;
const MIN_STEP_DEG = 3e-5; // about 2-3 m: closer points are not added
const MAX_POINTS = 20000; // per trace: some hours of a ship under way; the oldest go first

function load() {
  try {
    const list = JSON.parse(localStorage.getItem(STORE_KEY));
    return Array.isArray(list) ? list.filter((x) => Number.isFinite(x?.m) && TRACE_COLORS.includes(x.color)) : [];
  } catch { return []; }
}

export function createLiveTraces(map, { ais, storePromise = null }) {
  const traces = new Map(); // mmsi -> { color, on, since, coords }
  for (const x of load()) traces.set(x.m, { color: x.color, on: x.on !== false, since: x.since ?? Date.now(), coords: [] });
  const save = () => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify([...traces].map(([m, t]) => ({ m, color: t.color, on: t.on, since: t.since })))); } catch { /* private mode */ }
  };
  let hidden = false; // while recorded tracks play back, live traces stand aside

  function data() {
    const features = [];
    if (!hidden) {
      for (const [m, tr] of traces) {
        if (!tr.on || tr.coords.length < 2) continue;
        features.push({ type: 'Feature', properties: { m, color: tr.color }, geometry: { type: 'LineString', coordinates: tr.coords } });
      }
    }
    return { type: 'FeatureCollection', features };
  }
  function draw() {
    if (!map.getSource(SOURCE)) {
      if (!traces.size) return;
      try { map.addSource(SOURCE, { type: 'geojson', data: data() }); } catch { return; } // the style is not ready yet
      const before = ['ais-hull', 'ais-hull-line', 'ais-arrow'].find((id) => map.getLayer(id));
      map.addLayer({ id: SOURCE, type: 'line', source: SOURCE, layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 2, 14, 3.5, 17, 5], 'line-opacity': 0.9 } }, before);
      return;
    }
    map.getSource(SOURCE).setData(data());
  }

  /** Rebuild a line from the recording, if positions of this ship have been recorded since it was tracked. */
  async function fromRecording(m) {
    const tr = traces.get(m);
    if (!tr || !storePromise) return;
    try {
      const store = await storePromise;
      const recs = await store.ofShip(m, tr.since - MAX_GAP_MS, Date.now());
      const coords = traceCoords(recs, tr.since, Date.now(), 6);
      if (coords.length > tr.coords.length) { tr.coords = coords; draw(); }
    } catch { /* no recording: the line starts now */ }
  }

  function sample() {
    if (ais.playingBack) { if (!hidden) { hidden = true; draw(); } return; }
    if (hidden) { hidden = false; draw(); }
    let changed = false;
    for (const [m, tr] of traces) {
      const v = ais.vessel(m);
      if (!v) continue;
      const p = ais.shownShip(v);
      if (!p || !Number.isFinite(p.lat)) continue;
      const last = tr.coords.at(-1);
      if (last && Math.abs(last[0] - p.lon) + Math.abs(last[1] - p.lat) < MIN_STEP_DEG) continue;
      tr.coords.push([+p.lon.toFixed(6), +p.lat.toFixed(6)]);
      if (tr.coords.length > MAX_POINTS) tr.coords.splice(0, tr.coords.length - MAX_POINTS);
      changed = true;
    }
    if (changed) draw();
  }

  setInterval(sample, SAMPLE_MS);
  for (const m of traces.keys()) fromRecording(m);
  // The map style is ready a moment after start: draw what was rebuilt.
  map.once('idle', draw);

  return {
    traces,
    /** Track a ship (a colour not yet used), or change its colour. */
    setTrace(m, color) {
      const tr = traces.get(m);
      if (tr) { if (color) tr.color = color; save(); draw(); return tr; }
      const used = new Set([...traces.values()].map((x) => x.color));
      const fresh = { color: color ?? TRACE_COLORS.find((c) => !used.has(c)) ?? TRACE_COLORS[traces.size % TRACE_COLORS.length], on: true, since: Date.now(), coords: [] };
      traces.set(m, fresh);
      save();
      sample();
      return fresh;
    },
    showTrace(m, on) { const tr = traces.get(m); if (tr) { tr.on = on; save(); draw(); } },
    /** Empty the line and start it again from where the ship is now (recordings are not touched). */
    clearTrace(m) { const tr = traces.get(m); if (tr) { tr.coords = []; tr.since = Date.now(); save(); draw(); sample(); } },
    /** Stop tracking a ship. */
    removeTrace(m) { traces.delete(m); save(); draw(); },
    shipName: (m) => { const v = ais.vessel(m); return ((v?.name || '').trim()) || `MMSI ${m}`; },
  };
}
