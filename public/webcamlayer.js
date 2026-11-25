// Webcams on the map (webcams.js): each camera an icon turned the way it looks, switched in the layers
// panel. Tapping one shows its sector (where it looks, across its field of view) and puts an eye on it;
// the eye opens the view through the camera with the ships on it (webcamview.js).
//
// The list is fetched from Statens vegvesen the first time the layer is switched on, with the
// directions worked out ahead of time (webcams.json); what is fine-tuned in the view is kept on this
// device (localStorage) and used over them.

import { camerasUrl, parseCameras, withView, cleanCalibration, camerasGeoJson, sectorRing, ATTRIBUTION } from './webcams.js';
import { styleReady, whenStyleReady } from './mapready.js';

const SRC = 'webcams', SECTOR = 'webcam-sector';
const ICON = 'webcam-icon', ICON_LAYER = 'webcam-icons', SECTOR_FILL = 'webcam-sector-fill', SECTOR_LINE = 'webcam-sector-line';
const CAL_KEY = 'rudder.webcams.calibration.v1';
const EMPTY = { type: 'FeatureCollection', features: [] };

const loadCal = () => { try { return cleanCalibration(JSON.parse(localStorage.getItem(CAL_KEY))); } catch { return {}; } };
const saveCal = (c) => { try { localStorage.setItem(CAL_KEY, JSON.stringify(c)); } catch { /* private mode */ } };

/** A camera icon: a lens with a cone of view pointing up (turned on the map), or a plain lens. */
function iconImage(cone) {
  const S = 64, c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d');
  if (cone) {
    const g = x.createLinearGradient(32, 32, 32, 0);
    g.addColorStop(0, 'rgba(255,170,40,0.85)');
    g.addColorStop(1, 'rgba(255,170,40,0)');
    x.fillStyle = g;
    x.beginPath(); x.moveTo(32, 32); x.lineTo(14, 2); x.lineTo(50, 2); x.closePath(); x.fill();
  }
  x.fillStyle = '#1d2b36'; x.strokeStyle = '#ffffff'; x.lineWidth = 3;
  x.beginPath(); x.roundRect(20, 24, 24, 16, 4); x.fill(); x.stroke();
  x.fillStyle = '#ffb020';
  x.beginPath(); x.arc(32, 32, 4.5, 0, Math.PI * 2); x.fill();
  return x.getImageData(0, 0, S, S);
}

