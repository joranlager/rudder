// Ship inspector: the screen behind "Ships" in the top bar. Search a vessel on Wikidata, see its
// facts and Commons photos, rebuild the hull in 3D, sample its colours from a photo, paint its name
// on the hull, look at it in a studio, at sea or from below the waterline, and export it as OBJ.
// Ships with a model of their own (the vessels folder, or one saved on this device) are shown with
// it; models can be uploaded, fitted, textured with pictures from the web or the device, saved and
// downloaded (Texture and Models tabs).
//
// Loaded on demand by app.js (import('./ships/ui.js')), so the map app does not pay for three.js
// until someone opens it. Everything runs in the browser; Wikidata and Commons are called directly.

import { ShipScene } from './scene.js';
import { buildShip } from './ship.js';
import { searchShips, fetchShipFacts, findByImo } from './wikidata.js';
import { hullFromAis, typeName, navStatusText, draughtM, ageMinutes } from '../ais.js';
import { shipImages } from './commons.js';
import { extractPalette, loadImage, suggestLivery, NOT_A_PHOTO } from './livery.js';
import { DEFAULT_LIVERY, KIND_PRESETS, defaultParams, depthFor, liveryFromFacts, paramsFromFacts } from './presets.js';
import { HULL_FONTS } from './hullText.js';
import { fmtLen } from './callouts.js';
import { exportOBJ, downloadText, downloadCanvas, downloadBlob } from './objExport.js';
import { loadModel, loadEntry, fitModel, disposeObject, nameMaterials, materialsNamed, applyTexture, clearTexture, exportGlb, thumbnail } from './vesselmodel.js';
import { formatOf, UP_AXES, FORWARD_AXES, matchName } from '../vesselcatalog.js';
import { vesselModels, findIn, FOLDER_URL, modelBlob, saveModel, deleteModel } from '../vessellibrary.js';
import { TEXTURE_SOURCES, TEXTURE_SUGGESTIONS, searchTextures, polyhavenImageUrl, pictureUrl, CORS_HINT } from './texturesources.js';
import * as THREE from '../vendor/three.js';
import { VIEWS as PHOTO_VIEWS, sizeFrom } from './photomodel.js';
import { readPicture, cutOut, buildFromPhotos } from './photomesh.js';

