// Ship inspector: photos of a vessel from Wikimedia Commons (its image, its category, a text search).

const API = 'https://commons.wikimedia.org/w/api.php';
function stripHtml(s) {
  if (!s) return undefined;
  const t = s
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t || undefined;
}
async function query(params, signal) {
  const sp = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    origin: '*',
    prop: 'imageinfo',
    iiprop: 'url|size|mime|extmetadata',
    iiurlwidth: '1280',
    iiextmetadatafilter: 'Artist|LicenseShortName',
    ...params,
  });
  const res = await fetch(`${API}?${sp}`, { signal });
  if (!res.ok) throw new Error(`Commons request failed (${res.status})`);
  const json = await res.json();
  const pages = json?.query?.pages ?? [];
  return pages.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
}
function toImages(pages) {
  const out = [];
  for (const p of pages) {
    const ii = p.imageinfo?.[0];
    if (!ii) continue;
    if (ii.mime && !/^image\/(jpeg|png|webp|gif|tiff)/.test(ii.mime)) continue;
    out.push({
      title: p.title.replace(/^File:/, ''),
      thumb: ii.thumburl ?? ii.url,
      full: ii.url,
      page: ii.descriptionurl,
      width: ii.width,
      height: ii.height,
      author: stripHtml(ii.extmetadata?.Artist?.value),
      license: stripHtml(ii.extmetadata?.LicenseShortName?.value),
    });
  }
  return out;
}
/** Wikidata P18 values are Special:FilePath URLs; reduce them to a file title. */
export function fileTitleFromP18(url) {
  const raw = url.substring(url.lastIndexOf('/') + 1);
  return decodeURIComponent(raw).replace(/_/g, ' ');
}
export async function fileInfo(titles, signal) {
  if (!titles.length) return [];
  return toImages(await query({ titles: titles.map((t) => `File:${t}`).join('|') }, signal));
}
export async function searchCommonsImages(term, limit = 24, signal) {
  if (!term.trim()) return [];
  return toImages(
    await query(
      {
        generator: 'search',
        gsrnamespace: '6',
        gsrsearch: `${term} filetype:bitmap`,
        gsrlimit: String(limit),
      },
      signal,
    ),
  );
}
export async function categoryImages(category, limit = 24, signal) {
  return toImages(
    await query(
      {
        generator: 'categorymembers',
        gcmtitle: `Category:${category}`,
        gcmtype: 'file',
        gcmlimit: String(limit),
      },
      signal,
    ),
  );
}
/**
 * Gather photos for a ship: its Wikidata image first, then its Commons category,
 * then a free-text search. Results are de-duplicated by title.
 */
export async function shipImages(opts, signal) {
  const tasks = [];
  tasks.push(opts.p18 ? fileInfo([fileTitleFromP18(opts.p18)], signal) : Promise.resolve([]));
  tasks.push(opts.category ? categoryImages(opts.category, 30, signal) : Promise.resolve([]));
  tasks.push(searchCommonsImages(`"${opts.label}"`, 20, signal));
  const settled = await Promise.allSettled(tasks);
  const seen = new Set();
  const out = [];
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue;
    for (const img of s.value) {
      if (seen.has(img.title)) continue;
      seen.add(img.title);
      out.push(img);
    }
  }
  if (!out.length && settled.every((s) => s.status === 'rejected')) {
    throw settled[0].reason;
  }
  return out;
}
