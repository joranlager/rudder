// Entry for public/vendor/transformers.js: Transformers.js (Hugging Face) for the AI models the ship
// inspector can use on the device (cut-outs and depth, ships/photoai.js). onnxruntime-web's own
// WebAssembly is fetched by it from jsDelivr when first needed; the models from Hugging Face.
export { pipeline, env, RawImage } from '@huggingface/transformers';
