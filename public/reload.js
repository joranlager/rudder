// Four quick taps on the Rudder logo (top left) do a hard reload: every file this page loaded from
// Rudder's own site is fetched again past the browser cache, then the page reloads. GitHub Pages lets
// browsers cache files for 10 minutes, so a plain reload can still run an older app.js; this cannot.
// The chart position is in the address (#at=…), so the reload opens the same view.

/** Counts taps; true on the tap that completes `needed` taps within `windowMs`. */
export function tapCounter({ needed = 4, windowMs = 2500 } = {}) {
  let taps = [];
  return (t) => {
    taps = taps.filter((x) => t - x <= windowMs);
    taps.push(t);
    if (taps.length < needed) return false;
    taps = [];
    return true;
  };
}

/**
 * The page's own files to fetch again: same origin only (map tiles and other services are left to
 * their own caching), without the address fragment, each once, and the page itself first.
 */
export function reloadTargets(pageUrl, resourceUrls) {
  const page = new URL(pageUrl);
  page.hash = '';
  const out = [page.href];
  for (const u of resourceUrls) {
    let url;
    try { url = new URL(u, page); } catch { continue; }
    if (url.origin !== page.origin) continue;
    url.hash = '';
    if (!out.includes(url.href)) out.push(url.href);
  }
  return out;
}

/** Fetch the page's files past the cache (which also refreshes the cache), then reload. */
export async function hardReload({ timeoutMs = 6000, minimumMs = 400 } = {}) {
  const urls = reloadTargets(location.href, performance.getEntriesByType('resource').map((e) => e.name));
  const shown = new Promise((r) => setTimeout(r, minimumMs)); // long enough to see that it is reloading
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs); // never hang: reload anyway
  try {
    await Promise.all([shown, Promise.allSettled(urls.map((u) => fetch(u, { cache: 'reload', signal: ctl.signal })))]);
  } finally {
    clearTimeout(timer);
  }
  location.reload();
}

/** Wire the logo: count clicks (a tap, or Enter/Space on the button) and show that a reload is coming. */
export function enableLogoReload(button, { onReload } = {}) {
  const count = tapCounter();
  button.addEventListener('click', (e) => {
    button.classList.remove('tapped');
    void button.offsetWidth; // restart the small tap animation
    button.classList.add('tapped');
    if (!count(e.timeStamp)) return;
    onReload?.();
    hardReload();
  });
}
