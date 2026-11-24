// View from the bridge: the chart's camera on a ship's bridge, looking where the ship is heading and
// moving with it (dead reckoning between AIS reports, as the 3D models do: motion.js).
//
// MapLibre's camera looks at a point on the ground from a distance; calculateCameraOptionsFromTo
// turns "an eye here, at this height, looking at that point" into such a camera. The eye is at the
// ship's GPS antenna (on most ships on or above the wheelhouse), at the bridge's height estimated from
// the ship's 3D model; it looks at the sea some way ahead, so the horizon is in view. While the view
// is on, the user does not move the chart: the ship does. Buttons (or the arrow keys) look ahead, to
// port, to starboard or astern.

import { hullFromAis } from './ais.js';

export const LOOK_PITCH = 82; // degrees from straight down: the horizon sits in the upper part of the view
export const POV_MAX_PITCH = 85; // MapLibre's limit
export const POV_MAX_ZOOM = 22;
export const LOOKS = { port: -90, ahead: 0, starboard: 90, astern: 180 };
export const PITCH_RANGE = [55, POV_MAX_PITCH]; // looking down at the foredeck .. at the horizon
export const FOV_RANGE = [10, 60]; // degrees: zoomed in (binoculars) .. wide
export const DEFAULT_FOV = 36.87; // MapLibre's
const DRAG_DEG_PER_PX = 0.2;
const TIER_M = 2.7; // a superstructure deck, as the ship builder draws them
const EYE_M = 1.7; // eye above the bridge deck

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** Height of the eye on the bridge above the water, metres: freeboard, the decks below the bridge, eye height. */
export function eyeHeight(v) {
  const { params } = hullFromAis(v);
  const freeboard = Math.max(0.5, params.depth - params.draft);
  // The bridge deck: on cruise ships and ferries part way up the superstructure (as the ship builder
  // draws it, ships/ship.js), on others the top tier of the deckhouse.
  const tiers = params.kind === 'cruise' ? Math.round(params.decks * 0.62)
    : params.kind === 'ferry' ? Math.round(params.decks * 0.7) : params.decks - 1;
  const fromDecks = freeboard + Math.max(0, tiers) * TIER_M + EYE_M;
  // And high enough to see over the bow and the cargo: on long ships with low hulls (tankers,
  // container ships) about 13 % of the length up (a 100 m tanker's bridge is some 14 m up).
  const toSeeOver = Math.max(freeboard + 0.05 * params.length + 2, 0.13 * params.length + 1);
  return Math.max(2.5, fromDecks, toSeeOver);
}

/** Move [lon, lat] by `m` metres towards `bearing` (degrees). */
export function ahead([lon, lat], bearing, m) {
  const b = rad(bearing);
  return [lon + deg((m * Math.sin(b)) / (R * Math.cos(rad(lat)))), lat + deg((m * Math.cos(b)) / R)];
}

/**
 * Where the eye is and what it looks at: the ship's shown position at `eye` metres, looking along
 * heading + `look` at the sea, far enough ahead that the view is pitched LOOK_PITCH from straight down.
 */
export function bridgeCamera(at, heading, eye, look = 0, pitch = LOOK_PITCH) {
  const bearing = (((heading + look) % 360) + 360) % 360;
  const from = [at.lon, at.lat];
  return { from, to: ahead(from, bearing, eye * Math.tan(rad(pitch))), eye, bearing };
}

/** Looking around by dragging: right turns the view to the right, up looks up (towards the horizon). */
export function dragLook({ look, pitch }, dx, dy) {
  const [lo, hi] = PITCH_RANGE;
  return { look: (((look + dx * DRAG_DEG_PER_PX) % 360) + 540) % 360 - 180, pitch: Math.min(hi, Math.max(lo, pitch - dy * DRAG_DEG_PER_PX * 0.6)) };
}

/** Zooming: a narrower field of view by a factor (> 1 zooms in), within FOV_RANGE. */
export function zoomFov(fov, factor) {
  const [lo, hi] = FOV_RANGE;
  return Math.min(hi, Math.max(lo, fov / factor));
}

/** Speed and heading as the bridge bar shows them. */
export function bridgeLine(v, heading) {
  const sog = Number(v.speedOverGround);
  const parts = [];
  if (Number.isFinite(sog) && sog < 102.3) parts.push(`${sog.toFixed(1)} kn`);
  if (heading != null) parts.push(`heading ${String(Math.round(heading) % 360).padStart(3, '0')}°`);
  return parts.join(' · ');
}

/**
 * The bridge view on `map`. `ais` (aismap.js) gives the newest report of a ship, where it is shown
 * now, and keeps its model drawn while the view is on. `onExit` is told when the view ends by itself.
 */
