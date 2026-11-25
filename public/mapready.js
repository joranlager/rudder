// When can layers be added to the map? As soon as its style has been read. map.isStyleLoaded() is
// not that: it also waits for every tile of every source, which takes long while land heights or a
// slow map service load, and never comes while one tile keeps failing; map.once('idle') likewise.

/** True when the map's style is read and sources and layers can be added. */
export function styleReady(map) {
  return Boolean(map.style?._loaded);
}

/** Run `f` now if the style is read, else as soon as it is ('style.load'). */
export function whenStyleReady(map, f) {
  if (styleReady(map)) f();
  else map.once('style.load', f);
}
