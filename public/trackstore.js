// Recorded AIS tracks, kept on this device in IndexedDB (the browser's database for Rudder).
//
//   positions: { m, t, la, lo, s?, c?, h? } (track.js toRecord), one per ship and time (key [m, t]),
//              indexed by time; the same position stored twice (an import of a file already
//              imported, say) is kept once
//   ships:     the ship's description (name, type, size), one per MMSI
//
// Version 1 numbered the positions instead; opening it as version 2 moves them across once.
//
// Nothing leaves the device. The browser may clear it to free space unless it is asked to keep
// Rudder's data (Settings does that), and it is gone with "clear site data".

const DB = 'rudder-tracks';
const VERSION = 2;

const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const done = (tx) => new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });

export async function openTrackStore(idb = globalThis.indexedDB) {
  if (!idb) throw new Error('This browser cannot store data (no IndexedDB).');
  const open = idb.open(DB, VERSION);
  open.onupgradeneeded = (e) => {
    const db = open.result;
    if (!db.objectStoreNames.contains('ships')) db.createObjectStore('ships', { keyPath: 'm' });
    // Version 1's positions (numbered) are renamed, copied into the new store by [m, t], then dropped.
    let old = null;
    if (e.oldVersion >= 1 && db.objectStoreNames.contains('positions')) {
      old = open.transaction.objectStore('positions');
      old.name = 'positions-v1';
    }
    const pos = db.createObjectStore('positions', { keyPath: ['m', 't'] });
    pos.createIndex('t', 't');
    if (old) {
      const cur = old.openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (c) { pos.put(c.value); c.continue(); } else db.deleteObjectStore('positions-v1');
      };
    }
  };
  const db = await req(open);

  /** Records with time in [t0, t1], oldest first, in batches so a big range does not stall the page. */
  async function range(t0, t1) {
    const tx = db.transaction('positions');
    return req(tx.objectStore('positions').index('t').getAll(IDBKeyRange.bound(t0, t1)));
  }

  return {
    /** Add records (one transaction); a position already stored for that ship and time is replaced. */
    async add(records) {
      if (!records.length) return;
      const tx = db.transaction('positions', 'readwrite');
      const s = tx.objectStore('positions');
      for (const r of records) s.put(r);
      await done(tx);
    },
    /** Every position, a batch at a time, in ship and time order (for export). */
    async *batches(size = 20000) {
      let after = null;
      for (;;) {
        const tx = db.transaction('positions');
        const range = after ? IDBKeyRange.lowerBound(after, true) : null;
        const list = await req(tx.objectStore('positions').getAll(range, size));
        if (!list.length) return;
        yield list;
        const last = list.at(-1);
        after = [last.m, last.t];
        if (list.length < size) return;
      }
    },
    /** Store ship descriptions (one transaction). */
    async putShips(ships) {
      if (!ships.length) return;
      const tx = db.transaction('ships', 'readwrite');
      const s = tx.objectStore('ships');
      for (const x of ships) s.put(x);
      await done(tx);
    },
    range,
    /** One ship's records with time in [t0, t1], oldest first. */
    async ofShip(m, t0, t1) {
      const tx = db.transaction('positions');
      return req(tx.objectStore('positions').getAll(IDBKeyRange.bound([m, t0], [m, t1])));
    },
    /** All ship descriptions as a Map by MMSI. */
    async ships() {
      const tx = db.transaction('ships');
      const all = await req(tx.objectStore('ships').getAll());
      return new Map(all.map((x) => [x.m, x]));
    },
    /** How much is stored: positions, ships, the first and last time. */
    async stats() {
      const tx = db.transaction(['positions', 'ships']);
      const pos = tx.objectStore('positions'), byTime = pos.index('t');
      const [count, ships, first, last] = await Promise.all([
        req(pos.count()), req(tx.objectStore('ships').count()),
        req(byTime.openCursor()), req(byTime.openCursor(null, 'prev')),
      ]);
      return { count, ships, first: first?.value.t ?? null, last: last?.value.t ?? null };
    },
    /** Positions recorded in [t0, t1] (for the rate per hour). */
    async countBetween(t0, t1) {
      const tx = db.transaction('positions');
      return req(tx.objectStore('positions').index('t').count(IDBKeyRange.bound(t0, t1)));
    },
    /** Delete positions older than `before` (ms). */
    async prune(before) {
      const tx = db.transaction('positions', 'readwrite');
      const index = tx.objectStore('positions').index('t');
      await new Promise((resolve, reject) => {
        const cur = index.openCursor(IDBKeyRange.upperBound(before, true));
        cur.onsuccess = () => { const c = cur.result; if (c) { c.delete(); c.continue(); } else resolve(); };
        cur.onerror = () => reject(cur.error);
      });
      await done(tx);
    },
    /** Delete everything recorded. */
    async clear() {
      const tx = db.transaction(['positions', 'ships'], 'readwrite');
      tx.objectStore('positions').clear();
      tx.objectStore('ships').clear();
      await done(tx);
    },
  };
}
