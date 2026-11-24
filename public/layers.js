// Public Norwegian map services used by the simulator. All are open (NLOD / CC BY 4.0),
// need no key, and answer browsers with CORS. Checked 2026-11-23.

const WMTS = 'https://cache.kartverket.no/v1/wmts/1.0.0';
export const WMS = {
  depth: 'https://wms.geonorge.no/skwms1/wms.dybdedata2',
  chart: 'https://wms.geonorge.no/skwms1/wms.sjokartraster2',
  barentswatch: 'https://geo.barentswatch.no/geoserver/ows',
  kystverket: 'https://a3cloudmap.kystverket.no/wms.ashx',
};

const KARTVERKET = '© <a href="https://www.kartverket.no/" target="_blank" rel="noopener">Kartverket</a>';
const KYSTVERKET = '© <a href="https://www.kystverket.no/" target="_blank" rel="noopener">Kystverket</a>';
const BARENTSWATCH = '© <a href="https://www.barentswatch.no/" target="_blank" rel="noopener">BarentsWatch</a>';

/** Tile URL for a Kartverket WMTS layer in web mercator. */
export const wmtsUrl = (layer) => `${WMTS}/${layer}/default/webmercator/{z}/{y}/{x}.png`;

/** WMS GetMap URL template that MapLibre fills with each tile's bounding box. */
export function wmsTileUrl(base, layers, { size = 256, version = '1.1.1' } = {}) {
  const p = new URLSearchParams({
    service: 'WMS', version, request: 'GetMap', layers: [].concat(layers).join(','), styles: '',
    format: 'image/png', transparent: 'true', width: String(size), height: String(size),
    [version === '1.3.0' ? 'crs' : 'srs']: 'EPSG:3857',
  });
  // {bbox-epsg-3857} must stay unescaped for MapLibre to replace it.
  return `${base}?${p}&bbox={bbox-epsg-3857}`;
}

/** Background maps: exactly one is shown. */
export const BASEMAPS = [
  { id: 'sjokart', name: 'Nautical chart', note: 'Kartverket sjøkart, overview to harbour charts',
    tiles: [wmtsUrl('sjokartraster')], maxzoom: 18, attribution: KARTVERKET },
  { id: 'topograatone', name: 'Topographic (grey)', note: 'Kartverket topo, muted, good under overlays',
    tiles: [wmtsUrl('topograatone')], maxzoom: 18, attribution: KARTVERKET },
  { id: 'topo', name: 'Topographic', note: 'Kartverket topographic map',
    tiles: [wmtsUrl('topo')], maxzoom: 18, attribution: KARTVERKET },
];

/** Layers over the background. minzoom matches where each service starts drawing. */
export const OVERLAYS = [
  { id: 'depth-areas', name: 'Depth areas', group: 'Depth', note: 'Kartverket depth bands (dybdelag)',
    tiles: [wmsTileUrl(WMS.depth, ['Dybdelag'], { size: 512 })], tileSize: 512, minzoom: 9, opacity: 0.7, on: false,
    attribution: KARTVERKET },
  { id: 'depth-lines', name: 'Depth contours and soundings', group: 'Depth', note: 'Contours, depth points, rocks',
    tiles: [wmsTileUrl(WMS.depth, ['Dybdekontur', 'Dybdepunkt', 'skjaer_punkt', 'grunne'], { size: 512 })], tileSize: 512,
    minzoom: 12, opacity: 0.9, on: false, attribution: KARTVERKET },
  { id: 'unsurveyed', name: 'Not surveyed', group: 'Depth', note: 'Areas with no depth survey (ikke sjømålt)',
    tiles: [wmsTileUrl(WMS.depth, ['IkkeSjomalt'], { size: 512 })], tileSize: 512, minzoom: 8, opacity: 0.6, on: false,
    attribution: KARTVERKET },
  { id: 'pilot', name: 'Pilotage guidelines', group: 'Routes', note: 'Kystverket guidelines published on Routeinfo',
    tiles: [wmsTileUrl(WMS.kystverket, ['layer_52'])], minzoom: 5, opacity: 1, on: false, attribution: KYSTVERKET },
  { id: 'waves', name: 'Wave forecast', group: 'Conditions', note: 'BarentsWatch, latest run, exposed stretches',
    tiles: [wmsTileUrl(WMS.barentswatch, ['bw:waveforecast_area_iso_latest'])], minzoom: 4, opacity: 0.75, on: false,
    attribution: BARENTSWATCH },
  { id: 'ice', name: 'Ice chart', group: 'Conditions', note: 'MET Norway ice chart via BarentsWatch',
    tiles: [wmsTileUrl(WMS.barentswatch, ['bw:icechart_latest'])], minzoom: 2, opacity: 0.7, on: false,
    attribution: BARENTSWATCH },
  { id: 'fishing', name: 'Fishing gear at sea', group: 'Hazards', note: 'Reported nets and lines (BarentsWatch)',
    tiles: [wmsTileUrl(WMS.barentswatch, ['bw:fishingfacility_latest'])], minzoom: 5, opacity: 1, on: false,
    attribution: BARENTSWATCH },
];

/** MapLibre style with every background and overlay as a raster layer; visibility is set from settings. */
export function buildStyle(settings) {
  const sources = {}, layers = [{ id: 'bg', type: 'background', paint: { 'background-color': '#cfe3ef' } }];
  for (const b of BASEMAPS) {
    sources[b.id] = { type: 'raster', tiles: b.tiles, tileSize: 256, maxzoom: b.maxzoom, attribution: b.attribution };
    layers.push({ id: b.id, type: 'raster', source: b.id,
      layout: { visibility: settings.basemap === b.id ? 'visible' : 'none' } });
  }
  for (const o of OVERLAYS) {
    const s = settings.overlays?.[o.id] ?? {};
    sources[o.id] = { type: 'raster', tiles: o.tiles, tileSize: o.tileSize ?? 256, minzoom: o.minzoom, maxzoom: 19,
      attribution: o.attribution };
    layers.push({ id: o.id, type: 'raster', source: o.id, minzoom: o.minzoom,
      layout: { visibility: (s.on ?? o.on) ? 'visible' : 'none' },
      paint: { 'raster-opacity': s.opacity ?? o.opacity } });
  }
  return { version: 8, sources, layers };
}

export function defaultSettings() {
  return { basemap: 'sjokart', terrain: false, overlays: Object.fromEntries(OVERLAYS.map((o) => [o.id, { on: o.on, opacity: o.opacity }])) };
}

/** Merge stored settings over the defaults, dropping anything unknown. */
export function mergeSettings(stored) {
  const d = defaultSettings();
  if (!stored || typeof stored !== 'object') return d;
  if (BASEMAPS.some((b) => b.id === stored.basemap)) d.basemap = stored.basemap;
  if (typeof stored.terrain === 'boolean') d.terrain = stored.terrain;
  for (const o of OVERLAYS) {
    const s = stored.overlays?.[o.id];
    if (!s) continue;
    if (typeof s.on === 'boolean') d.overlays[o.id].on = s.on;
    if (Number.isFinite(s.opacity)) d.overlays[o.id].opacity = Math.min(1, Math.max(0, s.opacity));
  }
  return d;
}
