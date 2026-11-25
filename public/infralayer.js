// Roads, bridges and buildings on the map (infra.js), switched in the layers panel and remembered.
// The vector tiles come from OpenFreeMap; the 3D bridges are built from the bridge roads in the tiles
// loaded, again whenever the map stops moving or new tiles arrive.

import { TILEJSON, ATTRIBUTION, SOURCE, BRIDGE_SOURCE, BRIDGE_MIN_ZOOM, PREFIX, infraLayers, buildBridges } from './infra.js';

const EMPTY = { type: 'FeatureCollection', features: [] };

/** The first layer drawn above the works: the first that is not a background, overlay, hillshade or ours. */
export function infraBefore(layers, belowIds) {
  return layers.find((l) => l.type !== 'background' && !belowIds.includes(l.id) && l.id !== 'hillshade' && !l.id.startsWith(PREFIX))?.id;
}

export function createInfra(map, { belowIds = [], onError = () => {} } = {}) {
  let on = false;
  let timer = 0;
  let errors = 0;

  function rebuild() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const src = map.getSource(BRIDGE_SOURCE);
      if (!on || !src) return;
      if (map.getZoom() < BRIDGE_MIN_ZOOM - 0.5) { src.setData(EMPTY); return; }
      const feats = map.querySourceFeatures(SOURCE, { sourceLayer: 'transportation', filter: ['==', ['get', 'brunnel'], 'bridge'] });
      src.setData(buildBridges(feats));
    }, 150);
  }
  const onData = (e) => { if (e.sourceId === SOURCE && e.isSourceLoaded) rebuild(); };

  function apply() {
    // Only the style must be there; map.isStyleLoaded() also waits for every tile, which can be a
    // long time while the land heights load (or never, while one keeps failing).
    if (!map.style?._loaded) { map.once('style.load', apply); return; }
    if (on) {
      if (!map.getSource(SOURCE)) map.addSource(SOURCE, { type: 'vector', url: TILEJSON, attribution: ATTRIBUTION });
      if (!map.getSource(BRIDGE_SOURCE)) map.addSource(BRIDGE_SOURCE, { type: 'geojson', data: EMPTY });
      const before = infraBefore(map.getStyle().layers, belowIds);
      for (const l of infraLayers()) if (!map.getLayer(l.id)) map.addLayer(l, before);
      map.on('sourcedata', onData);
      map.on('moveend', rebuild);
      rebuild();
    } else {
      map.off('sourcedata', onData);
      map.off('moveend', rebuild);
      for (const l of infraLayers()) if (map.getLayer(l.id)) map.removeLayer(l.id);
      for (const s of [BRIDGE_SOURCE, SOURCE]) if (map.getSource(s)) map.removeSource(s);
    }
  }

  map.on('error', (e) => { if (e.sourceId === SOURCE && ++errors === 1) onError('Some roads and buildings could not be loaded.'); });

  return {
    get on() { return on; },
    setOn(value) {
      on = Boolean(value);
      errors = 0;
      apply();
    },
  };
}
