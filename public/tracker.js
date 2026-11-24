// The Ships tracker panel: recording every ship's AIS positions on this device (recorder.js), what
// has been recorded, playback of it (playback.js) from a date and time or a while ago, at a chosen
// speed, with a slider to move through time, and coloured traces behind chosen ships.

import { SPEEDS, TRACE_COLORS, parseAgo, formatSpan } from './track.js';
import { KEEP_DAYS, POLL_MS } from './recorder.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nf = new Intl.NumberFormat('en-GB');
const when = (t) => (t ? new Date(t).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
const clock = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const bytes = (n) => (n == null ? '—' : n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} kB`);
/** A time as the value of a datetime-local input (local time, to the minute). */
const localInput = (t) => { const d = new Date(t - new Date(t).getTimezoneOffset() * 60e3); return d.toISOString().slice(0, 16); };

export function createTracker(el, { recorder, playback, storePromise, canRecord }) {
  let stats = { count: 0, ships: 0, first: null, last: null, lastHour: 0, usage: null };
  let msg = { text: '', tone: '' };
  let mode = 'ago';
  let agoText = '1:00';
  let atValue = '';
  let seekTimer = 0;
  let open = false;

  async function refreshStats() {
    try {
      const s = await storePromise;
      const st = await s.stats();
      const lastHour = await s.countBetween(Date.now() - 3600e3, Date.now());
      const est = await navigator.storage?.estimate?.().catch(() => null);
      stats = { ...st, lastHour, usage: est?.usage ?? null };
    } catch (e) {
      msg = { text: e.message, tone: 'err' };
    }
    render();
  }

  function recordingLine() {
    const r = recorder.stats;
    if (!canRecord()) return { tone: 'warn', text: 'Needs BarentsWatch AIS access: set it up in Settings.' };
    if (!recorder.on) return { tone: '', text: 'Not recording.' };
    if (r.otherTab) return { tone: 'warn', text: 'Waiting: Rudder is recording in another tab or window.' };
    if (r.error) return { tone: 'err', text: `Recording, but the last request failed: ${r.error}` };
    if (!r.lastPoll) return { tone: '', text: 'Recording: asking for every ship…' };
    return { tone: 'ok', text: `Recording · ${clock(r.lastPoll)}: ${nf.format(r.lastSeen)} reports, ${nf.format(r.lastAdded)} positions kept` };
  }

  function render() {
    if (!open) return;
    const line = recordingLine();
    const span = stats.first && stats.last ? formatSpan(stats.last - stats.first) : '—';
    const pb = playback;
    const sliderMin = stats.first ?? 0, sliderMax = (pb.active ? pb.end : stats.last) ?? 0;
    if (!atValue && stats.last) atValue = localInput(Math.max(stats.first, stats.last - 3600e3));
    el.innerHTML = `
      <section class="set-section">
        <h3>Recording</h3>
        <label class="opt"><input type="checkbox" data-rec="on" ${recorder.on ? 'checked' : ''} ${canRecord() ? '' : 'disabled'}>
          <span>Record every ship's positions</span>
          <small>All of Norway from BarentsWatch, every ${POLL_MS / 60e3} minute, kept on this device. It records only while Rudder is open.</small></label>
        <p class="set-state" data-tone="${line.tone}">${esc(line.text)}</p>
        <dl class="tk-stats">
          <div><dt>Ships tracked</dt><dd>${nf.format(stats.ships)}</dd></div>
          <div><dt>Positions stored</dt><dd>${nf.format(stats.count)}</dd></div>
          <div><dt>Recorded span</dt><dd>${esc(span)}</dd></div>
          <div><dt>Positions last hour</dt><dd>${nf.format(stats.lastHour)}</dd></div>
          <div><dt>Under way now</dt><dd>${recorder.stats.lastPoll ? nf.format(recorder.stats.moving) : '—'}</dd></div>
          <div><dt>Storage used</dt><dd>${bytes(stats.usage)}</dd></div>
        </dl>
        <p class="fine">From ${esc(when(stats.first))}<br>to ${esc(when(stats.last))}</p>
        <div class="tk-row">
          <label>Keep for <select data-rec="keep">${KEEP_DAYS.map((d) => `<option value="${d}" ${d === recorder.keepDays ? 'selected' : ''}>${d} day${d > 1 ? 's' : ''}</option>`).join('')}</select></label>
          <button type="button" class="set-btn danger" data-rec="clear" ${stats.count ? '' : 'disabled'}>Clear recordings</button>
        </div>
      </section>
      <section class="set-section">
        <h3>Playback</h3>
        ${pb.active ? `
          <p class="tk-clock"><b>${esc(when(pb.time))}</b><span>${esc(formatSpan(Date.now() - pb.time))} ago · ${pb.speed}×</span></p>
          <input type="range" class="tk-slider" data-pb="slider" min="${sliderMin}" max="${sliderMax}" step="1000" value="${Math.round(pb.time)}" aria-label="Playback time">
          <div class="tk-ends"><span>${esc(clock(sliderMin))}</span><span>${esc(clock(sliderMax))}</span></div>
          <div class="set-buttons">
            <button type="button" class="set-btn primary" data-pb="${pb.playing ? 'pause' : 'play'}">${pb.playing ? 'Pause' : 'Play'}</button>
            <label class="tk-speed">Speed <select data-pb="speed">${SPEEDS.map((x) => `<option value="${x}" ${x === pb.speed ? 'selected' : ''}>${x}×</option>`).join('')}</select></label>
            <button type="button" class="set-btn" data-pb="live">Back to live</button>
          </div>
          <p class="fine">${nf.format(pb.shipsInWindow)} ships around this time. Tap a ship for its trace.</p>` : `
          <div class="tk-from" role="radiogroup" aria-label="Start from">
            <label><input type="radio" name="tk-mode" value="ago" ${mode === 'ago' ? 'checked' : ''}> A while ago</label>
            <input type="text" data-pb="ago" value="${esc(agoText)}" inputmode="numeric" placeholder="h:mm" aria-label="Hours and minutes ago" ${mode === 'ago' ? '' : 'disabled'}>
            <label><input type="radio" name="tk-mode" value="at" ${mode === 'at' ? 'checked' : ''}> From</label>
            <input type="datetime-local" data-pb="at" value="${esc(atValue)}" aria-label="Date and time" ${mode === 'at' ? '' : 'disabled'}>
          </div>
          <div class="set-buttons">
            <label class="tk-speed">Speed <select data-pb="speed">${SPEEDS.map((x) => `<option value="${x}" ${x === pb.speed ? 'selected' : ''}>${x}×</option>`).join('')}</select></label>
            <button type="button" class="set-btn primary" data-pb="begin" ${stats.count ? '' : 'disabled'}>Play back</button>
          </div>`}
        <p class="set-msg" data-tone="${msg.tone}" role="status">${esc(msg.text)}</p>
      </section>
      <section class="set-section">
        <h3>Traces</h3>
        ${pb.traces.size ? `<ul class="tk-traces">${[...pb.traces].map(([m, tr]) => `<li data-m="${m}">
            ${colorPicker(m, tr.color)}<span class="tk-name">${esc(pb.shipName(m))}</span>
            <label class="tk-show"><input type="checkbox" data-trace="on" ${tr.on ? 'checked' : ''}> Show</label>
            <button type="button" class="link-btn" data-trace="remove" aria-label="Remove trace">✕</button></li>`).join('')}</ul>`
          : '<p class="fine">During playback, tap a ship and give it a trace: a coloured line of where it has been.</p>'}
      </section>`;
  }

  const colorPicker = (m, color) => `<select class="tk-color" data-trace="color" aria-label="Trace colour" style="background:${color}">
    ${TRACE_COLORS.map((c) => `<option value="${c}" ${c === color ? 'selected' : ''} style="background:${c}">●</option>`).join('')}</select>`;

  function fromTime() {
    if (mode === 'at') {
      const t = Date.parse(atValue);
      if (!Number.isFinite(t)) throw new Error('Choose a date and time.');
      return t;
    }
    const ago = parseAgo(agoText);
    if (ago == null) throw new Error('Write how long ago as hours:minutes, for example 1:30.');
    return Date.now() - ago;
  }

  el.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.dataset.rec === 'on') { recorder.setOn(t.checked); refreshStats(); }
    else if (t.dataset.rec === 'keep') recorder.setKeepDays(Number(t.value));
    else if (t.name === 'tk-mode') { mode = t.value; render(); }
    else if (t.dataset.pb === 'ago') agoText = t.value;
    else if (t.dataset.pb === 'at') atValue = t.value;
    else if (t.dataset.pb === 'speed') playback.setSpeed(Number(t.value));
    else if (t.dataset.pb === 'slider') playback.seek(Number(t.value));
    else if (t.dataset.trace) {
      const m = Number(t.closest('[data-m]').dataset.m);
      if (t.dataset.trace === 'on') playback.showTrace(m, t.checked);
      if (t.dataset.trace === 'color') { playback.setTrace(m, t.value); render(); }
    }
  });
  // Dragging the slider moves playback as it goes (a few times a second).
  el.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.pb === 'ago') agoText = t.value;
    if (t.dataset.pb !== 'slider') return;
    clearTimeout(seekTimer);
    seekTimer = setTimeout(() => playback.seek(Number(t.value)), 120);
  });
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const act = b.dataset.pb ?? b.dataset.rec ?? b.dataset.trace;
    try {
      if (act === 'begin') { msg = { text: '', tone: '' }; await playback.begin(fromTime()); }
      else if (act === 'play') playback.play();
      else if (act === 'pause') playback.pause();
      else if (act === 'live') playback.stop();
      else if (act === 'clear') {
        if (!confirm('Delete every recorded position and ship from this device? This cannot be undone.')) return;
        const s = await storePromise;
        await s.clear();
        await refreshStats();
      } else if (act === 'remove') playback.removeTrace(Number(b.closest('[data-m]').dataset.m));
    } catch (err) {
      msg = { text: err.message, tone: 'err' };
    }
    render();
  });

  // The figures refresh while the panel is open (the clock and slider while playing).
  setInterval(() => { if (open) refreshStats(); }, 10_000);
  let lastClockRender = 0;

  return {
    setOpen(o) { open = o; if (o) refreshStats(); },
    render,
    /** Playback moved on: keep the clock and slider current, without disturbing a slider being dragged. */
    tick() {
      if (!open || !playback.active || Date.now() - lastClockRender < 500) return;
      lastClockRender = Date.now();
      const slider = el.querySelector('[data-pb="slider"]');
      if (!slider || document.activeElement === slider) return;
      slider.value = String(Math.round(playback.time));
      const c = el.querySelector('.tk-clock');
      if (c) c.innerHTML = `<b>${esc(when(playback.time))}</b><span>${esc(formatSpan(Date.now() - playback.time))} ago · ${playback.speed}×</span>`;
      const play = el.querySelector('[data-pb="play"], [data-pb="pause"]');
      if (play && (play.dataset.pb === 'pause') !== playback.playing) render();
    },
    /** Trace controls in a ship's card during playback. */
    cardHtml(v) {
      if (!playback.active) return '';
      const tr = playback.traces.get(v.mmsi);
      return `<div class="tk-card" data-m="${v.mmsi}">
        <span class="tk-card-label">Trace</span>
        ${tr ? `${colorPicker(v.mmsi, tr.color)}<label class="tk-show"><input type="checkbox" data-trace="on" ${tr.on ? 'checked' : ''}> Show</label>
          <button type="button" class="link-btn" data-trace="remove">Remove</button>`
          : '<button type="button" class="info-btn" data-trace="add">Give it a trace</button>'}
      </div>`;
    },
  };
}
