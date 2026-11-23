// Ship inspector: Wavefront OBJ + MTL export of the reconstructed ship.

import * as THREE from '../vendor/three.js';

const fmt = (n) => (Math.abs(n) < 1e-6 ? '0' : n.toFixed(4).replace(/\.?0+$/, ''));
const safe = (s) => s.replace(/[^A-Za-z0-9_\-]+/g, '_');
/**
 * Wavefront OBJ + MTL export of a ship group. Geometry is written in the ship's
 * rest frame (wave motion is removed), in metres, Y up. Instanced meshes (the
 * container stacks) are expanded, one material per instance colour.
 */
export function exportOBJ(root, baseName, textures) {
  const name = safe(baseName) || 'ship';
  const lines = [`# ${baseName} - procedural hull reconstruction`, '# units: metres, +Y up, +X towards the bow', `mtllib ${name}.mtl`];
  const mats = new Map();
  let vOff = 1;
  let tOff = 1;
  let nOff = 1;
  let objects = 0;
  let faces = 0;
  root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const m4 = new THREE.Matrix4();
  const nm = new THREE.Matrix3();
  const v = new THREE.Vector3();
  const useMat = (mat, override) => {
    const std = mat;
    const base = safe(mat.name || mat.type);
    const col = override ?? std.color ?? new THREE.Color(1, 1, 1);
    const key = override ? `${base}_${col.getHexString()}` : base;
    if (!mats.has(key)) {
      const tex = textures[mat.name];
      mats.set(key, {
        color: col.clone(),
        map: std.map && tex ? `${name}_${safe(mat.name)}.png` : undefined,
        opacity: mat.transparent ? mat.opacity : 1,
      });
    }
    return key;
  };
  const writeGeom = (geom, matrix, objName, matName) => {
    const pos = geom.getAttribute('position');
    if (!pos) return;
    const nor = geom.getAttribute('normal');
    const uv = geom.getAttribute('uv');
    objects++;
    lines.push(`o ${objName}_${objects}`, `usemtl ${matName}`);
    nm.getNormalMatrix(matrix);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(matrix);
      lines.push(`v ${fmt(v.x)} ${fmt(v.y)} ${fmt(v.z)}`);
    }
    if (uv) for (let i = 0; i < uv.count; i++) lines.push(`vt ${fmt(uv.getX(i))} ${fmt(uv.getY(i))}`);
    if (nor)
      for (let i = 0; i < nor.count; i++) {
        v.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
        lines.push(`vn ${fmt(v.x)} ${fmt(v.y)} ${fmt(v.z)}`);
      }
    const det = matrix.determinant();
    const face = (a, b, c) => {
      if (det < 0) [b, c] = [c, b];
      const f = (i) => {
        const p = i + vOff;
        if (uv && nor) return `${p}/${i + tOff}/${i + nOff}`;
        if (uv) return `${p}/${i + tOff}`;
        if (nor) return `${p}//${i + nOff}`;
        return `${p}`;
      };
      lines.push(`f ${f(a)} ${f(b)} ${f(c)}`);
      faces++;
    };
    const index = geom.getIndex();
    const groups = geom.groups.length ? geom.groups : [{ start: 0, count: index ? index.count : pos.count }];
    for (const g of groups) {
      for (let k = g.start; k + 2 < g.start + g.count; k += 3) {
        if (index) face(index.getX(k), index.getX(k + 1), index.getX(k + 2));
        else face(k, k + 1, k + 2);
      }
    }
    vOff += pos.count;
    if (uv) tOff += uv.count;
    if (nor) nOff += nor.count;
  };
  root.traverseVisible((o) => {
    if (o.isLine || o.isPoints) return;
    const mesh = o;
    if (!mesh.isMesh) return;
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const rel = new THREE.Matrix4().multiplyMatrices(toRoot, mesh.matrixWorld);
    const inst = mesh;
    if (inst.isInstancedMesh) {
      const c = new THREE.Color();
      for (let k = 0; k < inst.count; k++) {
        inst.getMatrixAt(k, m4);
        if (inst.instanceColor) inst.getColorAt(k, c);
        const matName = useMat(mat, inst.instanceColor ? c : undefined);
        writeGeom(mesh.geometry, new THREE.Matrix4().multiplyMatrices(rel, m4), safe(mesh.name || 'instance'), matName);
      }
      return;
    }
    writeGeom(mesh.geometry, rel, safe(mesh.name || 'mesh'), useMat(mat));
  });
  const mtl = [`# materials for ${baseName}`];
  const rgb = { r: 0, g: 0, b: 0 };
  for (const [key, m] of mats) {
    m.color.getRGB(rgb, THREE.SRGBColorSpace);
    mtl.push(
      '',
      `newmtl ${key}`,
      `Kd ${fmt(rgb.r)} ${fmt(rgb.g)} ${fmt(rgb.b)}`,
      'Ka 0 0 0',
      'Ks 0.2 0.2 0.2',
      'Ns 40',
      `d ${fmt(m.opacity)}`,
      'illum 2',
    );
    if (m.map) mtl.push(`map_Kd ${m.map}`);
  }
  const tex = [];
  for (const [matName, canvas] of Object.entries(textures)) {
    if (canvas) tex.push({ name: `${name}_${safe(matName)}.png`, canvas });
  }
  return { obj: lines.join('\n') + '\n', mtl: mtl.join('\n') + '\n', textures: tex, stats: { objects, vertices: vOff - 1, faces } };
}
export function downloadText(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type });
  downloadBlob(filename, blob);
}
export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
export function downloadCanvas(filename, canvas) {
  canvas.toBlob((b) => b && downloadBlob(filename, b), 'image/png');
}
