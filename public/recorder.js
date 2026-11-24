// Recording every ship's AIS positions in Norwegian waters on this device (trackstore.js).
//
// Rudder has no server, so the recording is done by the open app: every minute it asks BarentsWatch
// for every ship's latest report (no area: all of Norway), the first time in full and then only what
// changed, and keeps the positions worth keeping (track.js shouldKeep). It records only while
// Rudder is open in a browser with BarentsWatch access, and only in one tab at a time (the others
// are told which one records). Old positions are dropped after the chosen number of days.

import { toRecord, staticOf, sameStatic, shouldKeep, addPoll, pruneSessions } from './track.js';
import { mergeSessions } from './trackfile.js';

const STORE_KEY = 'rudder.recorder.v1';
export const POLL_MS = 60_000;
export const KEEP_DAYS = [1, 3, 7, 14, 30];
const LOCK = 'rudder-recorder';

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    return { on: Boolean(s?.on), keepDays: KEEP_DAYS.includes(s?.keepDays) ? s.keepDays : 3, sessions: Array.isArray(s?.sessions) ? s.sessions : [] };
  } catch { return { on: false, keepDays: 3, sessions: [] }; }
}

export function createRecorder({ ais, storePromise, onChange = () => {} }) {
  const cfg = load();
  const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch { /* private mode */ } };
  const lastKept = new Map(); // mmsi -> last kept record
  const statics = new Map(); // mmsi -> last stored description
  const stats = { polls: 0, lastPoll: null, lastAdded: 0, lastSeen: 0, moving: 0, error: '', recording: false, otherTab: false };
  let timer = 0, lastFetch = 0, busy = false, releaseLock = null, lastPrune = 0;

  async function poll() {
    if (busy || !cfg.on) return;
    busy = true;
    try {
      const store = await storePromise;
      const started = Date.now();
      const list = await ais.fetchAll(lastFetch ? lastFetch - 60_000 : null);
      const keep = [], ships = [];
      let moving = 0;
      for (const v of list) {
        const rec = toRecord(v);
        if (!rec) continue;
        if (rec.s > 0.5) moving++;
        if (shouldKeep(lastKept.get(rec.m), rec)) { keep.push(rec); lastKept.set(rec.m, rec); }
        const st = staticOf(v);
        if (Object.keys(st).length > 1 && !sameStatic(statics.get(st.m), st)) { ships.push(st); statics.set(st.m, st); }
      }
      await store.add(keep);
      await store.putShips(ships);
      lastFetch = started;
      Object.assign(stats, { polls: stats.polls + 1, lastPoll: Date.now(), lastAdded: keep.length, lastSeen: list.length, error: '' });
      // When the recording ran: playback starts inside it (track.js clampToCoverage).
      cfg.sessions = pruneSessions(addPoll(cfg.sessions, started, POLL_MS), Date.now() - cfg.keepDays * 86400e3).slice(-500);
      save();
      if (!lastPrune || Date.now() - lastPrune > 3600e3) { lastPrune = Date.now(); await store.prune(Date.now() - cfg.keepDays * 86400e3); }
      // Ships under way report often, so the changes since the last poll include them all.
      stats.moving = moving;
    } catch (e) {
      stats.error = e.message;
    } finally {
      busy = false;
      onChange();
    }
  }

  async function start() {
    if (stats.recording) return;
    // One tab records: the others wait for the lock (and say so).
    if (navigator.locks?.request) {
      stats.otherTab = true;
      onChange();
      await new Promise((resolve) => {
        navigator.locks.request(LOCK, () => new Promise((release) => { releaseLock = release; resolve(); }));
      });
      if (!cfg.on) { releaseLock?.(); releaseLock = null; return; }
    }
    stats.otherTab = false;
    stats.recording = true;
    lastFetch = 0; // the first poll asks for everything
    clearInterval(timer);
    timer = setInterval(poll, POLL_MS);
    poll();
    onChange();
  }

  function stop() {
    clearInterval(timer);
    timer = 0;
    stats.recording = false;
    stats.otherTab = false;
    releaseLock?.();
    releaseLock = null;
    onChange();
  }

  if (cfg.on) start();

  return {
    stats,
    get on() { return cfg.on; },
    get keepDays() { return cfg.keepDays; },
    setOn(on) { cfg.on = Boolean(on); save(); if (cfg.on) start(); else stop(); },
    /** Stretches of time the recorder ran, oldest first: [{ from, to }]. */
    get sessions() { return cfg.sessions; },
    /** Forget them (with the recorded positions). */
    clearSessions() { cfg.sessions = []; save(); },
    /** Add stretches recorded elsewhere (an imported file). */
    addSessions(list) { cfg.sessions = mergeSessions(cfg.sessions, list); save(); onChange(); },
    setKeepDays(d) { if (KEEP_DAYS.includes(d)) { cfg.keepDays = d; save(); lastPrune = 0; onChange(); } },
    pollNow: poll,
  };
}
