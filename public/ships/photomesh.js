// The three.js side of a vessel from photos (photomodel.js): the pictures read and cut out, and the
// carved, textured mesh made into an object the inspector shows like a model from a file.

import * as THREE from '../vendor/three.js';
import { silhouette, sizeFrom, carve, mesh, texturedParts, inferFromSide, project, inside } from './photomodel.js';

const MAX_SIDE = 640; // pictures are cut out at this size; textures keep up to 2048

/** A picture file read into an <img>. */
export function readPicture(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`${file.name} is not a picture the browser can read`)); };
    img.src = url;
  });
}

function drawn(img, max) {
  const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * k));
  c.height = Math.max(1, Math.round(img.naturalHeight * k));
  c.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0, c.width, c.height);
  return c;
}

/** The ship cut out of a picture (photomodel.js silhouette), with a preview: the cut-out tinted. */
export function cutOut(img, threshold, view = null) {
  const c = drawn(img, MAX_SIDE);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const data = ctx.getImageData(0, 0, c.width, c.height);
  const sil = silhouette(data, threshold, { solidColumns: ['port', 'starboard', 'top', 'bottom'].includes(view) });
  if (!sil) return { sil: null, preview: c.toDataURL('image/jpeg', 0.7) };
  const out = ctx.createImageData(c.width, c.height);
  for (let i = 0; i < sil.mask.length; i++) {
    const on = sil.mask[i];
    out.data[i * 4] = on ? data.data[i * 4] : 20;
    out.data[i * 4 + 1] = on ? data.data[i * 4 + 1] : 30;
    out.data[i * 4 + 2] = on ? data.data[i * 4 + 2] : 45;
    out.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  ctx.strokeStyle = '#ff9800';
  ctx.lineWidth = 2;
  const b = sil.box;
  ctx.strokeRect(b.x0 + 0.5, b.y0 + 0.5, b.x1 - b.x0, b.y1 - b.y0);
  return { sil, preview: c.toDataURL('image/jpeg', 0.7) };
}

/** The part of a picture inside the ship's box, as a canvas for a texture (at most 2048 px). */
function cropped(img, sil) {
  const k = img.naturalWidth / sil.width;
  const { x0, y0, x1, y1 } = sil.box;
  const sx = x0 * k, sy = y0 * k, sw = (x1 - x0 + 1) * k, sh = (y1 - y0 + 1) * k;
  const s = Math.min(1, 2048 / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * s));
  c.height = Math.max(1, Math.round(sh * s));
  c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

/**
 * The vessel from its pictures: `views` { [view]: { img, sil, flip } }, `dims` { length, beam?,
 * height? } (beam and height from the pictures unless given). Returns { object, size }: the object
 * in the ship's frame (bow +x, y up from the keel, starboard +z), in metres.
 */
/**
 * The view from above when there is no photo of it: each point along the length in the colour at the
 * top of the side photo's outline there (the roof or deck seen from above), the edges a little darker.
 * Returns { canvas, sil } with a box of the vessel's proportions.
 */
function inferredTop(view, v, size) {
  const { img, sil } = v;
  const c = document.createElement('canvas');
  c.width = sil.width;
  c.height = sil.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const px = ctx.getImageData(0, 0, c.width, c.height).data;
  const W = 1024, Hh = Math.max(16, Math.round((W * size.B) / size.L));
  const out = document.createElement('canvas');
  out.width = W;
  out.height = Hh;
  const o = out.getContext('2d');
  const span = Math.max(2, Math.round((sil.box.y1 - sil.box.y0) * 0.04));
  for (let i = 0; i < W; i++) {
    const x = ((i + 0.5) / W) * size.L;
    const [u] = project(view, [x, size.H / 2, 0], size, Boolean(v.flip), sil);
    const col = Math.min(sil.box.x1, Math.max(sil.box.x0, Math.round(sil.box.x0 + u * (sil.box.x1 - sil.box.x0))));
    let top = -1;
    for (let y = sil.box.y0; y <= sil.box.y1; y++) if (sil.mask[y * sil.width + col]) { top = y; break; }
    let r = 128, g = 128, b = 128, n = 0;
    if (top >= 0) {
      r = g = b = 0;
      for (let y = top + 1; y <= Math.min(sil.box.y1, top + span); y++) { const k = (y * sil.width + col) * 4; r += px[k]; g += px[k + 1]; b += px[k + 2]; n++; }
      if (n) { r /= n; g /= n; b /= n; }
    }
    const grad = o.createLinearGradient(0, 0, 0, Hh);
    const dark = `rgb(${r * 0.8},${g * 0.8},${b * 0.8})`, lit = `rgb(${r},${g},${b})`;
    grad.addColorStop(0, dark); grad.addColorStop(0.07, lit); grad.addColorStop(0.93, lit); grad.addColorStop(1, dark);
    o.fillStyle = grad;
    o.fillRect(i, 0, 1, Hh);
  }
  const topSil = { width: W, height: Hh, mask: new Uint8Array(W * Hh).fill(1), box: { x0: 0, y0: 0, x1: W - 1, y1: Hh - 1 } };
  return { canvas: out, sil: topSil };
}

export function buildFromPhotos(views, dims, { res = 180, smooth = 4, kind = 'cargo' } = {}) {
  const sils = {}, flips = {};
  for (const [k, v] of Object.entries(views)) if (v?.sil) { sils[k] = v.sil; flips[k] = Boolean(v.flip); }
  // One side photo and nothing from above or below: the rest is inferred from the vessel's type.
  const side = ['port', 'starboard'].find((k) => sils[k]);
  if (side && !sils.top && !sils.bottom) {
    const est = sizeFrom(dims.length, { [side]: sils[side] });
    const size = { L: dims.length, B: dims.beam > 0 ? dims.beam : dims.typicalBeam ?? est.B, H: dims.height > 0 ? dims.height : est.H };
    const g = inferFromSide(sils[side], side, size, { res, flip: flips[side], kind });
    const m = mesh(g, smooth);
    if (!m.indices.length) throw new Error('Nothing could be made of the photo: check its cut-out');
    const top = inferredTop(side, views[side], size);
    const parts = texturedParts(m, size, [side, 'top'], flips, { [side]: sils[side], top: top.sil });
    return finish(parts, size, (k) => (k === 'top' ? top.canvas : cropped(views[k].img, views[k].sil)), { used: [side], ignored: [], mirrored: [], inferred: true });
  }
  const sizeOf = (ss) => {
    const est = sizeFrom(dims.length, ss);
    return { L: dims.length, B: dims.beam > 0 ? dims.beam : est.B, H: dims.height > 0 ? dims.height : est.H };
  };
  let size = sizeOf(sils);
  let g = carve(sils, size, { res, flips });
  // a photo found not to agree with the others does not size the vessel either: once more without it
  if (g.ignored.length) {
    const kept = Object.fromEntries(Object.entries(sils).filter(([k]) => g.used.includes(k)));
    const again = sizeOf(kept);
    if (Math.abs(again.H - size.H) > 0.01 || Math.abs(again.B - size.B) > 0.01) {
      const first = g;
      size = again;
      g = carve(kept, size, { res, flips });
      g.ignored = [...first.ignored, ...g.ignored];
      g.mirrored = [...first.mirrored, ...g.mirrored];
    }
  }
  for (const k of g.mirrored) flips[k] = !flips[k];
  const m = mesh(g, smooth);
  if (!m.indices.length) throw new Error('The pictures leave nothing in common: check that each is the view it says, and the mirroring');
  // painted only from the photos the shape was made from: one taken at an angle would smear
  const parts = texturedParts(m, size, g.used, flips, sils);
  return finish(parts, size, (k) => cropped(views[k].img, views[k].sil), { used: g.used, ignored: g.ignored, mirrored: g.mirrored });
}

/** The textured parts as a three.js group, centred on the length. */
function finish(parts, size, pictureOf, info) {
  const group = new THREE.Group();
  group.name = 'vessel_from_photos';
  for (const [k, p] of Object.entries(parts)) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(p.normals, 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(p.uvs, 2));
    const tex = new THREE.CanvasTexture(pictureOf(k));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7, metalness: 0.05 });
    mat.name = `photo_${k}`;
    const mesh3 = new THREE.Mesh(geom, mat);
    mesh3.name = `hull_${k}`;
    group.add(mesh3);
  }
  // the ship's frame starts at the stern: centre it on the length, as the inspector's models are
  group.children.forEach((c) => c.geometry.translate(-size.L / 2, 0, 0));
  return { object: group, size, ...info };
}
