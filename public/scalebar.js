// What the metric scale bar shows, computed the way MapLibre's ScaleControl does, so features can
// switch on "when the scale bar reads 200 m" exactly as the user sees it.

export const SCALE_MAX_WIDTH = 120; // px, as the ScaleControl in app.js
export const MODEL_SCALE_M = 200; // ships are drawn as 3D models from this scale bar reading down

/** MapLibre's rounding of the scale bar distance: 1, 2, 3, 5 or 10 times a power of ten. */
export function roundScale(num) {
  if (!(num > 0)) return 0;
  const pow10 = 10 ** (`${Math.floor(num)}`.length - 1);
  let d = num / pow10;
  if (d >= 10) d = 10;
  else if (d >= 5) d = 5;
  else if (d >= 3) d = 3;
  else if (d >= 2) d = 2;
  else if (d >= 1) d = 1;
  else {
    const m = 10 ** Math.ceil(-Math.log(d) / Math.LN10);
    d = Math.round(d * m) / m;
  }
  return pow10 * d;
}

/** Metres the metric scale bar shows on this map now (measured across the middle, like the control). */
export function scaleBarMetres(map, maxWidth = SCALE_MAX_WIDTH) {
  const y = map.getContainer().clientHeight / 2;
  const left = map.unproject([0, y]);
  const right = map.unproject([maxWidth, y]);
  return roundScale(left.distanceTo(right));
}

/** Whether ships should be drawn as 3D models at this scale bar reading. */
export const modelsAtScale = (metres) => metres > 0 && metres <= MODEL_SCALE_M;
