// Ship inspector: the screen behind "Ships" in the top bar. Search a vessel on Wikidata, see its
// facts and Commons photos, rebuild the hull in 3D, sample its colours from a photo, paint its name
// on the hull, look at it in a studio, at sea or from below the waterline, and export it as OBJ.
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

const SUGGESTIONS = ['Titanic', 'Queen Mary 2', 'Ever Given', 'Cutty Sark', 'USS Nimitz', 'Statsraad Lehmkuhl', 'Christian Radich', 'Color Magic'];
const MANUAL = { length: 'manual', beam: 'manual', draft: 'manual', airDraft: 'manual' };
const BANNER_KINDS = ['container', 'cruise', 'ferry', 'tanker'];
const TABS = [
  ['ship', 'Ship'],
  ['build', 'Build'],
  ['livery', 'Livery'],
  ['sea', 'Sea'],
  ['export', 'Export'],
];
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
export function createShipInspector(root, { onClose } = {}) {
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

  const calloutValues = () => ({
    loa: st.params.length,
    beam: st.params.beam,
    draft: st.params.draft,
    air: model ? model.dims.topY : st.params.airDraft,
    sources: st.sources,
  });

  function rebuild() {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      if (!scene) return;
      model = buildShip(st.params, st.livery, st.text);
      const reframe = lastKey !== st.shipKey;
      lastKey = st.shipKey;
      scene.setShip(model, reframe);
      st.topY = model.dims.topY;
      scene.setCallouts(calloutValues(), st.units, st.callouts);
      renderHead();
    }, 50);
  }
  const repaint = () => model?.applyLivery(st.livery, st.text);
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
    Object.assign(st, {
      tab: 'ship', ais: v, facts: null, params, sources, livery: { ...DEFAULT_LIVERY[params.kind] }, shipKey: `ais:${v.mmsi}`,
      hits: [], images: [], palette: [], activeImage: null, uploadedUrl: null, error: null, sheetOpen: true,
    });
    st.text = { ...st.text, name: name.toUpperCase(), port: '', banner: '', imo: v.imoNumber ? String(v.imoNumber) : '' };
    rebuild();
    renderTab();
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
    if (!ais) st.ais = null;
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

  // ---------- rendering ----------

  function renderHead() {
    $('.ships-title').textContent = st.facts?.label ?? ((st.ais?.name || '').trim() || (st.ais ? `MMSI ${st.ais.mmsi}` : 'Custom vessel'));
    const p = st.params;
    $('.ships-sub').textContent =
      `${KIND_PRESETS[p.kind].label} · ${fmtLen(p.length, st.units)} × ${fmtLen(p.beam, st.units)} · draft ${fmtLen(p.draft, st.units)}` +
      (st.topY ? ` · air ${fmtLen(st.topY, st.units)}` : '');
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

  function renderBuildTab() {
    const p = st.params;
    const L = (v) => fmtLen(v, st.units);
    const opt = (list, cur) => list.map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`).join('');
    return `
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

  function renderExportTab() {
    return `
      <h3 class="label">3D model</h3>
      <div class="group pad">
        <p class="muted small">Wavefront OBJ of the rebuilt ship at rest: hull, decks, deckhouses, funnels, masts and cargo. Metres, Y up, bow towards +X. The MTL file holds the colours and names the painted hull pictures.</p>
        <div class="row">
          <button type="button" class="primary" data-act="obj-all">.obj + .mtl + pictures</button>
          <button type="button" class="tinted" data-act="obj">.obj only</button>
        </div>
        ${st.stats ? `<p class="muted small" data-out="stats">${st.stats.objects.toLocaleString()} parts · ${st.stats.vertices.toLocaleString()} vertices · ${st.stats.faces.toLocaleString()} triangles</p>` : ''}
      </div>
      <h3 class="label">Pictures</h3>
      <div class="group pad">
        <div class="row">
          <button type="button" class="tinted" data-act="shot">Save this view</button>
          <button type="button" class="tinted" data-act="hull-png">Save the hull paint</button>
        </div>
      </div>
      <p class="muted small pad-note">Ship data from Wikidata (CC0); photos from Wikimedia Commons under their own licences, shown with each photo.</p>`;
  }

  function renderTab() {
    renderHead();
    const r = { ship: renderShipTab, build: renderBuildTab, livery: renderLiveryTab, sea: renderSeaTab, export: renderExportTab }[st.tab];
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
    } else if ((a === 'obj' || a === 'obj-all') && model) {
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
    } else if (a === 'hull-png' && model) downloadCanvas(`${base}_hull_paint.png`, model.hullCanvas);
  }

  root.addEventListener('submit', (e) => {
    const form = e.target.closest('.ships-search');
    if (!form) return;
    e.preventDefault();
    runSearch(new FormData(form).get('q') ?? '');
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
    } else if (el.name === 'q') st.query = el.value;
  });

  root.addEventListener('change', (e) => {
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
