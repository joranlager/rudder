// Land heights in 3D: the chart draped over Kartverket's terrain model (hoydedata.no), with a light
// hillshade, as in Rope. The height tiles are made on demand from Kartverket's elevation service
// (terrain.js, demprotocol.js). Sea is height 0 there, so ships still sit on the water.
//
// On the chart heights are drawn 1.5 times taller than true, as usual for a map; from a ship's bridge
// (pov.js) they are drawn true, since that view should look like the real coast.

import { registerDemProtocol } from './demprotocol.js';
import { PROTOCOL, DEM_MIN_ZOOM, DEM_MAX_ZOOM, EXAGGERATION } from './terrain.js';
import { styleReady, whenStyleReady } from './mapready.js';

export const SOURCE_ID = 'terrain-dem';
export const HILLSHADE_ID = 'hillshade';
export const TRUE_SCALE = 1;
export const TILT = 50; // the chart is tilted this far when the heights are switched on from a flat view

/** The id of the first layer to put the hillshade under: the first that is not a background map. */
export function hillshadeBefore(layers, basemapIds) {
  return layers.find((l) => l.type !== 'background' && !basemapIds.includes(l.id) && l.id !== HILLSHADE_ID)?.id;
}

export function createLandHeights(map, { basemapIds, onError = () => {} }) {
  let on = false;
  let exaggeration = EXAGGERATION;
  let registered = false;
  let errors = 0;

  function apply() {
    if (!styleReady(map)) { whenStyleReady(map, apply); return; }
    if (on) {
      if (!registered) { registerDemProtocol(maplibregl, { log: (level, text) => console[level === 'warn' ? 'warn' : 'log'](text) }); registered = true; }
      if (!map.getSource(SOURCE_ID)) {
        map.addSource(SOURCE_ID, {
          type: 'raster-dem', tiles: [`${PROTOCOL}://{z}/{x}/{y}`], tileSize: 256,
          minzoom: DEM_MIN_ZOOM, maxzoom: DEM_MAX_ZOOM, encoding: 'terrarium',
          attribution: 'Heights © <a href="https://hoydedata.no/" target="_blank" rel="noopener">Kartverket</a>',
        });
      }
      if (!map.getLayer(HILLSHADE_ID)) {
        map.addLayer({
          id: HILLSHADE_ID, type: 'hillshade', source: SOURCE_ID,
          paint: { 'hillshade-exaggeration': 0.3, 'hillshade-shadow-color': '#2b2b3a', 'hillshade-highlight-color': '#ffffff', 'hillshade-accent-color': '#44445a' },
        }, hillshadeBefore(map.getStyle().layers, basemapIds));
      }
      map.setTerrain({ source: SOURCE_ID, exaggeration });
    } else {
      map.setTerrain(null);
      if (map.getLayer(HILLSHADE_ID)) map.removeLayer(HILLSHADE_ID);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    }
  }

  // A height tile that could not be made leaves the ground flat there for now; say so once.
  map.on('error', (e) => { if (e.sourceId === SOURCE_ID && ++errors === 1) onError('Some land heights could not be loaded.'); });

  return {
    get on() { return on; },
    /** Switch the heights on or off. */
    setOn(value) {
      on = Boolean(value);
      errors = 0;
      apply();
    },
    /** True heights (from a ship's bridge) or the map's usual 1.5 times. */
    setTrueScale(trueScale) {
      exaggeration = trueScale ? TRUE_SCALE : EXAGGERATION;
      if (on && map.getTerrain?.()) map.setTerrain({ source: SOURCE_ID, exaggeration });
    },
  };
}
