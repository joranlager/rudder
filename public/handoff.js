// Getting a BarentsWatch token through the iPhone's Shortcuts app.
//
// BarentsWatch's login server only lets its own website read its answers in a browser (CORS), so a
// web page cannot log in with a client ID and secret. Shortcuts is not a browser: a shortcut named
// "Rudder token" asks for the token, and Shortcuts opens Rudder again with the shortcut's output
// appended to the return address as `result` (Apple's x-callback-url for run-shortcut). Rudder reads
// it on start, keeps it on the device and cleans the address. Pure, so it is unit tested.

export const SHORTCUT_NAME = 'Rudder token';
const FLAG = 'bwtoken';

/** The address Shortcuts opens when done: Rudder itself, keeping the chart position (the hash cannot carry it: Shortcuts appends to the query). */
export function returnUrl(pageUrl, outcome) {
  const u = new URL(pageUrl);
  const at = u.hash.startsWith('#at=') ? u.hash.slice(4) : '';
  u.hash = '';
  u.search = '';
  u.searchParams.set(FLAG, outcome);
  if (at) u.searchParams.set('at', at);
  return u.href;
}

/** shortcuts:// link that runs the shortcut and comes back to Rudder with its output. */
export function shortcutUrl(pageUrl, name = SHORTCUT_NAME) {
  const p = new URLSearchParams({
    name,
    'x-success': returnUrl(pageUrl, 'ok'),
    'x-cancel': returnUrl(pageUrl, 'cancel'),
    'x-error': returnUrl(pageUrl, 'error'),
  });
  return `shortcuts://x-callback-url/run-shortcut?${p.toString().replace(/\+/g, '%20')}`;
}

/** The token in a shortcut's output: the bare token, "Bearer …", or the whole JSON answer. */
export function tokenFromResult(result) {
  let s = String(result ?? '').trim();
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s);
      if (j.access_token) return String(j.access_token);
      if (j.error) throw new Error(j.error_description || j.error);
    } catch (e) {
      if (e instanceof SyntaxError) return null;
      throw e;
    }
  }
  s = s.replace(/^Bearer\s+/i, '');
  // A JWT or other token: no spaces, reasonably long.
  return /^[A-Za-z0-9._~+/=-]{20,}$/.test(s) ? s : null;
}

/**
 * Read a return from Shortcuts out of the page address. null when the page was opened normally;
 * otherwise what happened, and the clean address (with the chart position back in the hash).
 */
export function readHandoff(pageUrl) {
  const u = new URL(pageUrl);
  const outcome = u.searchParams.get(FLAG);
  if (!outcome) return null;
  const at = u.searchParams.get('at');
  const clean = new URL(u.origin + u.pathname);
  if (at) clean.hash = `at=${at}`;
  const base = { cleanUrl: clean.href };
  if (outcome === 'cancel') return { ...base, status: 'cancel', message: 'The shortcut was cancelled; no new token.' };
  if (outcome === 'error') {
    const why = u.searchParams.get('errorMessage');
    return { ...base, status: 'error', message: `The shortcut "${SHORTCUT_NAME}" failed${why ? `: ${why.replace(/[.\s]+$/, '')}` : ''}. Check that it exists with that exact name.` };
  }
  let token = null;
  try {
    token = tokenFromResult(u.searchParams.get('result'));
  } catch (e) {
    return { ...base, status: 'error', message: `BarentsWatch refused the login in the shortcut (${e.message}). Check the client ID and secret in the shortcut.` };
  }
  if (!token) return { ...base, status: 'error', message: 'The shortcut did not return a token. Its last steps must be Get Dictionary Value "access_token", then nothing else (or Stop and Output).' };
  return { ...base, status: 'ok', token };
}