export function createWebcams(map, { onView = () => {}, onError = () => {} } = {}) {
  let on = false;
  let cams = []; // with view
  let raw = null, directions = {};
  let calibration = loadCal();
  let loading = null;
  let selected = null;
  let eye = null;
  const listeners = new Set();

  async function load() {
    loading ??= (async () => {
      const [list, dirs] = await Promise.all([
        fetch(camerasUrl()).then((r) => { if (!r.ok) throw new Error(`Statens vegvesen answered ${r.status}`); return r.json(); }),
        fetch(new URL('./webcams.json', import.meta.url)).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
      ]);
      raw = parseCameras(list);
      directions = dirs.directions ?? {};
      rebuild();
    })().catch((e) => { loading = null; throw e; });
    return loading;
  }

  function rebuild() {
    cams = (raw ?? []).map((c) => withView(c, directions, calibration));
    map.getSource(SRC)?.setData(camerasGeoJson(cams));
    if (selected) select(selected.id, false);
    for (const f of listeners) f();
  }

  function addLayers() {
    if (!map.hasImage(`${ICON}-cone`)) map.addImage(`${ICON}-cone`, iconImage(true), { pixelRatio: 2 });
    if (!map.hasImage(`${ICON}-dot`)) map.addImage(`${ICON}-dot`, iconImage(false), { pixelRatio: 2 });
    if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: camerasGeoJson(cams), attribution: ATTRIBUTION });
    if (!map.getSource(SECTOR)) map.addSource(SECTOR, { type: 'geojson', data: EMPTY });
    // Under the ships (the AIS layers are added on top later, or are already there: go under them).
    const before = ['ais-hull', 'ais-hull-line', 'ais-arrow', 'ais-dot'].find((id) => map.getLayer(id));
    if (!map.getLayer(SECTOR_FILL)) map.addLayer({ id: SECTOR_FILL, type: 'fill', source: SECTOR, paint: { 'fill-color': '#ffb020', 'fill-opacity': 0.18 } }, before);
    if (!map.getLayer(SECTOR_LINE)) map.addLayer({ id: SECTOR_LINE, type: 'line', source: SECTOR, paint: { 'line-color': '#ff9800', 'line-width': 2, 'line-dasharray': [3, 2] } }, before);
    if (!map.getLayer(ICON_LAYER)) {
      map.addLayer({
        id: ICON_LAYER, type: 'symbol', source: SRC, minzoom: 5,
        layout: {
          'icon-image': ['case', ['get', 'known'], `${ICON}-cone`, `${ICON}-dot`],
          'icon-rotate': ['get', 'bearing'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-size': ['interpolate', ['linear'], ['zoom'], 5, 0.45, 10, 0.7, 14, 1],
        },
        paint: { 'icon-opacity': ['case', ['get', 'ok'], 1, 0.45] },
      });
    }
  }

  function removeLayers() {
    for (const l of [ICON_LAYER, SECTOR_LINE, SECTOR_FILL]) if (map.getLayer(l)) map.removeLayer(l);
    for (const s of [SRC, SECTOR]) if (map.getSource(s)) map.removeSource(s);
  }

  function apply() {
    if (!styleReady(map)) { whenStyleReady(map, apply); return; }
    if (on) {
      addLayers();
      load().catch((e) => onError(`Webcams could not be loaded (${e.message}).`));
    } else {
      deselect();
      removeLayers();
    }
  }

  function select(id, fly = false) {
    const cam = cams.find((c) => c.id === id);
    if (!cam) return null;
    selected = cam;
    map.getSource(SECTOR)?.setData(cam.view.bearing === null ? EMPTY : {
      type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [sectorRing(cam)] } }],
    });
    if (!eye) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'webcam-eye';
      el.title = 'Look through this camera';
      el.setAttribute('aria-label', 'Look through this camera');
      el.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5C6.5 5 2.7 9.2 1.5 12c1.2 2.8 5 7 10.5 7s9.3-4.2 10.5-7C21.3 9.2 17.5 5 12 5Zm0 11.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9Zm0-2.3a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z"/></svg>';
      el.addEventListener('click', (e) => { e.stopPropagation(); if (selected) onView(selected); });
      eye = new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -14] });
    }
    eye.setLngLat([cam.lon, cam.lat]).addTo(map);
    if (fly) map.easeTo({ center: [cam.lon, cam.lat], zoom: Math.max(map.getZoom(), 13) });
    return cam;
  }

  function deselect() {
    selected = null;
    eye?.remove();
    map.getSource(SECTOR)?.setData(EMPTY);
  }

  return {
    get on() { return on; },
    setOn(value) {
      on = Boolean(value);
      apply();
    },
    /** The cameras under a map point (a site can have several), nearest the point first. */
    camerasAt(point) {
      if (!on || !map.getLayer(ICON_LAYER)) return [];
      const box = [[point.x - 12, point.y - 12], [point.x + 12, point.y + 12]];
      const ids = [...new Set(map.queryRenderedFeatures(box, { layers: [ICON_LAYER] }).map((f) => f.properties.id))];
      const found = ids.map((id) => cams.find((c) => c.id === id)).filter(Boolean);
      // the cameras of the same site come along, in order
      const sites = new Set(found.map((c) => c.site));
      return cams.filter((c) => sites.has(c.site)).sort((a, b) => a.id.localeCompare(b.id));
    },
    select,
    deselect,
    get selected() { return selected; },
    camera: (id) => cams.find((c) => c.id === id) ?? null,
    /** Fine-tune a camera's view on this device ({ bearing, fov, tilt, height }); null puts it back as worked out. */
    calibrate(id, values) {
      if (values === null) delete calibration[id];
      else calibration = cleanCalibration({ ...calibration, [id]: { ...(calibration[id] ?? {}), ...values } });
      saveCal(calibration);
      rebuild();
      return cams.find((c) => c.id === id) ?? null;
    },
    /** Be told when the cameras change (loaded, or a view fine-tuned). */
    onChange(f) { listeners.add(f); return () => listeners.delete(f); },
  };
}