const SUGGESTIONS = ['Titanic', 'Queen Mary 2', 'Ever Given', 'Cutty Sark', 'USS Nimitz', 'Statsraad Lehmkuhl', 'Christian Radich', 'Color Magic'];
const MANUAL = { length: 'manual', beam: 'manual', draft: 'manual', airDraft: 'manual' };
const BANNER_KINDS = ['container', 'cruise', 'ferry', 'tanker'];
const TABS = [
  ['ship', 'Ship'],
  ['build', 'Build'],
  ['livery', 'Livery'],
  ['texture', 'Texture'],
  ['sea', 'Sea'],
  ['models', 'Models'],
];
/** Parts of a built ship a picture can go on; a model from a file offers its own materials instead. */
const PARTS = [
  ['hull', 'Hull topsides'],
  ['deck', 'Deck'],
  ['superstructure', 'Superstructure'],
  ['funnel', 'Funnels'],
];
const SOURCE_NAME = { folder: 'Vessels folder', device: 'Saved on this device', upload: 'Uploaded file' };
const slug = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'ship';
const fmtSize = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} kB`);

/** Load a picture so its pixels can be used (CORS), trying each address in turn. */
async function loadPictureFrom(urls) {
  let last = null;
  for (const u of urls.filter(Boolean)) {
    try { return await loadImage(u); } catch (e) { last = e; }
  }
  throw last ?? new Error('No picture');
}

const VIEWS = [
  ['quarter', '3/4'],
  ['profile', 'Side'],
  ['bow', 'Bow'],
  ['stern', 'Stern'],
  ['top', 'Plan'],
  ['keel', 'Keel'],
];
const SLOTS = [
  ['hull', 'Hull topsides'],
  ['bootTop', 'Boot-top / antifouling'],
  ['stripe', 'Sheer stripe'],
  ['superstructure', 'Superstructure'],
  ['funnel', 'Funnel'],
  ['funnelTop', 'Funnel top'],
  ['deck', 'Deck'],
  ['text', 'Lettering'],
];

/** Text from Wikidata and Commons goes into the page as text, never as markup. */
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const thumbFromP18 = (url, width = 120) => `${url.replace(/^http:/, 'https:')}?width=${width}`;
const sourceTag = (src) =>
  src ? `<span class="ships-src ${src}">${{ wikidata: 'Wikidata', ais: 'AIS', estimated: 'est.' }[src] ?? 'manual'}</span>` : '';

let cssLoaded = false;
function loadCss() {
  if (cssLoaded) return;
  cssLoaded = true;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./ships.css', import.meta.url).href;
  document.head.appendChild(link);
}

/**
 * Builds the inspector into `root` (an empty element that covers the map) and returns its controls.
 * `onClose` is called when the inspector's own close button is used.
 */
export function createShipInspector(root, { onClose, onPlace } = {}) {
  loadCss();
  const st = {
    tab: 'ship',
    query: '',
    hits: [],
    searching: false,
    error: null,
    facts: null,
    loadingFacts: false,
    images: [],
    loadingImages: false,
    activeImage: null,
    uploadedUrl: null,
    palette: [],
    extracting: false,
    paletteError: null,
    slot: 'hull',
    shipKey: 'default',
    params: defaultParams('ferry', 140),
    sources: { ...MANUAL },
    livery: { ...DEFAULT_LIVERY.ferry },
    text: {
      name: 'NORDSTJERNEN',
      port: 'BERGEN',
      banner: 'RUDDER LINE',
      imo: '',
      font: HULL_FONTS[0],
      showDraftMarks: true,
      showPlimsoll: true,
      showStripe: true,
      nameScale: 1,
      bannerScale: 1,
    },
    mode: 'studio',
    seaState: 0.35,
    speed: 8,
    sun: 24,
    motion: true,
    callouts: true,
    units: 'metric',
    autoRotate: false,
    sheetOpen: true,
    stats: null,
    topY: 0,
    // a model from a file in view instead of the built one: { source, entry, object, fit, name }
    file: null,
    fileLoading: null,
    fileError: null,
    models: { folder: [], device: [] },
    // pictures on the ship: built ship by part (PARTS), a file's model by material name ('*': all)
    textures: {},
    fileTextures: {},
    texTarget: 'hull',
    texSource: 'commons',
    texQuery: '',
    texHits: [],
    texSearching: false,
    texError: null,
    texBusy: false,
    texOpts: { mode: 'stretch', tile: 8, opacity: 1, blend: 'normal', flip: false, projection: 'box' },
    saveForm: null,
    saving: false,
    // a vessel from photos (photomodel.js): { [view]: { img, name, sil, preview, flip } }
    photos: {},
    photoThreshold: 20,
    photoDims: { length: '', beam: '', height: '', draft: '' },
    photoBusy: false,
    photoError: null,
    notice: null,
  };

  root.classList.add('ships');
  root.innerHTML = `
    <div class="ships-view" data-sheet="open"></div>
    <div class="ships-tools">
      <div class="ships-seg" role="radiogroup" aria-label="Where to look at the ship">
        <button type="button" role="radio" data-mode="studio">Studio</button>
        <button type="button" role="radio" data-mode="ocean">Ocean</button>
        <button type="button" role="radio" data-mode="underwater">Underwater</button>
      </div>
      <div class="ships-seg ships-views" role="group" aria-label="Camera">
        ${VIEWS.map(([v, l]) => `<button type="button" data-view="${v}">${l}</button>`).join('')}
        <button type="button" data-toggle="callouts" aria-pressed="true" title="Dimension lines" aria-label="Dimension lines">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M3 17 17 3l4 4L7 21z"/><path d="m7 13 2 2M10 10l2 2M13 7l2 2"/></svg>
        </button>
        <button type="button" data-toggle="autoRotate" aria-pressed="false" title="Turn slowly" aria-label="Turn slowly">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v4h-4"/></svg>
        </button>
        <button type="button" data-toggle="units" title="Metres or feet" aria-label="Metres or feet">m</button>
      </div>
    </div>
    <section class="ships-sheet" aria-label="Ship inspector">
      <div class="ships-head">
        <button type="button" class="ships-grab" aria-expanded="true" aria-label="Show or hide the inspector panel">
          <span class="ships-title"></span>
          <span class="ships-sub muted small"></span>
        </button>
        <button type="button" class="close ships-close" aria-label="Close ships">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" d="M6 6l12 12M18 6 6 18"/></svg>
        </button>
      </div>
      <div class="ships-seg ships-tabs" role="tablist">
        ${TABS.map(([t, l]) => `<button type="button" role="tab" data-tab="${t}">${l}</button>`).join('')}
      </div>
      <div class="ships-body"></div>
    </section>`;

  const $ = (sel) => root.querySelector(sel);
  const view = $('.ships-view');
  const body = $('.ships-body');
  let scene = null;
  let model = null;
  let lastKey = '';
  let rebuildTimer = 0;
  let abort = null;
  let viewError = null;

  try {
    scene = new ShipScene(view);
    scene.onUnderwaterChange = () => {};
  } catch (e) {
    viewError = e instanceof Error ? e.message : 'WebGL is not available';
    view.innerHTML = `<p class="ships-noview muted">The 3D view is not available here: ${esc(viewError)}</p>`;
  }

  // ---------- model ----------

  const calloutValues = () =>
    model?.imported
      ? {
          loa: model.dims.xMax - model.dims.xMin,
          beam: model.dims.halfBeam * 2,
          draft: Math.max(0, -model.dims.keelY),
          air: model.dims.topY,
          sources: { length: 'model', beam: 'model', draft: 'model', airDraft: 'model' },
        }
      : {
          loa: st.params.length,
          beam: st.params.beam,
          draft: st.params.draft,
          air: model ? model.dims.topY : st.params.airDraft,
          sources: st.sources,
        };

  function rebuild() {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      if (!scene) return;
      const f = st.file;
      if (f) {
        // The same loaded model, fitted again (its axes, size or waterline changed): it moves out of
        // the old wrapper into the new one, and the old wrapper goes without disposing it.
        f.object.removeFromParent();
        try {
          model = fitModel(f.object, f.fit, { shared: true });
        } catch (e) {
          st.fileError = e instanceof Error ? e.message : String(e);
          closeFile();
          return;
        }
      } else model = buildShip(st.params, paintLivery(), st.text);
      dressTextures();
      const key = f ? `file:${f.entry.id}` : st.shipKey;
      const reframe = lastKey !== key;
      lastKey = key;
      scene.setShip(model, reframe);
      st.topY = model.dims.topY;
      scene.setCallouts(calloutValues(), st.units, st.callouts);
      renderHead();
    }, 50);
  }
  /** The livery with the hull picture (Texture tab), for ship.js. */
  const paintLivery = () => {
    const t = st.textures.hull;
    return t ? { ...st.livery, hullImage: { img: t.img, mode: t.mode, tile: t.tile, opacity: t.opacity, blend: t.blend, flip: t.flip } } : st.livery;
  };
  /** Put the chosen pictures on the model in view (and take off those removed). */
  function dressTextures() {
    if (!model) return;
    if (model.imported) {
      const all = materialsNamed(model.group, '*');
      clearTexture(model.group, all);
      for (const [name, t] of Object.entries(st.fileTextures)) {
        applyTexture(model.group, materialsNamed(model.group, name), t.img, { tile: t.tile, projection: t.projection });
      }
      return;
    }
    const parts = PARTS.filter(([k]) => k !== 'hull').map(([k]) => model.materials[k]);
    clearTexture(model.group, parts);
    model.applyLivery(paintLivery(), st.text);
    for (const [k] of PARTS) {
      const t = st.textures[k];
      if (k !== 'hull' && t) applyTexture(model.group, [model.materials[k]], t.img, { tile: t.tile, projection: 'box' });
    }
  }
  const repaint = () => dressTextures();
  const refreshCallouts = () => scene && model && scene.setCallouts(calloutValues(), st.units, st.callouts);

  // ---------- data ----------

  async function runSearch(q) {
    if (!q.trim()) return;
    st.query = q;
    st.searching = true;
    st.error = null;
    renderTab();
    try {
      st.hits = await searchShips(q);
      if (!st.hits.length) st.error = `No ships called “${q}” on Wikidata. Try another spelling, or build one in Build.`;
    } catch (e) {
      st.error = `Wikidata search failed (${e instanceof Error ? e.message : e}). Build still works without it.`;
    }
    st.searching = false;
    renderTab();
  }

  async function sample(src, apply) {
    st.extracting = true;
    st.paletteError = null;
    renderTab();
    try {
      const img = await loadImage(src);
      st.palette = extractPalette(img);
      if (apply) {
        st.livery = suggestLivery(st.palette, st.livery);
        repaint();
      }
    } catch (e) {
      st.palette = [];
      st.paletteError = e instanceof Error ? e.message : 'Could not read the colours of this picture';
    }
    st.extracting = false;
    renderTab();
  }

  /**
   * AIS is the authority for size (length, beam, draught); Wikidata, when the IMO number finds the
   * ship there, adds the type (AIS cannot tell a container ship from a bulk carrier), height and photos.
   */
  function withAis(fromFacts, ais) {
    const a = hullFromAis(ais);
    const generic = fromFacts.params.kind === 'cargo' && a.params.kind !== 'cargo';
    const params = generic ? { ...a.params } : { ...fromFacts.params };
    const sources = { ...fromFacts.sources };
    if (generic && fromFacts.sources.airDraft === 'wikidata') params.airDraft = fromFacts.params.airDraft;
    for (const k of ['length', 'beam', 'draft']) {
      if (a.sources[k] === 'ais') {
        params[k] = a.params[k];
        sources[k] = 'ais';
      }
    }
    params.depth = Math.max(params.depth, depthFor(params.kind, params.beam, params.draft, params.length));
    return { params, sources };
  }

  /** Open a vessel tapped on the chart: build it from its AIS report, then look it up by IMO number. */
  async function showAis(v) {
    abort?.abort();
    const { params, sources } = hullFromAis(v);
    const name = (v.name || '').trim() || `MMSI ${v.mmsi}`;
    dropFile();
    Object.assign(st, {
      textures: {}, texTarget: 'hull', notice: null,
      tab: 'ship', ais: v, facts: null, params, sources, livery: { ...DEFAULT_LIVERY[params.kind] }, shipKey: `ais:${v.mmsi}`,
      hits: [], images: [], palette: [], activeImage: null, uploadedUrl: null, error: null, sheetOpen: true,
    });
    st.text = { ...st.text, name: name.toUpperCase(), port: '', banner: '', imo: v.imoNumber ? String(v.imoNumber) : '' };
    rebuild();
    renderTab();
    lookForModel(v);
    if (!v.imoNumber) return;
    const ac = new AbortController();
    abort = ac;
    try {
      const qid = await findByImo(v.imoNumber, ac.signal);
      if (qid && !ac.signal.aborted && st.ais === v) await loadShip(qid, undefined, v);
    } catch {
      /* Wikidata is a bonus here: the AIS model stands on its own */
    }
  }

  async function loadShip(qid, label, ais = null) {
    abort?.abort();
    const ac = new AbortController();
    abort = ac;
    if (!ais) {
      st.ais = null;
      dropFile();
      Object.assign(st, { textures: {}, texTarget: 'hull', notice: null });
    }
    Object.assign(st, { loadingFacts: true, error: null, images: [], palette: [], activeImage: null, uploadedUrl: null });
    renderTab();
    try {
      const f = await fetchShipFacts(qid, 'en', ac.signal);
      if (ac.signal.aborted) return;
      const { params, sources } = ais ? withAis(paramsFromFacts(f), ais) : paramsFromFacts(f);
      const name = f.label.replace(/^(RMS|MS|MV|SS|HMS|USS|KNM|M\/S|M\/V|S\/S|HMY|SY|MY)\s+/i, '');
      Object.assign(st, { facts: f, params, sources, livery: liveryFromFacts(params.kind, f), shipKey: ais ? st.shipKey : qid, loadingFacts: false });
      st.text = {
        ...st.text,
        name: name.toUpperCase(),
        port: (f.homePorts[0] ?? f.flags[0] ?? '').toUpperCase(),
        banner: BANNER_KINDS.includes(params.kind) ? (f.operators[0] ?? f.owners[0] ?? '').toUpperCase() : '',
        imo: f.imo ?? (ais?.imoNumber ? String(ais.imoNumber) : ''),
      };
      rebuild();
      if (!ais) lookForModel({ mmsi: f.mmsi, imo: f.imo, callSign: f.callSign, label: f.label });
      st.loadingImages = true;
      renderTab();
      try {
        st.images = await shipImages({ label: label ?? f.label, p18: f.image, category: f.commonsCategory }, ac.signal);
      } catch {
        st.images = []; // photos are a bonus
      }
      if (ac.signal.aborted) return;
      st.loadingImages = false;
      // Sample the first real photograph: a Wikidata image is sometimes an insignia or a plan.
      const photo = st.images.find((i) => !NOT_A_PHOTO.test(i.title)) ?? st.images[0];
      renderTab();
      if (photo) {
        st.activeImage = photo;
        sample(photo.thumb, true);
      }
    } catch (e) {
      if (ac.signal.aborted) return;
      st.loadingFacts = false;
      st.error = `Could not load ${qid} (${e instanceof Error ? e.message : e}).`;
      renderTab();
    }
  }

  // ---------- models from files: the vessels folder, this device, uploads ----------

  async function refreshModels() {
    st.models = await vesselModels();
    if (st.tab === 'models') renderTab();
    return st.models;
  }

  /** How a model is fitted at first: as its entry says, to the ship's length and draught where known. */
  function fitFor(entry) {
    const known = st.ais && st.sources.length === 'ais';
    return {
      up: entry.up ?? '+y',
      forward: entry.forward ?? '+x',
      scale: entry.scale ?? 'length',
      length: known ? st.params.length : entry.length ?? st.params.length,
      draft: st.sources.draft === 'ais' ? st.params.draft : entry.draft ?? st.params.draft,
      waterline: entry.waterline ?? 'keel',
    };
  }

  /** Forget the model from a file (a new ship was chosen); it leaves the scene with the next rebuild. */
  function dropFile() {
    st.fileLoading = null;
    if (!st.file) return;
    const old = st.file.object;
    st.file = null;
    st.fileTextures = {};
    setTimeout(() => disposeObject(old), 200);
  }

  function showFile(file) {
    if (st.file && st.file.object !== file.object) {
      const old = st.file.object;
      setTimeout(() => disposeObject(old), 200);
    }
    st.file = file;
    st.fileTextures = {};
    st.texTarget = '*';
    st.fileError = null;
    rebuild();
    renderTab();
  }

  /** Show a model from the vessels folder or this device (a catalog entry). */
  async function openFile(entry, why = null) {
    const token = {};
    st.fileLoading = token;
    st.fileError = null;
    renderTab();
    try {
      const object = await loadEntry(entry, { folderUrl: FOLDER_URL, blobOf: modelBlob });
      if (st.fileLoading !== token) { disposeObject(object); return; }
      nameMaterials(object);
      st.notice = why;
      showFile({ source: entry.source, entry, object, fit: fitFor(entry), name: entry.name });
    } catch (e) {
      if (st.fileLoading === token) st.fileError = `Could not load ${entry.name}: ${e instanceof Error ? e.message : e}`;
    }
    if (st.fileLoading === token) st.fileLoading = null;
    renderTab();
  }

  /** The axis a model is longest along, across the up axis: most likely its length. */
  function guessForward(object, up) {
    // measured in the model's own axes: out of the fitting wrapper for a moment
    const parent = object.parent;
    parent?.remove(object);
    object.updateMatrixWorld(true);
    const size = new THREE.Box3().setFromObject(object, true).getSize(new THREE.Vector3());
    parent?.add(object);
    const axes = ['x', 'y', 'z'].filter((a) => a !== up[1]);
    return `+${size[axes[0]] >= size[axes[1]] ? axes[0] : axes[1]}`;
  }

  async function openUpload(files) {
    const main = [...files].find((f) => formatOf(f.name));
    if (!main) {
      st.fileError = 'Choose a .glb, .gltf, .obj or .stl file (with its .mtl, .bin and pictures, if it has them).';
      renderTab();
      return;
    }
    const token = {};
    st.fileLoading = token;
    st.fileError = null;
    renderTab();
    try {
      const object = await loadModel({ files });
      if (st.fileLoading !== token) { disposeObject(object); return; }
      nameMaterials(object);
      const format = formatOf(main.name);
      // glTF is y-up by its rules; STL comes from CAD and 3D printing, which are mostly z-up.
      const up = format === 'stl' ? '+z' : '+y';
      const name = main.name.replace(/\.[^.]+$/, '');
      const entry = { id: `upload:${main.name}:${main.size}`, name, format, source: 'upload' };
      st.notice = null;
      showFile({
        source: 'upload', entry, object, name,
        fit: { up, forward: guessForward(object, up), scale: 'length', length: st.params.length, draft: st.params.draft, waterline: 'keel' },
      });
    } catch (e) {
      if (st.fileLoading === token) st.fileError = `Could not read ${main.name}: ${e instanceof Error ? e.message : e}`;
    }
    if (st.fileLoading === token) st.fileLoading = null;
    renderTab();
  }

  /** Back to the ship built from its type and size. */
  function closeFile() {
    if (!st.file) return;
    const f = st.file;
    st.file = null;
    st.fileTextures = {};
    st.texTarget = 'hull';
    st.notice = null;
    rebuild();
    // the old model leaves the scene in rebuild; free it after that
    setTimeout(() => disposeObject(f.object), 200);
    renderTab();
  }

  /** A ship just chosen: if the vessels folder or this device has its model, show that. */
  async function lookForModel(ship) {
    const models = await refreshModels();
    const e = findIn(models, ship);
    if (!e) return;
    await openFile(e, `${e.name} has a model of its own (${SOURCE_NAME[e.source].toLowerCase()}), shown instead of the one built from its type.`);
  }

  /** What the save form starts with: the ship in view's name and numbers. */
  function saveDefaults() {
    const f = st.file?.source === 'device' ? st.file.entry : null;
    const v = st.ais;
    return {
      name: f?.name ?? st.facts?.label ?? ((v?.name || '').trim() || st.file?.name || st.text.name || 'Ship'),
      mmsi: f?.mmsi?.join(' ') ?? (v?.mmsi ? String(v.mmsi) : st.facts?.mmsi ?? ''),
      imo: f?.imo ?? (v?.imoNumber ? String(v.imoNumber) : st.facts?.imo ?? st.text.imo ?? ''),
      callSign: f?.callSign ?? v?.callSign ?? st.facts?.callSign ?? '',
    };
  }

  /** Who made the pictures on the model, for the saved model and the vessels folder's sidecar. */
  function credits() {
    const all = [...Object.values(st.textures), ...Object.values(st.fileTextures)].filter((t) => t.credit);
    return [...new Set(all.map((t) => t.credit))].join('; ');
  }

  async function saveToDevice(form) {
    if (!model || st.saving) return;
    st.saving = true;
    renderTab();
    try {
      const blob = await exportGlb(model.group);
      const d = model.dims;
      const rec = {
        id: st.file?.source === 'device' ? st.file.entry.id : undefined,
        name: form.name.trim() || 'Ship',
        mmsi: form.mmsi.split(/[\s,;]+/).filter(Boolean),
        imo: form.imo,
        callSign: form.callSign,
        length: +(d.xMax - d.xMin).toFixed(2),
        beam: +(d.halfBeam * 2).toFixed(2),
        draft: +Math.max(0, -d.keelY).toFixed(2),
        credit: credits(),
        blob,
        thumb: scene ? thumbnail(scene.renderer.domElement) : '',
      };
      await saveModel(rec);
      st.saveForm = null;
      st.notice = `Saved “${rec.name}” on this device (${fmtSize(blob.size)}). ${rec.mmsi.length || rec.imo || rec.callSign ? 'The chart draws it for that ship from now on.' : 'Give it an MMSI or IMO number for the chart to use it.'}`;
      await refreshModels();
    } catch (e) {
      st.notice = null;
      st.fileError = `Could not save the model: ${e instanceof Error ? e.message : e}`;
    }
    st.saving = false;
    renderTab();
  }

  const baseFileName = () => slug(st.file?.name ?? st.facts?.label ?? ((st.ais?.name || '').trim() || st.text.name));

  async function downloadGlb(forFolder) {
    if (!model) return;
    const blob = await exportGlb(model.group);
    const name = baseFileName();
    downloadBlob(`${name}.glb`, blob);
    if (!forFolder) return;
    const k = saveDefaults();
    const d = model.dims;
    const sidecar = {
      name: k.name,
      ...(k.mmsi ? { mmsi: k.mmsi.split(/[\s,;]+/).filter(Boolean) } : {}),
      ...(k.imo ? { imo: k.imo } : {}),
      ...(k.callSign ? { callSign: k.callSign } : {}),
      file: `${name}.glb`,
      up: '+y',
      forward: '+x',
      waterline: 'origin',
      scale: 'length',
      length: +(d.xMax - d.xMin).toFixed(2),
      beam: +(d.halfBeam * 2).toFixed(2),
      draft: +Math.max(0, -d.keelY).toFixed(2),
      ...(credits() ? { credit: credits() } : {}),
    };
    setTimeout(() => downloadText(`${name}.json`, JSON.stringify(sidecar, null, 2) + '\n', 'application/json'), 400);
  }

  // ---------- pictures on the ship ----------

  async function runTexSearch(q) {
    st.texQuery = q;
    if (!q.trim()) return;
    st.texSearching = true;
    st.texError = null;
    renderTab();
    try {
      st.texHits = await searchTextures(st.texSource, q);
      if (!st.texHits.length) st.texError = `Nothing for “${q}” on ${TEXTURE_SOURCES.find(([k]) => k === st.texSource)?.[1]}.`;
    } catch (e) {
      st.texHits = [];
      st.texError = `The search failed (${e instanceof Error ? e.message : e}).`;
    }
    st.texSearching = false;
    renderTab();
  }

  /** Put a picture on the chosen part: `pic` { urls: [..], title, credit, page }. */
  async function usePicture(pic) {
    st.texBusy = true;
    st.texError = null;
    renderTab();
    try {
      const img = await loadPictureFrom(pic.urls);
      const o = st.texOpts;
      const t = { img, src: img.src, title: pic.title, credit: pic.credit, page: pic.page, tile: o.tile, mode: o.mode, opacity: o.opacity, blend: o.blend, flip: o.flip, projection: o.projection };
      if (model?.imported) st.fileTextures = { ...st.fileTextures, [st.texTarget]: t };
      else st.textures = { ...st.textures, [st.texTarget]: t };
      dressTextures();
    } catch {
      st.texError = pic.local ? 'This file is not a picture the browser can read.' : CORS_HINT;
    }
    st.texBusy = false;
    renderTab();
  }

  const creditOf = (h) => [h.title, h.author && `by ${h.author}`, h.license, h.source].filter(Boolean).join(' · ');

  async function useHit(h) {
    if (h.source === 'Poly Haven' && !h.full) {
      st.texBusy = true;
      renderTab();
      try {
        h.full = await polyhavenImageUrl(h.id);
      } catch (e) {
        st.texBusy = false;
        st.texError = `Poly Haven: ${e instanceof Error ? e.message : e}`;
        renderTab();
        return;
      }
    }
    usePicture({ urls: [h.full, ...(h.alt ?? []), h.thumb], title: h.title, credit: creditOf(h), page: h.page });
  }

  /** Change how the current target's picture lies (tile size, opacity...), without loading it again. */
  function retexture(k, v) {
    st.texOpts = { ...st.texOpts, [k]: v };
    const set = model?.imported ? st.fileTextures : st.textures;
    const t = set[st.texTarget];
    if (t) {
      set[st.texTarget] = { ...t, [k]: v };
      dressTextures();
    }
  }

  // ---------- rendering ----------

  function renderHead() {
    $('.ships-title').textContent = st.facts?.label ?? ((st.ais?.name || '').trim() || (st.ais ? `MMSI ${st.ais.mmsi}` : 'Custom vessel'));
    const p = st.params;
    if (st.file && model?.imported) {
      const d = model.dims;
      $('.ships-sub').textContent =
        `${SOURCE_NAME[st.file.source]}: ${st.file.name} · ${fmtLen(d.xMax - d.xMin, st.units)} × ${fmtLen(d.halfBeam * 2, st.units)} · air ${fmtLen(d.topY, st.units)}`;
    } else {
      $('.ships-sub').textContent =
        `${KIND_PRESETS[p.kind].label} · ${fmtLen(p.length, st.units)} × ${fmtLen(p.beam, st.units)} · draft ${fmtLen(p.draft, st.units)}` +
        (st.topY ? ` · air ${fmtLen(st.topY, st.units)}` : '');
    }
    root.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === st.mode)));
    root.querySelectorAll('.ships-tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === st.tab)));
    $('[data-toggle="callouts"]').setAttribute('aria-pressed', String(st.callouts));
    $('[data-toggle="autoRotate"]').setAttribute('aria-pressed', String(st.autoRotate));
    $('[data-toggle="units"]').textContent = st.units === 'metric' ? 'm' : 'ft';
    $('.ships-grab').setAttribute('aria-expanded', String(st.sheetOpen));
    root.dataset.sheet = st.sheetOpen ? 'open' : 'closed';
  }

  const row = (label, key, value, min, max, step, shown, src = '') => `
    <label class="ships-range">
      <span class="ships-range-top"><span>${label}${src}</span><b data-out="${key}">${shown}</b></span>
      <input type="range" data-param="${key}" min="${min}" max="${max}" step="${step}" value="${value}" aria-label="${label}">
    </label>`;

  function renderShipTab() {
    const f = st.facts;
    const facts = f
      ? [
          ['Type', f.types.join(', ')],
          ['Class', f.shipClass.join(', ')],
          ['Length', f.length && fmtLen(f.length, st.units)],
          ['Beam', f.beam && fmtLen(f.beam, st.units)],
          ['Draft', f.draft && fmtLen(f.draft, st.units)],
          ['Height', f.height && fmtLen(f.height, st.units)],
          ['Gross tonnage', f.grossTonnage && f.grossTonnage.toLocaleString()],
          ['Speed', f.speedKnots && `${f.speedKnots.toFixed(1)} kn`],
          ['Capacity', f.capacity && f.capacity.toLocaleString()],
          ['Builder', f.builders.join(', ')],
          ['Operator', f.operators.join(', ')],
          ['Owner', f.owners.join(', ')],
          ['Flag', f.flags.join(', ')],
          ['Home port', f.homePorts.join(', ')],
          ['IMO', f.imo],
          ['MMSI', f.mmsi],
          ['Call sign', f.callSign],
          ['Built', f.inception],
          ['In service', [f.serviceEntry, f.serviceRetirement].filter(Boolean).join(' – ')],
        ].filter(([, v]) => v)
      : [];
    const v = st.ais;
    const aisRows = v
      ? [
          ['MMSI', v.mmsi],
          ['IMO', v.imoNumber],
          ['Call sign', v.callSign],
          ['Type', typeName(v.shipType)],
          ['Status', navStatusText(v.navigationalStatus)],
          ['Speed', v.speedOverGround != null ? `${v.speedOverGround.toFixed(1)} kn` : null],
          ['Course', v.courseOverGround != null && v.courseOverGround < 360 ? `${Math.round(v.courseOverGround)}°` : null],
          ['Heading', v.trueHeading != null && v.trueHeading < 360 ? `${v.trueHeading}°` : null],
          ['Size', `${fmtLen(st.params.length, st.units)} × ${fmtLen(st.params.beam, st.units)}`],
          ['Draught', draughtM(v) ? fmtLen(draughtM(v), st.units) : null],
          ['Destination', v.destination?.trim()],
          ['Last report', `${Math.max(0, Math.round(ageMinutes(v)))} min ago`],
        ].filter(([, x]) => x != null && x !== '')
      : [];
    return `
      ${onPlace ? `<div class="group pad ships-place"><div class="row"><button type="button" class="primary" data-act="place">Place on the map</button></div>
        <p class="muted small">Put this ship on the chart, on open water, and take the helm. It looks as it does here.</p></div>` : ''}
      ${st.file && st.notice ? `<p class="notice">${esc(st.notice)} <button type="button" class="ghost" data-act="close-file">Show the built model</button></p>` : ''}
      ${st.fileLoading ? '<p class="muted small">Loading its model…</p>' : ''}
      ${
        v
          ? `<h3 class="label">From AIS</h3>
             <div class="group pad">
               <dl class="ships-facts">${aisRows.map(([k, x]) => `<dt>${k}</dt><dd>${esc(x)}</dd>`).join('')}</dl>
               <p class="muted small">Length, beam and draught come from the ship's own AIS report; the rest of the model is estimated from its type${
                 v.imoNumber ? ', and from Wikidata when its IMO number is found there' : ''
               }.</p>
             </div>`
          : ''
      }
      <form class="row ships-search">
        <input name="q" value="${esc(st.query)}" placeholder="Search Wikidata for a ship" aria-label="Ship name" autocomplete="off" enterkeyhint="search">
        <button type="submit" class="primary" ${st.searching ? 'disabled' : ''}>${st.searching ? 'Searching…' : 'Search'}</button>
      </form>
      <div class="chips ships-chips">${SUGGESTIONS.map((s) => `<button type="button" class="chip" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}</div>
      ${st.error ? `<p class="error">${esc(st.error)}</p>` : ''}
      ${
        st.hits.length
          ? `<ul class="group ships-hits">${st.hits
              .map(
                (h) => `<li><button type="button" data-qid="${esc(h.qid)}" aria-pressed="${st.facts?.qid === h.qid}">
                  <span class="ships-thumb">${h.image ? `<img src="${esc(thumbFromP18(h.image))}" alt="" loading="lazy">` : ''}</span>
                  <span class="ships-hit"><b>${esc(h.label)}</b><small class="muted">${esc(
                    [h.type, h.length ? fmtLen(h.length, st.units) : null, h.description].filter(Boolean).join(' · '),
                  )}</small></span>
                </button></li>`,
              )
              .join('')}</ul>`
          : ''
      }
      ${st.loadingFacts ? '<p class="muted small">Asking Wikidata…</p>' : ''}
      ${
        f && !st.loadingFacts
          ? `<h3 class="label">${esc(f.label)} <code class="ships-qid">${esc(f.qid)}</code></h3>
             <div class="group pad">
               ${f.description ? `<p class="muted small">${esc(f.description)}</p>` : ''}
               <dl class="ships-facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
               <p class="small ships-links">
                 <a href="https://www.wikidata.org/wiki/${esc(f.qid)}" target="_blank" rel="noopener">Wikidata</a>
                 ${f.wikipedia ? `<a href="${esc(f.wikipedia)}" target="_blank" rel="noopener">Wikipedia</a>` : ''}
                 ${f.commonsCategory ? `<a href="https://commons.wikimedia.org/wiki/Category:${encodeURIComponent(f.commonsCategory)}" target="_blank" rel="noopener">Commons</a>` : ''}
               </p>
             </div>`
          : ''
      }
      ${
        st.images.length || st.loadingImages
          ? `<h3 class="label">Photos on Wikimedia Commons${st.loadingImages ? ' …' : ''}</h3>
             <p class="muted small pad-note">Tap a photo to take the ship's colours from it.</p>
             <div class="ships-gallery">${st.images
               .slice(0, 18)
               .map(
                 (img, i) =>
                   `<button type="button" data-img="${i}" title="${esc(img.title)}" aria-pressed="${st.activeImage?.title === img.title}"><img src="${esc(img.thumb)}" alt="${esc(img.title)}" loading="lazy"></button>`,
               )
               .join('')}</div>`
          : ''
      }`;
  }

  const fileNotice = (what) =>
    st.file
      ? `<p class="notice">In view: ${esc(st.file.name)} (${esc(SOURCE_NAME[st.file.source].toLowerCase())}). ${what}
           <button type="button" class="ghost" data-act="close-file">Show the built model</button></p>`
      : '';

  function renderBuildTab() {
    const p = st.params;
    const L = (v) => fmtLen(v, st.units);
    const opt = (list, cur) => list.map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`).join('');
    return `
      ${fileNotice('Its size and how it lies are set under Models; these settings build the ship from its type.')}
      <div class="group pad ships-selects">
        <label>Vessel type<select data-select="kind">${opt(Object.entries(KIND_PRESETS).map(([k, v]) => [k, v.label]), p.kind)}</select></label>
        <label>Bow<select data-select="bow">${opt([['bulbous', 'Bulbous'], ['raked', 'Raked'], ['vertical', 'Plumb'], ['clipper', 'Clipper']], p.bow)}</select></label>
        <label>Stern<select data-select="stern">${opt([['transom', 'Transom'], ['cruiser', 'Cruiser']], p.stern)}</select></label>
      </div>
      <h3 class="label">Main dimensions</h3>
      <div class="group pad">
        ${row('Length overall', 'length', p.length, 8, 460, 0.5, L(p.length), sourceTag(st.sources.length))}
        ${row('Beam', 'beam', p.beam, 2, 80, 0.1, L(p.beam), sourceTag(st.sources.beam))}
        ${row('Draft', 'draft', p.draft, 0.5, 30, 0.1, L(p.draft), sourceTag(st.sources.draft))}
        ${row('Depth, keel to deck', 'depth', p.depth, 1, 60, 0.1, L(p.depth))}
        ${row('Air draft', 'airDraft', p.airDraft, 3, 120, 0.5, L(p.airDraft), sourceTag(st.sources.airDraft))}
      </div>
      <h3 class="label">Hull shape</h3>
      <div class="group pad">
        ${row('Fullness (block coefficient)', 'blockCoefficient', p.blockCoefficient, 0.38, 0.88, 0.01, p.blockCoefficient.toFixed(2))}
        ${row('Sheer', 'sheer', p.sheer, 0, 0.5, 0.01, `${Math.round(p.sheer * 100)} %`)}
        ${row('Bow flare', 'flare', p.flare, 0, 1, 0.01, `${Math.round(p.flare * 100)} %`)}
        <p class="muted small" data-out="ratios">${ratios()}</p>
      </div>
      <h3 class="label">On deck</h3>
      <div class="group pad">
        ${row('Deck levels', 'decks', p.decks, 1, 18, 1, p.decks)}
        ${row('Funnels', 'funnels', p.funnels, 0, 4, 1, p.funnels)}
        ${row('Masts', 'masts', p.masts, 0, 5, 1, p.masts)}
        <div class="row">
          <button type="button" class="tinted" data-act="reshuffle">Reshuffle details</button>
          <button type="button" class="ghost" data-act="reset-proportions">Reset proportions</button>
        </div>
      </div>
      <p class="muted small pad-note">Missing Wikidata values are estimated from typical ships of the same type (marked est.).</p>`;
  }
  function ratios() {
    const p = st.params;
    const disp = Math.round(p.length * 0.97 * p.beam * p.draft * p.blockCoefficient * 1.025);
    return `L/B ${(p.length / p.beam).toFixed(2)} · B/T ${(p.beam / p.draft).toFixed(2)} · about ${disp.toLocaleString()} t displacement`;
  }

  function renderLiveryTab() {
    const t = st.text;
    const src = st.uploadedUrl ?? st.activeImage?.thumb;
    const slotLabel = SLOTS.find(([k]) => k === st.slot)?.[1];
    const sw = (k, label) =>
      `<label class="switch-row"><span>${label}</span><input type="checkbox" role="switch" data-text="${k}" ${t[k] ? 'checked' : ''}></label>`;
    return `
      ${fileNotice('A model from a file keeps its own colours: put pictures on it under Texture. The livery here is for the built model.')}
      <h3 class="label">Colours from a photo</h3>
      <div class="group pad">
        ${
          src
            ? `<figure class="ships-photo"><img src="${esc(src)}" alt="The photo the colours come from">${
                st.activeImage && !st.uploadedUrl
                  ? `<figcaption class="muted small"><a href="${esc(st.activeImage.page)}" target="_blank" rel="noopener">${esc(st.activeImage.title)}</a>${
                      st.activeImage.author ? ` · ${esc(st.activeImage.author)}` : ''
                    }${st.activeImage.license ? ` · ${esc(st.activeImage.license)}` : ''}</figcaption>`
                  : ''
              }</figure>`
            : '<p class="muted small">Choose a Commons photo under Ship, or use one of your own.</p>'
        }
        <div class="row">
          <button type="button" class="tinted" data-act="upload">Use my photo</button>
          <button type="button" class="tinted" data-act="auto" ${st.palette.length ? '' : 'disabled'}>Match again</button>
          <button type="button" class="ghost" data-act="default-livery">Type default</button>
        </div>
        <input type="file" accept="image/*" hidden data-file>
        ${st.extracting ? '<p class="muted small">Reading the colours…</p>' : ''}
        ${st.paletteError ? `<p class="error">${esc(st.paletteError)}</p>` : ''}
        ${
          st.palette.length
            ? `<p class="muted small">Tap a colour to use it for <b>${slotLabel}</b>.</p>
               <div class="ships-palette">${st.palette
                 .map(
                   (s) =>
                     `<button type="button" data-swatch="${s.hex}" title="${s.hex} · ${(s.share * 100).toFixed(0)} %${s.role ? ` · ${s.role}` : ''}" style="background:${s.hex};width:${Math.max(30, Math.min(80, s.share * 300))}px" class="${s.role ? 'faded' : ''}">${s.role ? `<span>${s.role}</span>` : ''}</button>`,
                 )
                 .join('')}</div>`
            : ''
        }
      </div>
      <h3 class="label">Paint</h3>
      <ul class="group ships-slots">${SLOTS.map(
        ([k, label]) => `<li aria-selected="${st.slot === k}"><button type="button" data-slot="${k}">${label}</button>
          <input type="color" value="${st.livery[k]}" data-color="${k}" aria-label="${label}"></li>`,
      ).join('')}</ul>
      <h3 class="label">Lettering on the hull</h3>
      <div class="group pad ships-text">
        <label>Ship's name<input data-text="name" value="${esc(t.name)}" maxlength="40" autocomplete="off"></label>
        <label>Port of registry<input data-text="port" value="${esc(t.port)}" maxlength="40" autocomplete="off"></label>
        <label>Name along the side<input data-text="banner" value="${esc(t.banner)}" maxlength="40" placeholder="Company name" autocomplete="off"></label>
        <label>IMO number<input data-text="imo" value="${esc(t.imo)}" inputmode="numeric" maxlength="7" autocomplete="off"></label>
        <label>Typeface<select data-text="font">${HULL_FONTS.map(
          (f) => `<option value="${esc(f)}" ${f === t.font ? 'selected' : ''}>${esc(f.split(',')[0].replace(/"/g, ''))}</option>`,
        ).join('')}</select></label>
        <label class="ships-range"><span class="ships-range-top"><span>Name size</span><b data-out="nameScale">${t.nameScale.toFixed(2)}×</b></span>
          <input type="range" data-text="nameScale" min="0.4" max="2.5" step="0.05" value="${t.nameScale}"></label>
        <label class="ships-range"><span class="ships-range-top"><span>Side name size</span><b data-out="bannerScale">${t.bannerScale.toFixed(2)}×</b></span>
          <input type="range" data-text="bannerScale" min="0.3" max="1.8" step="0.05" value="${t.bannerScale}"></label>
      </div>
      <div class="group">
        ${sw('showStripe', 'Sheer stripe')}
        ${sw('showDraftMarks', 'Draft marks')}
        ${sw('showPlimsoll', 'Load line (Plimsoll) mark')}
      </div>`;
  }

  function renderSeaTab() {
    return `
      ${st.mode === 'studio' ? '<p class="notice">These apply at sea. Choose Ocean or Underwater above.</p>' : ''}
      <div class="group pad">
        <label class="ships-range"><span class="ships-range-top"><span>Sea state</span><b data-out="seaState">${Math.round(st.seaState * 9)} of 9</b></span>
          <input type="range" data-sea="seaState" min="0" max="1" step="0.01" value="${st.seaState}"></label>
        <label class="ships-range"><span class="ships-range-top"><span>Speed</span><b data-out="speed">${st.speed.toFixed(0)} kn</b></span>
          <input type="range" data-sea="speed" min="0" max="30" step="0.5" value="${st.speed}"></label>
        <label class="ships-range"><span class="ships-range-top"><span>Sun height</span><b data-out="sun">${st.sun.toFixed(0)}°</b></span>
          <input type="range" data-sea="sun" min="1" max="75" step="1" value="${st.sun}"></label>
      </div>
      <div class="group">
        <label class="switch-row"><span><strong>Ship moves with the waves</strong><small class="muted">Heave, pitch and roll from the waves under the hull.</small></span>
          <input type="checkbox" role="switch" data-sea="motion" ${st.motion ? 'checked' : ''}></label>
      </div>
      <p class="muted small pad-note">Under water, tap Keel to look at the hull from below. Drag to look around; pinch or scroll to zoom.</p>`;
  }

  function renderTextureTab() {
    const imported = Boolean(model?.imported && st.file);
    const targets = imported ? [['*', 'Whole model'], ...nameMaterials(model.group).map((n) => [n, n])] : PARTS;
    if (!targets.some(([k]) => k === st.texTarget)) st.texTarget = targets[0][0];
    const set = imported ? st.fileTextures : st.textures;
    const cur = set[st.texTarget];
    const o = cur ?? st.texOpts;
    const hullPart = !imported && st.texTarget === 'hull';
    const opt = (list, v) => list.map(([k, l]) => `<option value="${esc(k)}" ${k === v ? 'selected' : ''}>${esc(l)}</option>`).join('');
    const sources = [...TEXTURE_SOURCES, ...(st.images.length ? [['ship', "This ship's photos"]] : []), ['url', 'Web address'], ['file', 'My picture']];
    const hits = st.texSource === 'ship' ? st.images.map((i) => ({ ...i, alt: [], source: 'Wikimedia Commons' })) : st.texHits;
    const applied = Object.entries(set);
    return `
      <p class="muted small pad-note">Put a picture on the ship: a photo along the hull, or a texture such as painted steel, rust or teak, repeated over a part. ${imported ? 'This model is from a file: choose one of its materials, or all of it.' : 'Pictures on the built model are kept when it is changed in Build.'}</p>
      <div class="group pad ships-selects">
        <label>Put it on<select data-tex="target">${opt(targets.map(([k, l]) => [k, l + (set[k] ? ' ✓' : '')]), st.texTarget)}</select></label>
        ${
          hullPart
            ? `<label>How<select data-tex="mode">${opt([['stretch', 'One picture along the whole side'], ['tile', 'Repeated, like paint or plating']], o.mode)}</select></label>`
            : imported
              ? `<label>How<select data-tex="projection">${opt([['box', 'Repeated, in metres'], ['uv', "On the model's own texture coordinates"]], o.projection)}</select></label>`
              : ''
        }
        ${
          (hullPart && o.mode === 'tile') || (!hullPart && o.projection !== 'uv')
            ? `<label class="ships-range"><span class="ships-range-top"><span>One repeat is</span><b data-out="tile">${fmtLen(o.tile, st.units)}</b></span>
                 <input type="range" data-tex="tile" min="0.5" max="60" step="0.5" value="${o.tile}"></label>`
            : ''
        }
        ${
          hullPart
            ? `<label class="ships-range"><span class="ships-range-top"><span>Strength</span><b data-out="opacity">${Math.round(o.opacity * 100)} %</b></span>
                 <input type="range" data-tex="opacity" min="0.05" max="1" step="0.05" value="${o.opacity}"></label>
               <label>Blend<select data-tex="blend">${opt([['normal', 'Over the paint'], ['multiply', 'Into the paint (keeps its colour)']], o.blend)}</select></label>
               <label class="switch-row" style="padding:4px 0"><span>The picture's bow is on its left</span><input type="checkbox" role="switch" data-tex="flip" ${o.flip ? 'checked' : ''}></label>`
            : ''
        }
      </div>
      ${
        cur
          ? `<div class="group pad ships-applied">
               <figure class="ships-photo"><img src="${esc(cur.src)}" alt=""><figcaption class="muted small">${cur.page ? `<a href="${esc(cur.page)}" target="_blank" rel="noopener">${esc(cur.credit || cur.title)}</a>` : esc(cur.credit || cur.title || 'Your picture')}</figcaption></figure>
               <div class="row"><button type="button" class="ghost" data-act="tex-remove">Take it off</button></div>
             </div>`
          : ''
      }
      <h3 class="label">Pictures from</h3>
      <div class="chips ships-chips" role="radiogroup">${sources
        .map(([k, l]) => `<button type="button" class="chip" role="radio" data-texsrc="${k}" aria-checked="${st.texSource === k}">${esc(l)}</button>`)
        .join('')}</div>
      ${
        st.texSource === 'url'
          ? `<form class="row ships-texurl"><input name="u" placeholder="https://… a picture's address" aria-label="Picture address" autocomplete="off" inputmode="url">
               <button type="submit" class="primary" ${st.texBusy ? 'disabled' : ''}>Use</button></form>
             <p class="muted small pad-note">Works when the picture's site lets other web pages use it (most image services and Wikimedia do). If not, save it and use My picture.</p>`
          : st.texSource === 'file'
            ? `<div class="row"><button type="button" class="primary" data-act="tex-upload" ${st.texBusy ? 'disabled' : ''}>Choose a picture…</button></div>
               <p class="muted small pad-note">The picture stays on this device.</p>`
            : st.texSource === 'ship'
              ? ''
              : `<form class="row ships-texsearch">
                   <input name="tq" value="${esc(st.texQuery)}" placeholder="Search ${esc(TEXTURE_SOURCES.find(([k]) => k === st.texSource)?.[1] ?? '')}" aria-label="Search pictures" autocomplete="off" enterkeyhint="search">
                   <button type="submit" class="primary" ${st.texSearching ? 'disabled' : ''}>${st.texSearching ? 'Searching…' : 'Search'}</button>
                 </form>
                 <div class="chips ships-chips">${TEXTURE_SUGGESTIONS.map((x) => `<button type="button" class="chip" data-texsuggest="${esc(x)}">${esc(x)}</button>`).join('')}</div>`
      }
      <input type="file" accept="image/*" hidden data-texfile>
      ${st.texBusy ? '<p class="muted small">Loading the picture…</p>' : ''}
      ${st.texError ? `<p class="error">${esc(st.texError)}</p>` : ''}
      ${
        ['url', 'file'].includes(st.texSource) || !hits.length
          ? ''
          : `<div class="ships-gallery">${hits
              .slice(0, 30)
              .map(
                (h, i) =>
                  `<button type="button" data-texhit="${i}" title="${esc(creditOf(h))}"><img src="${esc(h.thumb)}" alt="${esc(h.title)}" loading="lazy"></button>`,
              )
              .join('')}</div>`
      }
      ${
        applied.length
          ? `<h3 class="label">On the ship</h3>
             <ul class="group ships-list">${applied
               .map(
                 ([k, t]) => `<li><span class="ships-thumb"><img src="${esc(t.src)}" alt=""></span>
                   <span class="ships-hit"><b>${esc(targets.find(([x]) => x === k)?.[1] ?? k)}</b><small class="muted">${esc(t.credit || t.title || 'Your picture')}</small></span>
                   <button type="button" class="ghost" data-texoff="${esc(k)}">Remove</button></li>`,
               )
               .join('')}</ul>
             <p class="muted small pad-note">Pictures from the web keep their own licences (shown with each). Save the model under Models to keep them with it.</p>`
          : ''
      }`;
  }

  function renderPhotos() {
    const ph = st.photos;
    const sils = Object.fromEntries(Object.entries(ph).filter(([, v]) => v.sil).map(([k, v]) => [k, v.sil]));
    const L = Number(st.photoDims.length) || st.params.length;
    const est = Object.keys(sils).length ? sizeFrom(L, sils) : null;
    const n = Object.keys(sils).length;
    const sides = sils.port || sils.starboard, plan = sils.top || sils.bottom;
    const f = (x) => (x ? x.toFixed(1) : '');
    return `<div class="group pad">
      <p class="muted small">Up to six photos of one vessel, each taken square on from its side, on a plain background (sky, water, a wall) or cut out with transparency. The shape is what lies inside the vessel's outline in every photo, painted from the photo facing each part. Tap a box for its photo.</p>
      <div class="ships-photos">${PHOTO_VIEWS.map(([k, label, hint]) => {
        const v = ph[k];
        return `<div class="ships-photo-slot" data-has="${Boolean(v)}">
          <button type="button" data-photoslot="${k}" title="${esc(hint)}">${v ? `<img src="${esc(v.preview)}" alt="">` : `<span>+</span>`}</button>
          <b>${esc(label)}</b><small class="muted">${esc(v ? (v.sil ? v.name : 'No vessel found in it: try the threshold') : hint)}</small>
          ${v ? `<span class="row"><label class="small"><input type="checkbox" data-photoflip="${k}" ${v.flip ? 'checked' : ''}> mirrored</label>
            <button type="button" class="ghost" data-photodel="${k}" aria-label="Remove the ${esc(label)} photo">✕</button></span>` : ''}
          <input type="file" accept="image/*" hidden data-photofile="${k}">
        </div>`;
      }).join('')}</div>
      <label class="ships-range"><span class="ships-range-top"><span>Background threshold</span><b data-out="photoThreshold">${st.photoThreshold}</b></span>
        <input type="range" min="8" max="120" step="2" value="${st.photoThreshold}" data-photothreshold></label>
      <div class="ships-selects ships-fit">
        <label>Length overall (m)<input type="number" min="2" max="500" step="0.1" data-photodim="length" value="${esc(st.photoDims.length)}" placeholder="${f(st.params.length)}"></label>
        <label>Beam (m)<input type="number" min="0.5" max="90" step="0.1" data-photodim="beam" value="${esc(st.photoDims.beam)}" placeholder="${est ? `${f(est.B)} from the photos` : ''}"></label>
        <label>Height, keel to top (m)<input type="number" min="0.5" max="150" step="0.1" data-photodim="height" value="${esc(st.photoDims.height)}" placeholder="${est ? `${f(est.H)} from the photos` : ''}"></label>
        <label>Draught (m)<input type="number" min="0.1" max="30" step="0.1" data-photodim="draft" value="${esc(st.photoDims.draft)}" placeholder="${f(defaultParams(st.params.kind, L).draft)} typical"></label>
      </div>
      ${n && !(sides && plan) ? '<p class="muted small">A side photo and one from above (or below) are needed for a shape; the bow and stern photos shape its ends.</p>' : ''}
      ${st.photoError ? `<p class="error">${esc(st.photoError)}</p>` : ''}
      <div class="row"><button type="button" class="primary" data-act="photo-build" ${sides && plan && !st.photoBusy ? '' : 'disabled'}>${st.photoBusy ? 'Building…' : 'Build the vessel'}</button>
        ${n ? '<button type="button" class="ghost" data-act="photo-clear">Clear the photos</button>' : ''}</div>
      <p class="muted small">Hollows (an open deck, a cargo hold) cannot be seen in outlines and come out filled. Then save, download or place it on the map as any model.</p>
    </div>`;
  }

  /** What beam, height and draught the photos and the length give, in the empty fields' hints. */
  function photoHints() {
    const sils = Object.fromEntries(Object.entries(st.photos).filter(([, v]) => v.sil).map(([k, v]) => [k, v.sil]));
    const L = Number(st.photoDims.length) || st.params.length;
    const est = Object.keys(sils).length ? sizeFrom(L, sils) : null;
    const set = (k, text) => { const el = root.querySelector(`[data-photodim="${k}"]`); if (el) el.placeholder = text; };
    set('beam', est ? `${est.B.toFixed(1)} from the photos` : '');
    set('height', est ? `${(Number(st.photoDims.beam) > 0 && !sils.port && !sils.starboard ? est.H * (Number(st.photoDims.beam) / est.B) : est.H).toFixed(1)} from the photos` : '');
    set('draft', `${defaultParams(st.params.kind, L).draft.toFixed(1)} typical`);
  }

  async function setPhoto(view, file) {
    try {
      const img = await readPicture(file);
      const { sil, preview } = cutOut(img, st.photoThreshold, view);
      st.photos = { ...st.photos, [view]: { img, name: file.name, sil, preview, flip: st.photos[view]?.flip ?? false } };
      st.photoError = null;
    } catch (e) {
      st.photoError = e instanceof Error ? e.message : String(e);
    }
    renderTab();
  }

  function recut() {
    for (const [k, v] of Object.entries(st.photos)) {
      const { sil, preview } = cutOut(v.img, st.photoThreshold, k);
      st.photos[k] = { ...v, sil, preview };
    }
    renderTab();
  }

  function buildPhotos() {
    st.photoBusy = true;
    st.photoError = null;
    renderTab();
    setTimeout(() => {
      try {
        const num = (k) => (Number(st.photoDims[k]) > 0 ? Number(st.photoDims[k]) : null);
        const length = num('length') ?? st.params.length;
        // without a draught: the typical one of a vessel of this type and length
        const draft = num('draft') ?? defaultParams(st.params.kind, length).draft;
        const { object, size, ignored, mirrored } = buildFromPhotos(st.photos, { length, beam: num('beam'), height: num('height') });
        const name = (st.facts?.label ?? ((st.ais?.name || '').trim() || st.text.name || 'Vessel from photos'));
        const label = (k) => (PHOTO_VIEWS.find(([v]) => v === k)?.[1] ?? k).toLowerCase();
        const left = ignored.length
          ? ` Not used for the shape: ${ignored.map((x) => `the ${label(x.view)} photo (it would cut away ${Math.round(x.removed * 100)} % of what the others agree on: taken at an angle, mirrored, or another view?)`).join('; ')}.`
          : '';
        for (const k of mirrored) if (st.photos[k]) st.photos[k] = { ...st.photos[k], flip: !st.photos[k].flip };
        const flippedNote = mirrored.length ? ` The ${mirrored.map(label).join(' and ')} photo was the other way round (or of the other side) and was mirrored.` : '';
        st.notice = `Built from ${Object.values(st.photos).filter((v) => v.sil).length - ignored.length} photos: ${size.L.toFixed(1)} × ${size.B.toFixed(1)} m, ${size.H.toFixed(1)} m keel to top${num('height') ? '' : ' (height from the photos)'}.${flippedNote}${left} Save it to keep it, or place it on the map from the Ship tab.`;
        showFile({
          source: 'upload', entry: { id: `photos:${Date.now()}`, name, source: 'upload' }, object, name,
          fit: { up: '+y', forward: '+x', scale: 'length', length: size.L, draft: Math.min(draft, size.H * 0.9), waterline: 'keel' },
        });
      } catch (e) {
        st.photoError = e instanceof Error ? e.message : String(e);
      }
      st.photoBusy = false;
      renderTab();
    }, 30);
  }

  function renderModelsTab() {
    const f = st.file;
    const fit = f?.fit;
    const opt = (list, v) => list.map((k) => `<option value="${k}" ${k === v ? 'selected' : ''}>${k.toUpperCase()}</option>`).join('');
    const sf = st.saveForm;
    const row = (e, actions) => `<li>
        <span class="ships-thumb">${e.thumb ? `<img src="${esc(e.thumb)}" alt="">` : ''}</span>
        <span class="ships-hit"><b>${esc(e.name)}</b><small class="muted">${esc(
          [e.mmsi.length ? `MMSI ${e.mmsi.join(', ')}` : '', e.imo ? `IMO ${e.imo}` : '', e.callSign, e.size ? fmtSize(e.size) : e.file].filter(Boolean).join(' · '),
        )}</small></span>
        <span class="ships-actions">${actions}</span></li>`;
    return `
      ${st.notice ? `<p class="notice">${esc(st.notice)}</p>` : ''}
      ${st.fileError ? `<p class="error">${esc(st.fileError)}</p>` : ''}
      <h3 class="label">In view</h3>
      <div class="group pad">
        ${
          f
            ? `<p class="small"><b>${esc(f.name)}</b> <span class="muted">· ${esc(SOURCE_NAME[f.source])}${f.entry.credit ? ` · ${esc(f.entry.credit)}` : ''}</span></p>
               <div class="ships-selects ships-fit">
                 <label>Up is the model's<select data-fit="up">${opt(UP_AXES, fit.up)}</select></label>
                 <label>The bow is towards<select data-fit="forward">${opt(FORWARD_AXES.filter((a) => a[1] !== fit.up[1]), fit.forward)}</select></label>
                 <label>Size<select data-fit="scale">${[['length', 'Stretched to a length'], ['1', "The model's own, in metres"], ['0.01', 'Its own, in centimetres'], ['0.001', 'Its own, in millimetres'], ['0.3048', 'Its own, in feet']]
                   .map(([k, l]) => `<option value="${k}" ${String(fit.scale) === k ? 'selected' : ''}>${l}</option>`)
                   .join('')}</select></label>
                 ${fit.scale === 'length' ? `<label>Length overall (m)<input data-fit="length" type="number" min="1" max="500" step="0.1" value="${fit.length ?? ''}"></label>` : ''}
                 <label>Waterline<select data-fit="waterline">${[['keel', 'A draught above the keel'], ['origin', "At the model's own zero"]]
                   .map(([k, l]) => `<option value="${k}" ${fit.waterline === k ? 'selected' : ''}>${l}</option>`)
                   .join('')}</select></label>
                 ${fit.waterline === 'keel' ? `<label>Draught (m)<input data-fit="draft" type="number" min="0.1" max="40" step="0.1" value="${fit.draft ?? ''}"></label>` : ''}
               </div>
               <p class="muted small">Turn it until the bow points to the right in the Side view and the deck is up; the dimension lines show its size.</p>
               <div class="row"><button type="button" class="ghost" data-act="close-file">Show the built model</button></div>`
            : `<p class="small">The model built from the ship's type and size (Build).</p>`
        }
        ${st.fileLoading ? '<p class="muted small">Loading the model…</p>' : ''}
      </div>

      <h3 class="label">Upload a model</h3>
      <div class="group pad">
        <p class="muted small">A .glb or .gltf, an .obj with its .mtl and pictures, or an .stl. Choose all its files together. It is fitted to the ship in view (length and draught), which you can change above.</p>
        <div class="row"><button type="button" class="primary" data-act="model-upload" ${st.fileLoading ? 'disabled' : ''}>Choose model files…</button></div>
        <input type="file" multiple accept=".glb,.gltf,.obj,.mtl,.stl,.bin,image/*" hidden data-modelfile>
      </div>

      <h3 class="label">Model from photos</h3>
      ${renderPhotos()}

      <h3 class="label">Save and download</h3>
      <div class="group pad">
        ${
          sf
            ? `<form class="ships-text ships-save">
                 <label>Name<input name="name" value="${esc(sf.name)}" maxlength="60" autocomplete="off" required></label>
                 <label>MMSI (several with spaces)<input name="mmsi" value="${esc(sf.mmsi)}" inputmode="numeric" autocomplete="off"></label>
                 <label>IMO number<input name="imo" value="${esc(sf.imo)}" inputmode="numeric" maxlength="7" autocomplete="off"></label>
                 <label>Call sign<input name="callSign" value="${esc(sf.callSign)}" maxlength="10" autocomplete="off"></label>
                 <p class="muted small">The chart and the inspector use this model for the ship with this MMSI, IMO number, call sign or name, unless the vessels folder has one.</p>
                 <div class="row"><button type="submit" class="primary" ${st.saving ? 'disabled' : ''}>${st.saving ? 'Saving…' : st.file?.source === 'device' ? 'Save changes' : 'Save'}</button>
                   <button type="button" class="ghost" data-act="save-cancel">Cancel</button></div>
               </form>`
            : `<div class="row">
                 <button type="button" class="primary" data-act="save-open" ${model ? '' : 'disabled'}>Save on this device…</button>
                 <button type="button" class="tinted" data-act="glb">.glb</button>
                 <button type="button" class="tinted" data-act="glb-folder">.glb + .json for the vessels folder</button>
               </div>
               <p class="muted small">A .glb holds the whole model in one file, with its colours and pictures: metres, Y up, bow towards +X, waterline at 0.</p>`
        }
        ${
          model && !model.imported
            ? `<div class="row">
                 <button type="button" class="tinted" data-act="obj-all">.obj + .mtl + pictures</button>
                 <button type="button" class="tinted" data-act="obj">.obj only</button>
               </div>
               ${st.stats ? `<p class="muted small" data-out="stats">${st.stats.objects.toLocaleString()} parts · ${st.stats.vertices.toLocaleString()} vertices · ${st.stats.faces.toLocaleString()} triangles</p>` : ''}`
            : ''
        }
        <div class="row">
          <button type="button" class="ghost" data-act="shot">Save this view</button>
          ${model && !model.imported ? '<button type="button" class="ghost" data-act="hull-png">Save the hull paint</button>' : ''}
        </div>
      </div>

      <h3 class="label">On this device</h3>
      ${
        st.models.device.length
          ? `<ul class="group ships-list">${st.models.device
              .map((e) =>
                row(e, `<button type="button" class="tinted" data-showmodel="device:${esc(e.id)}">Show</button>
                  <button type="button" class="ghost" data-getmodel="device:${esc(e.id)}" aria-label="Download ${esc(e.name)}">⇩</button>
                  <button type="button" class="ghost" data-delmodel="${esc(e.id)}" aria-label="Delete ${esc(e.name)}">✕</button>`),
              )
              .join('')}</ul>`
          : '<p class="muted small pad-note">None yet. Save the model in view, built or uploaded, with Save on this device.</p>'
      }

      <h3 class="label">Vessels folder</h3>
      ${
        st.models.folder.length
          ? `<ul class="group ships-list">${st.models.folder
              .map((e) =>
                row(e, `<button type="button" class="tinted" data-showmodel="folder:${esc(e.id)}">Show</button>
                  <a class="ships-dl" href="${esc(new URL(e.file, FOLDER_URL).href)}" download aria-label="Download ${esc(e.name)}">⇩</a>`),
              )
              .join('')}</ul>`
          : ''
      }
      <p class="muted small pad-note">Rudder looks in its own vessels folder first (public/vessels/ in the code, listed in vessels/index.json), then on this device, and builds a ship from its type only when neither has a model for it. To add one to the folder for everyone: put the .glb and its .json there (.glb + .json above makes both) and run <code>npm run vessels</code>.</p>
      <p class="muted small pad-note">Ship data from Wikidata (CC0); photos and textures from Wikimedia Commons, Openverse and Poly Haven under their own licences, shown with each.</p>`;
  }

  function renderTab() {
    renderHead();
    if (st.tab === 'models' && !st.modelsAsked) {
      st.modelsAsked = true;
      refreshModels();
    }
    const r = { ship: renderShipTab, build: renderBuildTab, livery: renderLiveryTab, texture: renderTextureTab, sea: renderSeaTab, models: renderModelsTab }[st.tab];
    const scroll = body.scrollTop;
    body.innerHTML = r();
    body.scrollTop = scroll;
  }

  // ---------- events ----------

  root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !root.contains(b)) return;
    const d = b.dataset;
    if (d.mode) {
      st.mode = d.mode;
      scene?.setMode(st.mode);
      if (st.tab === 'sea') renderTab();
      else renderHead();
    } else if (d.view) scene?.view(d.view);
    else if (d.toggle === 'callouts') {
      st.callouts = !st.callouts;
      refreshCallouts();
      renderHead();
    } else if (d.toggle === 'autoRotate') {
      st.autoRotate = !st.autoRotate;
      scene?.setAutoRotate(st.autoRotate);
      renderHead();
    } else if (d.toggle === 'units') {
      st.units = st.units === 'metric' ? 'imperial' : 'metric';
      refreshCallouts();
      renderTab();
    } else if (d.tab && b.closest('.ships-tabs')) {
      st.tab = d.tab;
      st.sheetOpen = true;
      renderTab();
      body.scrollTop = 0;
    } else if (b.classList.contains('ships-grab')) {
      st.sheetOpen = !st.sheetOpen;
      renderHead();
    } else if (b.classList.contains('ships-close')) onClose?.();
    else if (d.suggest) runSearch(d.suggest);
    else if (d.qid) loadShip(d.qid, st.hits.find((h) => h.qid === d.qid)?.label);
    else if (d.img) {
      st.activeImage = st.images[Number(d.img)];
      st.uploadedUrl = null;
      st.tab = 'livery';
      sample(st.activeImage.thumb, true);
    } else if (d.slot) {
      st.slot = d.slot;
      renderTab();
    } else if (d.swatch) {
      st.livery = { ...st.livery, [st.slot]: d.swatch };
      repaint();
      renderTab();
    } else if (d.texsrc) {
      st.texSource = d.texsrc;
      st.texHits = [];
      st.texError = null;
      renderTab();
      if (st.texQuery && TEXTURE_SOURCES.some(([k]) => k === d.texsrc)) runTexSearch(st.texQuery);
    } else if (d.texsuggest) runTexSearch(d.texsuggest);
    else if (d.texhit) {
      const list = st.texSource === 'ship' ? st.images.map((i) => ({ ...i, alt: [], source: 'Wikimedia Commons' })) : st.texHits;
      const h = list[Number(d.texhit)];
      if (h) useHit(h);
    } else if (d.texoff) {
      if (model?.imported) { const { [d.texoff]: _, ...rest } = st.fileTextures; st.fileTextures = rest; }
      else { const { [d.texoff]: _, ...rest } = st.textures; st.textures = rest; }
      dressTextures();
      renderTab();
    } else if (d.showmodel) {
      const [src, id] = [d.showmodel.slice(0, d.showmodel.indexOf(':')), d.showmodel.slice(d.showmodel.indexOf(':') + 1)];
      const e = st.models[src]?.find((x) => x.id === id);
      if (e) openFile(e);
    } else if (d.getmodel) {
      const id = d.getmodel.slice(d.getmodel.indexOf(':') + 1);
      const e = st.models.device.find((x) => x.id === id);
      modelBlob(id).then((b) => b && downloadBlob(`${slug(e?.name ?? id)}.glb`, b));
    } else if (d.delmodel) {
      const e = st.models.device.find((x) => x.id === d.delmodel);
      if (e && confirm(`Delete “${e.name}” from this device?`)) {
        deleteModel(e.id).then(() => {
          if (st.file?.source === 'device' && st.file.entry.id === e.id) closeFile();
          refreshModels();
        });
      }
    } else if (d.photoslot) root.querySelector(`[data-photofile="${d.photoslot}"]`)?.click();
    else if (d.photodel) {
      const { [d.photodel]: _, ...rest } = st.photos;
      st.photos = rest;
      renderTab();
    } else if (d.act) act(d.act);
  });

  function act(a) {
    const base = (st.facts?.label ?? st.text.name ?? 'ship').replace(/[^A-Za-z0-9_-]+/g, '_') || 'ship';
    if (a === 'reshuffle') {
      st.params = { ...st.params, seed: Math.floor(Math.random() * 100000) };
      rebuild();
    } else if (a === 'reset-proportions') {
      st.params = { ...defaultParams(st.params.kind, st.params.length), seed: st.params.seed };
      rebuild();
      renderTab();
    } else if (a === 'upload') $('[data-file]').click();
    else if (a === 'auto') {
      st.livery = suggestLivery(st.palette, st.livery);
      repaint();
      renderTab();
    } else if (a === 'default-livery') {
      st.livery = liveryFromFacts(st.params.kind, st.facts ?? undefined);
      repaint();
      renderTab();
    } else if ((a === 'obj' || a === 'obj-all') && model && !model.imported) {
      const bundle = exportOBJ(model.group, st.facts?.label ?? st.text.name, { hull_livery: model.hullCanvas, transom_livery: model.transomCanvas });
      downloadText(`${base}.obj`, bundle.obj, 'model/obj');
      if (a === 'obj-all') {
        // one after the other, so the browser does not drop any of them
        setTimeout(() => downloadText(`${base}.mtl`, bundle.mtl), 300);
        bundle.textures.forEach((t, i) => setTimeout(() => downloadCanvas(t.name, t.canvas), 600 + i * 300));
      }
      st.stats = bundle.stats;
      renderTab();
    } else if (a === 'shot' && scene) {
      fetch(scene.screenshot())
        .then((r) => r.blob())
        .then((b) => downloadBlob(`${base}_view.png`, b));
    } else if (a === 'hull-png' && model?.hullCanvas) downloadCanvas(`${base}_hull_paint.png`, model.hullCanvas);
    else if (a === 'close-file') closeFile();
    else if (a === 'photo-build') buildPhotos();
    else if (a === 'photo-clear') { st.photos = {}; st.photoError = null; renderTab(); }
    else if (a === 'place' && model && onPlace) {
      const d = model.dims;
      const name = (st.file?.name ?? st.facts?.label ?? ((st.ais?.name || '').trim() || st.text.name || 'My ship')).replace(/^(MS|MV|M\/S|RMS)\s+/i, '');
      const spec = {
        name,
        kind: st.params.kind,
        length: model.imported ? d.xMax - d.xMin : st.params.length,
        beam: model.imported ? d.halfBeam * 2 : st.params.beam,
        draft: model.imported ? Math.max(0.5, -d.keelY) : st.params.draft,
      };
      // Its look goes with it: saved on this device under its new MMSI, which the chart draws it by.
      const keepLook = async (mmsi) => {
        const blob = await exportGlb(model.group);
        await saveModel({ id: `placed-${mmsi}`, name, mmsi: [String(mmsi)], blob, size: blob.size, length: +spec.length.toFixed(2), beam: +spec.beam.toFixed(2), draft: +spec.draft.toFixed(2), credit: credits(), placed: true, thumb: scene ? thumbnail(scene.renderer.domElement) : '' });
      };
      onPlace(spec, keepLook);
    }
    else if (a === 'tex-remove') {
      if (model?.imported) { const { [st.texTarget]: _, ...rest } = st.fileTextures; st.fileTextures = rest; }
      else { const { [st.texTarget]: _, ...rest } = st.textures; st.textures = rest; }
      dressTextures();
      renderTab();
    } else if (a === 'tex-upload') $('[data-texfile]')?.click();
    else if (a === 'model-upload') $('[data-modelfile]')?.click();
    else if (a === 'save-open') {
      st.saveForm = saveDefaults();
      st.notice = null;
      renderTab();
    } else if (a === 'save-cancel') {
      st.saveForm = null;
      renderTab();
    } else if (a === 'glb' || a === 'glb-folder') {
      downloadGlb(a === 'glb-folder').catch((e) => {
        st.fileError = `Could not make the .glb: ${e instanceof Error ? e.message : e}`;
        renderTab();
      });
    }
  }

  root.addEventListener('submit', (e) => {
    const form = e.target.closest('form');
    if (!form) return;
    e.preventDefault();
    const data = new FormData(form);
    if (form.classList.contains('ships-search')) runSearch(data.get('q') ?? '');
    else if (form.classList.contains('ships-texsearch')) runTexSearch(String(data.get('tq') ?? ''));
    else if (form.classList.contains('ships-texurl')) {
      const u = pictureUrl(data.get('u'));
      if (!u) {
        st.texError = 'That is not a web address (it should start with https://).';
        renderTab();
      } else usePicture({ urls: [u], title: decodeURIComponent(u.split(/[?#]/)[0].split('/').pop() || u), credit: new URL(u).hostname, page: u });
    } else if (form.classList.contains('ships-save')) {
      const v = (k) => String(data.get(k) ?? '').trim();
      saveToDevice({ name: v('name'), mmsi: v('mmsi'), imo: v('imo').replace(/\D/g, ''), callSign: v('callSign').toUpperCase() });
    }
  });

  root.addEventListener('input', (e) => {
    const el = e.target;
    const d = el.dataset;
    const out = (k, v) => {
      const o = root.querySelector(`[data-out="${k}"]`);
      if (o) o.textContent = v;
    };
    if (d.param) {
      const v = Number(el.value);
      const p = { ...st.params, [d.param]: v };
      if (d.param === 'draft') p.depth = Math.max(p.depth, v + 0.5);
      st.params = p;
      if (d.param in st.sources) st.sources = { ...st.sources, [d.param]: 'manual' };
      const shown = ['length', 'beam', 'draft', 'depth', 'airDraft'].includes(d.param)
        ? fmtLen(v, st.units)
        : d.param === 'blockCoefficient'
          ? v.toFixed(2)
          : ['sheer', 'flare'].includes(d.param)
            ? `${Math.round(v * 100)} %`
            : String(v);
      out(d.param, shown);
      out('ratios', ratios());
      rebuild();
    } else if (d.text) {
      const v =
        el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : d.text === 'imo' ? el.value.replace(/\D/g, '').slice(0, 7) : el.value;
      if (d.text === 'imo' && el.value !== v) el.value = v;
      st.text = { ...st.text, [d.text]: v };
      if (el.type === 'range') out(d.text, `${v.toFixed(2)}×`);
      repaint();
    } else if (d.color) {
      st.livery = { ...st.livery, [d.color]: el.value };
      repaint();
    } else if (d.sea) {
      if (d.sea === 'motion') {
        st.motion = el.checked;
        if (scene) scene.motion = st.motion;
        return;
      }
      const v = Number(el.value);
      st[d.sea] = v;
      if (d.sea === 'seaState') {
        scene?.setSeaState(v);
        out('seaState', `${Math.round(v * 9)} of 9`);
      } else if (d.sea === 'speed') {
        scene?.setSpeed(v);
        out('speed', `${v.toFixed(0)} kn`);
      } else {
        scene?.setSunElevation(v);
        out('sun', `${v.toFixed(0)}°`);
      }
    } else if (d.tex && el.type === 'range') {
      const v = Number(el.value);
      out(d.tex, d.tex === 'tile' ? fmtLen(v, st.units) : `${Math.round(v * 100)} %`);
      retexture(d.tex, v);
    } else if (d.photodim) {
      st.photoDims = { ...st.photoDims, [d.photodim]: el.value };
      photoHints(); // the estimates of the others follow, without redrawing the fields being typed in
    }
    else if (d.photothreshold !== undefined) out('photoThreshold', el.value);
    else if (el.name === 'q') st.query = el.value;
    else if (el.name === 'tq') st.texQuery = el.value;
    else if (el.closest('.ships-save') && st.saveForm) st.saveForm = { ...st.saveForm, [el.name]: el.value };
  });

  root.addEventListener('change', (e) => {
    const t = e.target;
    const td = t.dataset;
    if (td.tex && t.type !== 'range') {
      if (td.tex === 'target') {
        st.texTarget = t.value;
        const cur = (model?.imported ? st.fileTextures : st.textures)[t.value];
        if (cur) st.texOpts = { ...st.texOpts, mode: cur.mode, tile: cur.tile, opacity: cur.opacity, blend: cur.blend, flip: cur.flip, projection: cur.projection };
      } else retexture(td.tex, t.type === 'checkbox' ? t.checked : t.value);
      renderTab();
      return;
    }
    if (td.fit !== undefined && st.file) {
      const k = td.fit;
      let v = t.value;
      if (k === 'scale') v = v === 'length' ? 'length' : Number(v);
      else if (k === 'length' || k === 'draft') {
        v = Number(v);
        if (!(v > 0)) return;
      }
      const fit = { ...st.file.fit, [k]: v };
      // the bow cannot point along the up axis: take the other horizontal one
      if (k === 'up' && fit.forward[1] === v[1]) fit.forward = guessForward(st.file.object, v);
      st.file = { ...st.file, fit };
      rebuild();
      renderTab();
      return;
    }
    if (td.photofile && t.files?.[0]) { setPhoto(td.photofile, t.files[0]); return; }
    if (td.photoflip) { st.photos[td.photoflip] = { ...st.photos[td.photoflip], flip: t.checked }; return; }
    if (td.photothreshold !== undefined) { st.photoThreshold = Number(t.value); recut(); return; }
    if (td.texfile !== undefined && t.files?.[0]) {
      const file = t.files[0];
      const url = URL.createObjectURL(file);
      usePicture({ urls: [url], title: file.name, credit: '', page: '', local: true });
      return;
    }
    if (td.modelfile !== undefined && t.files?.length) {
      openUpload(t.files);
      return;
    }
    const el = e.target;
    if (el.dataset.select) {
      const k = el.dataset.select;
      if (k === 'kind') {
        st.params = { ...defaultParams(el.value, st.params.length), seed: st.params.seed };
        st.sources = { ...st.sources, beam: 'estimated', draft: 'estimated', airDraft: 'estimated' };
        st.livery = { ...DEFAULT_LIVERY[el.value] };
        renderTab();
      } else st.params = { ...st.params, [k]: el.value };
      rebuild();
    } else if (el.dataset.file !== undefined && el.files?.[0]) {
      if (st.uploadedUrl) URL.revokeObjectURL(st.uploadedUrl);
      st.uploadedUrl = URL.createObjectURL(el.files[0]);
      sample(st.uploadedUrl, true);
    } else if (el.name === 'q') st.query = el.value;
  });

  // ---------- start ----------

  if (scene) {
    scene.setSeaState(st.seaState);
    scene.setSpeed(st.speed);
    scene.setSunElevation(st.sun);
  }
  rebuild();
  renderTab();

  return {
    /** Build and show a vessel from its AIS report (see ../ais.js). */
    showAisVessel(v) {
      showAis(v);
    },
    /** Start drawing again after the screen was hidden. */
    resume() {
      scene?.resume();
    },
    /** Stop drawing while the map is in front: no frames, no battery. */
    pause() {
      scene?.pause();
    },
    destroy() {
      abort?.abort();
      clearTimeout(rebuildTimer);
      scene?.dispose();
      if (st.uploadedUrl) URL.revokeObjectURL(st.uploadedUrl);
      root.innerHTML = '';
    },
  };
}
