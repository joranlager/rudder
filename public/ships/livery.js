// Ship inspector: k-means colour sampling of a photo and mapping the colours onto livery slots.

const toHex = (r, g, b) =>
  '#' +
  [r, g, b]
    .map((v) =>
      Math.round(Math.max(0, Math.min(255, v)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');
function hsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h, s, l };
}
/** Load an image with CORS enabled so its pixels can be read. */
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load image (CORS or network error)'));
    img.src = src;
  });
}
/**
 * k-means colour quantisation of a photo. Pixels near the centre of the frame
 * get more weight (the ship is usually the subject), and each cluster records
 * where in the frame it sits so sky and water can be told apart from the vessel.
 */
export function extractPalette(img, k = 8) {
  const W = 160;
  const H = Math.max(1, Math.round((W * img.height) / img.width));
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, W, H);
  const data = ctx.getImageData(0, 0, W, H).data;
  const n = W * H;
  const px = new Float32Array(n * 3);
  const wt = new Float32Array(n);
  const ys = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    px[i * 3] = data[i * 4];
    px[i * 3 + 1] = data[i * 4 + 1];
    px[i * 3 + 2] = data[i * 4 + 2];
    const x = (i % W) / W;
    const y = Math.floor(i / W) / H;
    ys[i] = y;
    const dx = (x - 0.5) / 0.5;
    const dy = (y - 0.55) / 0.5;
    wt[i] = Math.max(0.15, 1 - 0.6 * (dx * dx + dy * dy));
  }
  // k-means++ seeding (deterministic)
  const cent = [];
  cent.push([px[(n >> 1) * 3], px[(n >> 1) * 3 + 1], px[(n >> 1) * 3 + 2]]);
  const d2 = new Float32Array(n).fill(Infinity);
  while (cent.length < k) {
    const last = cent[cent.length - 1];
    let best = 0;
    let bestD = -1;
    for (let i = 0; i < n; i++) {
      const dr = px[i * 3] - last[0],
        dg = px[i * 3 + 1] - last[1],
        db = px[i * 3 + 2] - last[2];
      d2[i] = Math.min(d2[i], dr * dr + dg * dg + db * db);
      const score = d2[i] * wt[i];
      if (score > bestD) {
        bestD = score;
        best = i;
      }
    }
    cent.push([px[best * 3], px[best * 3 + 1], px[best * 3 + 2]]);
  }
  const assign = new Uint8Array(n);
  for (let it = 0; it < 12; it++) {
    const sum = cent.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      let bi = 0;
      let bd = Infinity;
      for (let j = 0; j < k; j++) {
        const dr = px[i * 3] - cent[j][0],
          dg = px[i * 3 + 1] - cent[j][1],
          db = px[i * 3 + 2] - cent[j][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) {
          bd = d;
          bi = j;
        }
      }
      assign[i] = bi;
      const w = wt[i];
      sum[bi][0] += px[i * 3] * w;
      sum[bi][1] += px[i * 3 + 1] * w;
      sum[bi][2] += px[i * 3 + 2] * w;
      sum[bi][3] += w;
    }
    for (let j = 0; j < k; j++) if (sum[j][3] > 0) cent[j] = [sum[j][0] / sum[j][3], sum[j][1] / sum[j][3], sum[j][2] / sum[j][3]];
  }
  const tot = cent.map(() => ({ w: 0, y: 0 }));
  let all = 0;
  for (let i = 0; i < n; i++) {
    tot[assign[i]].w += wt[i];
    tot[assign[i]].y += ys[i] * wt[i];
    all += wt[i];
  }
  const out = cent.map((cc, j) => {
    const { h, s, l } = hsl(cc[0], cc[1], cc[2]);
    const meanY = tot[j].w ? tot[j].y / tot[j].w : 0.5;
    const sw = { hex: toHex(cc[0], cc[1], cc[2]), share: tot[j].w / all, meanY, lum: l, sat: s, hue: h };
    const bluish = h >= 170 && h <= 235;
    // Sky: blue, light and high in the frame. Water: visibly coloured and low in the frame.
    // Dark, desaturated clusters are left alone: low in the frame they are usually a hull.
    if (meanY < 0.42 && bluish && s > 0.12 && l > 0.42) sw.role = 'sky';
    else if (meanY > 0.58 && h >= 140 && h < 250 && s > 0.2 && l > 0.16 && l < 0.8) sw.role = 'water';
    return sw;
  });
  // An overcast (white/grey) sky only when no blue sky was found; otherwise whites are paintwork.
  if (!out.some((s) => s.role === 'sky')) {
    for (const s of out) if (!s.role && s.meanY < 0.3 && s.sat < 0.15 && s.lum > 0.72) s.role = 'sky';
  }
  return out.filter((s) => s.share > 0.004).sort((a, b) => b.share - a.share);
}
const dist = (a, b) => {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
};
/** Titles of Commons files that are not photos of the vessel itself. */
export const NOT_A_PHOTO =
  /insignia|logo|emblem|crest|coat of arms|seal|badge|patch|flag|map|diagram|plan|drawing|schematic|stamp|poster|medal|\.svg$|\.tiff?$/i;
