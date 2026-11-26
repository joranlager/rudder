// The AI model the ship inspector runs on the device for its vessels from photos: Depth Anything V2
// Small (Apache-2.0, onnx-community/depth-anything-v2-small, about 27 MB quantised, from Hugging Face
// the first time, then from the browser's cache), through Transformers.js (public/vendor). On WebGPU
// where the browser has it, else WebAssembly on the processor (a few seconds a photo).
//
// Its depth map (near = high) cuts the vessel out from the sky or water far behind it, even a white
// ship against a pale sky, gives heights from a photo from above (an open car deck comes out low),
// and how far back the superstructure lies in a side photo (photomodel.js).

export const DEPTH_MODEL = 'onnx-community/depth-anything-v2-small';
export const DEPTH_SIZE_MB = 27;

let depthPipe = null;

/** Load the model once (`onProgress(fraction)` while it downloads). */
export function loadDepth(onProgress = () => {}) {
  depthPipe ??= (async () => {
    const { pipeline, env } = await import('../vendor/transformers.js');
    env.allowLocalModels = false;
    const files = new Map();
    const progress_callback = (p) => {
      if (p.status === 'progress' && p.total) {
        files.set(p.file, [p.loaded, p.total]);
        let a = 0, b = 0;
        for (const [l, t] of files.values()) { a += l; b += t; }
        onProgress(b ? a / b : 0);
      }
    };
    const gpu = typeof navigator !== 'undefined' && navigator.gpu && (await navigator.gpu.requestAdapter().catch(() => null));
    return pipeline('depth-estimation', DEPTH_MODEL, gpu ? { device: 'webgpu', dtype: 'fp16', progress_callback } : { device: 'wasm', dtype: 'q8', progress_callback });
  })().catch((e) => { depthPipe = null; throw e; });
  return depthPipe;
}

/**
 * The depth map of a picture (a canvas), at the canvas's own size: Float32Array, 0 (far) to 1 (near).
 */
export async function depthMap(canvas, onProgress) {
  const pipe = await loadDepth(onProgress);
  const { RawImage } = await import('../vendor/transformers.js');
  const out = await pipe(RawImage.fromCanvas(canvas));
  let img = out.depth; // a one-channel RawImage
  if (img.width !== canvas.width || img.height !== canvas.height) img = await img.resize(canvas.width, canvas.height);
  const n = canvas.width * canvas.height, d = new Float32Array(n), ch = img.channels;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { const v = img.data[i * ch]; if (v < lo) lo = v; if (v > hi) hi = v; }
  for (let i = 0; i < n; i++) d[i] = (img.data[i * ch] - lo) / (hi - lo || 1);
  return d;
}
