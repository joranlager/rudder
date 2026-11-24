// Recorded tracks as a file, to export and import (Ships tracker): positions, ship descriptions and
// when the recorder ran, so a recording can be kept, moved to another device or shared.
//
// The file is gzip-compressed text, one JSON value per line (".ndjson.gz"):
//   line 1:  { "format": "rudder-tracks", "version": 1, "exported": "...", "positions": n, "ships": n, "sessions": [{ from, to }] }
//   ships:   { "ship": { "m": MMSI, "name": ..., ... } }
//   others:  [m, t, lat, lon, speed, course, heading]   (one position; missing values null, trailing ones left off)
// Lines are written and read a batch at a time, so a large recording neither fills memory nor stalls
// the page. Reading checks every line: anything that is not a sound position or ship is skipped and
// counted, and a file that is not a Rudder tracks file is refused.

export const FORMAT = 'rudder-tracks';
export const FILE_VERSION = 1;

const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const course = (x) => (finite(x) && x >= 0 && x < 360 ? x : null);

/** A position record as the compact array written to the file. */
export function encodePosition(r) {
  const a = [r.m, r.t, r.la, r.lo, r.s ?? null, r.c ?? null, r.h ?? null];
  while (a.length > 4 && a.at(-1) === null) a.pop();
  return a;
}

/** A position record from a file's array, or null when it is not a sound position. */
export function decodePosition(a) {
  if (!Array.isArray(a) || a.length < 4) return null;
  const [m, t, la, lo, s, c, h] = a;
  if (!Number.isInteger(m) || m <= 0 || m > 999_999_999) return null;
  if (!finite(t) || t < Date.UTC(2000, 0, 1) || t > Date.UTC(2100, 0, 1)) return null;
  if (!finite(la) || !finite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
  const r = { m, t, la, lo };
  if (finite(s) && s >= 0 && s < 102.3) r.s = s;
  if (course(c) != null) r.c = c;
  if (course(h) != null) r.h = h;
  return r;
}

/** A ship description from a file line, or null. Only plain values are kept. */
export function decodeShip(x) {
  if (!x || typeof x !== 'object' || !Number.isInteger(x.m) || x.m <= 0) return null;
  const out = {};
  for (const [k, v] of Object.entries(x)) {
    if (k.length > 40) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string' && v.length <= 200) out[k] = v;
  }
  return out;
}

/** Stretches of recording from two lists, merged where they overlap or nearly touch, oldest first. */
export function mergeSessions(a, b, gapMs = 3 * 60e3) {
  const all = [...(a ?? []), ...(b ?? [])]
    .filter((s) => finite(s?.from) && finite(s?.to) && s.to >= s.from)
    .map((s) => ({ from: s.from, to: s.to }))
    .sort((x, y) => x.from - y.from);
  const out = [];
  for (const s of all) {
    const last = out.at(-1);
    if (last && s.from <= last.to + gapMs) last.to = Math.max(last.to, s.to);
    else out.push(s);
  }
  return out;
}

/** What one line of a file is: the header, a ship, a position, or something to skip. */
export function parseLine(line) {
  const s = line.trim();
  if (!s) return { kind: 'blank' };
  let v;
  try { v = JSON.parse(s); } catch { return { kind: 'bad' }; }
  if (Array.isArray(v)) { const r = decodePosition(v); return r ? { kind: 'pos', value: r } : { kind: 'bad' }; }
  if (v && v.format === FORMAT) return { kind: 'header', value: v };
  if (v && v.ship) { const x = decodeShip(v.ship); return x ? { kind: 'ship', value: x } : { kind: 'bad' }; }
  return { kind: 'bad' };
}

// ---------- writing ----------

/**
 * The file as a Blob. `positions` is an async iterable of batches of records (oldest store order is
 * fine), `ships` a list of descriptions, `sessions` when the recorder ran, `count` the positions in all.
 */
export async function writeTracksFile({ positions, ships, sessions, count, exported = new Date() }) {
  const enc = new TextEncoder();
  const header = { format: FORMAT, version: FILE_VERSION, exported: exported.toISOString(), positions: count, ships: ships.length, sessions };
  const iterator = positions[Symbol.asyncIterator]();
  let stage = 0;
  const text = new ReadableStream({
    async pull(ctrl) {
      if (stage === 0) { ctrl.enqueue(enc.encode(`${JSON.stringify(header)}\n`)); stage = 1; return; }
      if (stage === 1) { ctrl.enqueue(enc.encode(ships.map((x) => `${JSON.stringify({ ship: x })}\n`).join(''))); stage = 2; return; }
      const { value, done } = await iterator.next();
      if (done) { ctrl.close(); return; }
      ctrl.enqueue(enc.encode(value.map((r) => `${JSON.stringify(encodePosition(r))}\n`).join('')));
    },
  });
  const body = typeof CompressionStream === 'function' ? text.pipeThrough(new CompressionStream('gzip')) : text;
  return new Response(body).blob();
}

/** The file name for an export now: rudder-tracks-2026-11-25-1430.ndjson.gz */
export function exportName(now = new Date(), gzip = typeof CompressionStream === 'function') {
  const p = (n) => String(n).padStart(2, '0');
  return `rudder-tracks-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.ndjson${gzip ? '.gz' : ''}`;
}

// ---------- reading ----------

async function isGzip(blob) {
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  return head[0] === 0x1f && head[1] === 0x8b;
}

/**
 * Read a tracks file (gzip or plain) a batch at a time. `onShips(list)` and `onPositions(list)` are
 * awaited for each batch. Returns { header, positions, ships, bad }. Throws when the first line is
 * not a Rudder tracks header.
 */
export async function readTracksFile(blob, { onShips = async () => {}, onPositions = async () => {}, batch = 5000 } = {}) {
  let stream = blob.stream();
  if (await isGzip(blob)) {
    if (typeof DecompressionStream !== 'function') throw new Error('This browser cannot open compressed files.');
    stream = stream.pipeThrough(new DecompressionStream('gzip'));
  }
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let rest = '', header = null, nPos = 0, nShips = 0, bad = 0, first = true;
  let pos = [], ships = [];
  const flush = async () => {
    if (ships.length) { await onShips(ships); nShips += ships.length; ships = []; }
    if (pos.length) { await onPositions(pos); nPos += pos.length; pos = []; }
  };
  const take = async (line) => {
    const p = parseLine(line);
    if (first && p.kind !== 'blank') {
      first = false;
      if (p.kind !== 'header') throw new Error('This is not a Rudder tracks file.');
      if (p.value.version > FILE_VERSION) throw new Error('This file is from a newer Rudder: update Rudder to read it.');
      header = p.value;
      return;
    }
    if (p.kind === 'pos') pos.push(p.value);
    else if (p.kind === 'ship') ships.push(p.value);
    else if (p.kind === 'bad') bad++;
    if (pos.length >= batch || ships.length >= batch) await flush();
  };
  for (;;) {
    let chunk;
    try { chunk = await reader.read(); } catch { throw new Error('The file is damaged (it could not be decompressed).'); }
    if (chunk.done) break;
    const lines = (rest + chunk.value).split('\n');
    rest = lines.pop();
    for (const line of lines) await take(line);
  }
  if (rest) await take(rest);
  if (!header) throw new Error('This is not a Rudder tracks file.');
  await flush();
  return { header, positions: nPos, ships: nShips, bad };
}
