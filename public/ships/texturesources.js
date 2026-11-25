// Ship inspector: pictures to put on a ship, from the web. Every source answers browsers directly
// (CORS), needs no key, and says who made each picture and under which licence:
//
// - Wikimedia Commons: photos and textures (commons.js), the ship's own photos included.
// - Openverse (WordPress): openly licensed pictures gathered from Flickr, museums and others.
// - Poly Haven: seamless CC0 surface textures (painted metal, rust, wood, planks, concrete...).
// - Any picture's web address, when its site lets other pages use it, and the user's own files.
//
// Pure apart from fetch, so the request and answer handling is unit tested.

import { searchCommonsImages } from './commons.js';

export const TEXTURE_SOURCES = [
  ['commons', 'Wikimedia Commons'],
  ['openverse', 'Openverse'],
  ['polyhaven', 'Poly Haven'],
];

/** A few searches that give good ship textures. */
export const TEXTURE_SUGGESTIONS = ['painted metal', 'rust', 'hull plating', 'teak deck', 'wood planks', 'camouflage', 'weathered paint', 'corrugated'];

// ---------- Openverse ----------

export const OPENVERSE_API = 'https://api.openverse.org/v1/images/';

export function openverseUrl(q, pageSize = 24) {
  return `${OPENVERSE_API}?${new URLSearchParams({ q, page_size: String(pageSize), mature: 'false' })}`;
}

/** Openverse's answer as pictures: { title, thumb, full, alt: [..], page, author, license }. */
export function parseOpenverse(json) {
  return (json?.results ?? [])
    .filter((r) => r?.url)
    .map((r) => ({
      title: r.title || 'Untitled',
      thumb: r.thumbnail || r.url,
      // The original lies on its own site, which may not let other pages read it; Openverse's
      // own copy (the thumbnail) does, so it is the fallback.
      full: r.url,
      alt: [r.thumbnail].filter(Boolean),
      page: r.foreign_landing_url || r.url,
      author: r.creator || '',
      license: r.license ? `${String(r.license).toUpperCase()}${r.license_version ? ` ${r.license_version}` : ''}`.replace(/^CC0 1\.0$/, 'CC0') : '',
      source: 'Openverse',
    }));
}

export async function searchOpenverse(q, signal) {
  const res = await fetch(openverseUrl(q), { signal });
  if (!res.ok) throw new Error(`Openverse answered ${res.status}`);
  return parseOpenverse(await res.json());
}

// ---------- Poly Haven ----------

export const POLYHAVEN_API = 'https://api.polyhaven.com';
export const polyhavenThumb = (id) => `https://cdn.polyhaven.com/asset_img/thumbs/${encodeURIComponent(id)}.png?width=256&height=256`;

/**
 * Poly Haven's texture list ({ id: { name, categories, tags, authors } }) matched against the words
 * searched for (all of them, in the name, tags or categories), best first.
 */
export function matchPolyhaven(list, q, max = 30) {
  const words = String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  for (const [id, a] of Object.entries(list ?? {})) {
    const name = String(a?.name ?? id).toLowerCase();
    const hay = [name, id, ...(a?.tags ?? []), ...(a?.categories ?? [])].join(' ').toLowerCase();
    if (!words.every((w) => hay.includes(w))) continue;
    const score = words.reduce((s, w) => s + (name.includes(w) ? 2 : 1), 0);
    out.push([score, id, a]);
  }
  return out
    .sort((x, y) => y[0] - x[0] || x[1].localeCompare(y[1]))
    .slice(0, max)
    .map(([, id, a]) => ({
      title: a?.name ?? id,
      id,
      thumb: polyhavenThumb(id),
      full: null, // asked for when chosen (polyhavenDiffuse)
      page: `https://polyhaven.com/a/${encodeURIComponent(id)}`,
      author: Object.keys(a?.authors ?? {}).join(', '),
      license: 'CC0',
      source: 'Poly Haven',
    }));
}

/** The colour (diffuse) picture of a Poly Haven texture from its files list, at about `res`. */
export function polyhavenDiffuse(files, res = '2k') {
  const key = Object.keys(files ?? {}).find((k) => /^diff/i.test(k)) ?? Object.keys(files ?? {}).find((k) => /^(col|albedo)/i.test(k));
  const byRes = key ? files[key] : null;
  if (!byRes) return null;
  const r = byRes[res] ?? byRes['1k'] ?? byRes[Object.keys(byRes)[0]];
  return r?.jpg?.url ?? r?.png?.url ?? null;
}

let polyhavenList = null;
export async function searchPolyhaven(q, signal) {
  polyhavenList ??= fetch(`${POLYHAVEN_API}/assets?t=textures`, { signal })
    .then((r) => { if (!r.ok) throw new Error(`Poly Haven answered ${r.status}`); return r.json(); })
    .catch((e) => { polyhavenList = null; throw e; });
  return matchPolyhaven(await polyhavenList, q);
}

export async function polyhavenImageUrl(id, signal) {
  const res = await fetch(`${POLYHAVEN_API}/files/${encodeURIComponent(id)}`, { signal });
  if (!res.ok) throw new Error(`Poly Haven answered ${res.status}`);
  const url = polyhavenDiffuse(await res.json());
  if (!url) throw new Error('Poly Haven has no colour picture for this texture');
  return url;
}

// ---------- Commons ----------

export async function searchCommons(q, signal) {
  return (await searchCommonsImages(q, 24, signal)).map((i) => ({ ...i, alt: [], source: 'Wikimedia Commons' }));
}

export function searchTextures(source, q, signal) {
  if (!String(q ?? '').trim()) return Promise.resolve([]);
  if (source === 'openverse') return searchOpenverse(q, signal);
  if (source === 'polyhaven') return searchPolyhaven(q, signal);
  return searchCommons(q, signal);
}

// ---------- a picture's address ----------

/** A web address typed or pasted, as a URL string; null when it is not an http(s) address. */
export function pictureUrl(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(t) ? t : `https://${t}`);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Why a picture from another site could not be used, in words. */
export const CORS_HINT = 'That site does not let other web pages use its pictures (CORS). Save the picture to your device and use Upload instead.';