/** Map a photo palette onto livery slots. */
export function suggestLivery(swatches, base) {
  const cand = swatches.filter((s) => !s.role);
  const pool = cand.length >= 2 ? cand : swatches;
  const lv = { ...base };
  const whites = pool.filter((s) => s.lum > 0.6 && s.sat < 0.35).sort((a, b) => b.share - a.share);
  const sup = whites[0] ?? [...pool].sort((a, b) => b.lum - a.lum)[0];
  if (sup) lv.superstructure = sup.hex;
  // The hull: a distinct colour (dark, saturated or white; mid greys are usually docks,
  // haze or concrete) in the hull band of the frame, below the superstructure.
  const hullScore = (s) => {
    const distinct = s.lum < 0.22 || s.sat > 0.3 || s.lum > 0.8 ? 1.3 : 0.6;
    const band = Math.exp(-0.5 * ((s.meanY - 0.62) / 0.2) ** 2);
    const below = 1 + Math.max(0, s.meanY - (sup?.meanY ?? 0.5)) * 2;
    const contrast = sup ? Math.min(1, dist(s.hex, sup.hex) / 90) : 1;
    return s.share * distinct * band * below * contrast;
  };
  const hullC = pool
    .filter((s) => s !== sup)
    .map((s) => ({ s, score: hullScore(s) }))
    .sort((a, b) => b.score - a.score)[0]?.s;
  if (hullC) lv.hull = hullC.hex;
  else if (sup) lv.hull = sup.hex;
  // vivid colours high in the frame are usually funnels or company marks
  const vivid = (s) => s.sat * Math.max(0.05, 1 - Math.abs(s.lum - 0.5) * 1.6) * Math.sqrt(s.share) * (1.4 - s.meanY);
  const accents = pool
    .filter((s) => s !== sup && s !== hullC && s.sat > 0.35 && s.lum > 0.15 && s.lum < 0.85)
    .sort((a, b) => vivid(b) - vivid(a));
  if (accents[0]) {
    lv.funnel = accents[0].hex;
    lv.stripe = accents[0].hex;
  }
  const red = pool.find((s) => s !== hullC && (s.hue < 20 || s.hue > 340) && s.sat > 0.3 && s.lum < 0.55 && s.meanY > 0.5);
  if (red) lv.bootTop = red.hex;
  const dark = pool.filter((s) => s.lum < 0.18).sort((a, b) => b.share - a.share)[0];
  if (dark) lv.funnelTop = dark.hex;
  lv.text = (hullC?.lum ?? 0) > 0.55 ? (accents[0]?.hex ?? '#1b2a3a') : '#f5f5f5';
  return lv;
}
