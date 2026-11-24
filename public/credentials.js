// The BarentsWatch credentials, kept on this device only (localStorage, never sent anywhere but
// BarentsWatch). Shared by the settings panel (where they are entered) and the AIS layer (which uses them).

const KEY = 'rudder.barentswatch.v1';
const OLD_KEY = 'rudder.ais.v1'; // the first AIS build kept them with the layer switch

const empty = () => ({ clientId: '', clientSecret: '', pasted: '', savedAt: null });

/** Read the stored credentials; moves them over from the first AIS build's storage once. */
export function loadCredentials(storage = globalThis.localStorage) {
  try {
    const cur = JSON.parse(storage.getItem(KEY));
    if (cur) return { ...empty(), ...cur };
    const old = JSON.parse(storage.getItem(OLD_KEY));
    if (old && (old.clientId || old.pasted)) {
      const moved = { ...empty(), clientId: old.clientId ?? '', clientSecret: old.clientSecret ?? '', pasted: old.pasted ?? '', savedAt: Date.now() };
      storage.setItem(KEY, JSON.stringify(moved));
      storage.setItem(OLD_KEY, JSON.stringify({ on: Boolean(old.on) }));
      return moved;
    }
  } catch { /* storage unavailable or damaged: start empty */ }
  return empty();
}

/** Save (trimmed). Returns what was stored, or throws when the browser will not store anything (private mode). */
export function saveCredentials(c, storage = globalThis.localStorage, now = Date.now()) {
  const v = { clientId: String(c.clientId ?? '').trim(), clientSecret: String(c.clientSecret ?? '').trim(), pasted: String(c.pasted ?? '').trim(), savedAt: now };
  storage.setItem(KEY, JSON.stringify(v));
  return v;
}

export function clearCredentials(storage = globalThis.localStorage) {
  try { storage.removeItem(KEY); } catch { /* nothing stored */ }
}

/** Which kind of access is set up: 'client', 'token' or null. */
export const accessKind = (c) => (c.clientId && c.clientSecret ? 'client' : c.pasted ? 'token' : null);

/**
 * Ask the browser to keep this site's storage (so it is not cleared to free space), and report how
 * safe it is. iPhone Safari clears a website's storage after about 7 days without a visit unless the
 * site is on the home screen, so that is reported too.
 */
export async function storageState({ ask = false } = {}) {
  const nav = globalThis.navigator ?? {};
  const standalone = globalThis.matchMedia?.('(display-mode: standalone)').matches || nav.standalone === true;
  const ios = /iPhone|iPad|iPod/.test(nav.userAgent ?? '') || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  let persisted = null;
  try {
    persisted = await nav.storage?.persisted?.() ?? null;
    if (ask && persisted === false) persisted = await nav.storage.persist();
  } catch { /* not supported */ }
  return { persisted, standalone: Boolean(standalone), ios };
}