export function createBridgeView(map, { ais, bar, far = null, onEnter = () => {}, onExit = () => {} }) {
  let mmsi = null;
  let look = 0;
  let pitch = LOOK_PITCH;
  const pointers = new Map(); // pointerId -> { x, y } while dragging or pinching
  let saved = null;
  let frame = 0;
  let lastText = '';
  let lastHeading = 0;
  const HANDLERS = ['dragPan', 'scrollZoom', 'boxZoom', 'dragRotate', 'keyboard', 'doubleClickZoom', 'touchZoomRotate', 'touchPitch'];

  function step() {
    frame = 0;
    if (mmsi === null) return;
    const v = ais.vessel(mmsi);
    if (!v) return exit('The ship is no longer reported by AIS.');
    const at = ais.shownShip(v);
    const heading = at.heading ?? lastHeading;
    lastHeading = heading;
    const cam = bridgeCamera(at, heading, eyeHeight(v), look, pitch);
    far?.update(at.lat, at.lon); // land and sea beyond what MapLibre draws (farview.js)
    const o = map.calculateCameraOptionsFromTo(
      new maplibregl.LngLat(...cam.from), cam.eye, new maplibregl.LngLat(...cam.to), 0,
    );
    // No camera padding: with the camera tilted this far, MapLibre's far plane collapses to a few
    // metres when there is any. (The helm console makes room by shrinking the map instead: helm.js.)
    map.jumpTo(o);
    const text = `${(v.name || '').trim() || `MMSI ${v.mmsi}`}|${bridgeLine(v, heading)}`;
    if (text !== lastText) {
      lastText = text;
      const [name, line] = text.split('|');
      bar.querySelector('[data-bridge-name]').textContent = name;
      bar.querySelector('[data-bridge-line]').textContent = line;
    }
    frame = requestAnimationFrame(step);
  }

  // ---------- looking around: drag (mouse or one finger), zoom (wheel or pinch) ----------
  const surface = map.getCanvasContainer();
  function onDown(e) {
    if (mmsi === null || (e.pointerType === 'mouse' && e.button !== 0)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    surface.setPointerCapture?.(e.pointerId);
    surface.classList.add('looking');
  }
  function onMove(e) {
    const p = pointers.get(e.pointerId);
    if (mmsi === null || !p) return;
    if (pointers.size === 2) {
      // Pinch: the change in distance between the two fingers zooms.
      const [a, b] = [...pointers.values()];
      const before = Math.hypot(a.x - b.x, a.y - b.y);
      p.x = e.clientX; p.y = e.clientY;
      const [a2, b2] = [...pointers.values()];
      const after = Math.hypot(a2.x - b2.x, a2.y - b2.y);
      if (before > 10) map.transform.fov = zoomFov(map.transform.fov, after / before);
      return;
    }
    const next = dragLook({ look, pitch }, e.clientX - p.x, e.clientY - p.y);
    p.x = e.clientX; p.y = e.clientY;
    pitch = next.pitch;
    setLook(next.look);
  }
  function onUp(e) {
    pointers.delete(e.pointerId);
    if (!pointers.size) surface.classList.remove('looking');
  }
  function onWheel(e) {
    if (mmsi === null) return;
    e.preventDefault();
    map.transform.fov = zoomFov(map.transform.fov, Math.exp(-e.deltaY * 0.0015));
  }
  surface.addEventListener('pointerdown', onDown);
  surface.addEventListener('pointermove', onMove);
  surface.addEventListener('pointerup', onUp);
  surface.addEventListener('pointercancel', onUp);
  surface.addEventListener('wheel', onWheel, { passive: false });

  function setLook(name) {
    look = typeof name === 'number' ? name : LOOKS[name] ?? 0;
    for (const b of bar.querySelectorAll('[data-look]')) b.setAttribute('aria-pressed', String(LOOKS[b.dataset.look] === look));
  }

  function onKey(e) {
    if (mmsi === null || e.target.closest?.('input, textarea')) return;
    if (e.key === 'Escape') exit();
    else if (e.key === 'ArrowLeft') setLook(look - 15);
    else if (e.key === 'ArrowRight') setLook(look + 15);
    else if (e.key === 'ArrowUp') setLook('ahead');
    else if (e.key === 'ArrowDown') setLook('astern');
    else return;
    e.preventDefault();
  }

  function enter(v) {
    if (mmsi !== null) exit();
    saved = {
      center: map.getCenter(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing(),
      maxPitch: map.getMaxPitch(), maxZoom: map.getMaxZoom(),
      handlers: HANDLERS.filter((h) => map[h]?.isEnabled()),
    };
    for (const h of saved.handlers) map[h].disable();
    map.setMaxPitch(POV_MAX_PITCH);
    map.setMaxZoom(POV_MAX_ZOOM);
    mmsi = v.mmsi;
    lastText = '';
    lastHeading = v.trueHeading < 360 ? v.trueHeading : v.courseOverGround < 360 ? v.courseOverGround : 0;
    setLook('ahead');
    pitch = LOOK_PITCH;
    ais.setPov(mmsi);
    document.body.classList.add('bridge-view');
    bar.hidden = false;
    document.addEventListener('keydown', onKey);
    onEnter(v);
    far?.start().then(() => map.triggerRepaint());
    frame = requestAnimationFrame(step);
  }

  function exit(message) {
    if (mmsi === null) return;
    cancelAnimationFrame(frame);
    frame = 0;
    mmsi = null;
    ais.setPov(null);
    far?.stop();
    document.removeEventListener('keydown', onKey);
    document.body.classList.remove('bridge-view');
    bar.hidden = true;
    pointers.clear();
    surface.classList.remove('looking');
    map.transform.fov = DEFAULT_FOV;
    map.setMaxZoom(saved.maxZoom);
    map.setMaxPitch(saved.maxPitch);
    map.jumpTo({ center: saved.center, zoom: Math.min(saved.zoom, saved.maxZoom), pitch: Math.min(saved.pitch, saved.maxPitch), bearing: saved.bearing });
    for (const h of saved.handlers) map[h].enable();
    saved = null;
    onExit(message);
  }

  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.look) { setLook(b.dataset.look); pitch = LOOK_PITCH; map.transform.fov = DEFAULT_FOV; }
    else if (b.hasAttribute('data-bridge-exit')) exit();
  });

  return { enter, exit, get active() { return mmsi !== null; }, get mmsi() { return mmsi; } };
}
