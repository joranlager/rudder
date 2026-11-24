// The Settings panel: BarentsWatch AIS access (kept on this device) and how safely this device keeps it.

import { loadCredentials, saveCredentials, clearCredentials, accessKind, storageState } from './credentials.js';
import { pastedToken } from './ais.js';
import { SHORTCUT_NAME } from './handoff.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const when = (t) => (t ? new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const clock = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/**
 * Builds the settings into `el`. `ais` is the AIS layer (aismap.js): told when the credentials
 * change, and asked to test them.
 */
export function createSettings(el, { ais }) {
  let msg = { text: '', tone: '' };
  let showSecret = false;
  let store = { persisted: null, standalone: false, ios: false };

  async function refreshStorage(ask = false) {
    store = await storageState({ ask });
    render();
  }

  function storageText() {
    if (store.standalone) return { tone: 'ok', text: 'Rudder runs from your home screen, so the phone keeps its settings.' };
    if (store.ios) return { tone: 'warn', text: 'On iPhone and iPad, Safari clears a website\'s saved data after about 7 days without a visit. Add Rudder to the home screen (Share → Add to Home Screen) to keep your settings.' };
    if (store.persisted) return { tone: 'ok', text: 'This browser has agreed to keep Rudder\'s data, and will not clear it to free space.' };
    return { tone: 'warn', text: 'The browser may clear Rudder\'s data when the phone runs short of space. Installing Rudder (browser menu → Install app or Add to Home screen) keeps it safer.' };
  }

  function accessText(c) {
    const t = c.pasted ? pastedToken(c.pasted) : null;
    if (t && t.expiresAt > Date.now()) return { tone: 'ok', html: `A BarentsWatch token is saved on this phone, valid until <b>${clock(t.expiresAt)}</b>.` };
    if (t) return { tone: 'warn', html: `The saved token ran out at ${clock(t.expiresAt)}. Get a new one with the button below.` };
    if (accessKind(c) === 'client') return { tone: 'warn', html: `Client <b>${esc(c.clientId)}</b> saved${c.savedAt ? ` (${esc(when(c.savedAt))})` : ''}, but BarentsWatch does not let Rudder log in with it from a browser. Get a token with Shortcuts instead.` };
    return { tone: '', html: 'No BarentsWatch access on this phone yet.' };
  }

  function render() {
    const c = loadCredentials();
    const kind = accessKind(c);
    const a = accessText(c);
    const s = storageText();
    el.innerHTML = `
      <section class="set-section">
        <h3>BarentsWatch AIS</h3>
        <p class="fine">Ships on the chart come from Kystverket's AIS through BarentsWatch, which needs your own free access.</p>
        <p class="set-state" data-tone="${a.tone}">${a.html}</p>
        <div class="set-buttons">
          <button type="button" class="set-btn primary" data-shortcut>Get token with Shortcuts</button>
          <button type="button" class="set-btn" data-act="test" ${kind ? '' : 'disabled'}>Test connection</button>
        </div>
        <p class="set-msg" data-tone="${msg.tone}" role="status">${esc(msg.text)}</p>
        <details class="set-more" ${c.pasted ? '' : 'open'}>
          <summary>Set up the shortcut (once)</summary>
          <p class="fine">BarentsWatch only lets its own website log in from a browser, so Rudder asks the Shortcuts app (iPhone, iPad, Mac) for the token. Your secret stays in the shortcut.</p>
          <ol class="set-steps fine">
            <li>On <a href="https://www.barentswatch.no/minside/" target="_blank" rel="noopener">BarentsWatch, Min side</a>, under <b>Utviklertilganger</b>, open <b>AIS - API</b> and create a client (for example <i>rudder</i>). Note the client ID and secret.</li>
            <li>In <b>Shortcuts</b>, tap <b>+</b> and name the shortcut exactly <b>${esc(SHORTCUT_NAME)}</b>.</li>
            <li>Add <b>Get Contents of URL</b> with <code>https://id.barentswatch.no/connect/token</code>. Under Show More: Method <b>POST</b>, Request Body <b>Form</b>, and four text fields:
              <code>grant_type</code> = <code>client_credentials</code>, <code>client_id</code> = your client ID, <code>client_secret</code> = your secret, <code>scope</code> = <code>ais</code>.</li>
            <li>Add <b>Get Dictionary Value</b>: Get <b>Value</b> for <code>access_token</code> in <i>Contents of URL</i>. Add nothing after it.</li>
            <li>Back here, tap <b>Get token with Shortcuts</b>. Shortcuts runs and comes back to Rudder, which keeps the token (about an hour) on this phone.</li>
          </ol>
          <p class="fine">If Shortcuts opens Rudder in another browser than the one you use it in, the token is saved there instead: use Rudder in your default browser.</p>
        </details>
        <details class="set-more">
          <summary>Paste a token</summary>
          <p class="fine">A token fetched any other way, for example on a computer:</p>
          <code class="set-code">curl -d grant_type=client_credentials -d client_id=YOUR_ID -d client_secret=YOUR_SECRET -d scope=ais https://id.barentswatch.no/connect/token</code>
          <form class="set-form" data-form="token" autocomplete="off">
            <label>Access token<textarea name="pasted" rows="3" spellcheck="false" placeholder="eyJ…"></textarea></label>
            <div class="set-buttons"><button type="submit" class="set-btn">Save token on this phone</button></div>
          </form>
        </details>
        <details class="set-more">
          <summary>Client ID and secret</summary>
          <p class="fine">Only works if BarentsWatch lets Rudder's website log in from a browser. Today it does not (checked 24 Nov 2026); kept for when it does.</p>
          <form class="set-form" data-form="client" autocomplete="off">
            <label>Client ID
              <input name="clientId" value="${esc(c.clientId)}" placeholder="you@example.com:rudder" spellcheck="false" autocapitalize="off" autocorrect="off" inputmode="email"></label>
            <label>Client secret
              <span class="set-secret"><input name="clientSecret" type="${showSecret ? 'text' : 'password'}" value="${esc(c.clientSecret)}" autocomplete="new-password" spellcheck="false" autocapitalize="off" autocorrect="off">
              <button type="button" class="link-btn" data-act="reveal">${showSecret ? 'Hide' : 'Show'}</button></span></label>
            <div class="set-buttons"><button type="submit" class="set-btn">Save on this phone</button></div>
          </form>
        </details>
        ${kind ? '<button type="button" class="set-btn danger" data-act="forget">Remove my BarentsWatch access from this phone</button>' : ''}
        <p class="fine">Stored only on this phone, in this browser's storage for Rudder, and sent only to BarentsWatch. There is no Rudder server. Anyone who can use this phone unlocked can use it too.</p>
      </section>
      <section class="set-section">
        <h3>Storage on this phone</h3>
        <p class="set-state" data-tone="${s.tone}">${s.text}</p>
        ${!store.standalone && store.persisted === false ? '<button type="button" class="set-btn" data-act="persist">Ask the browser to keep Rudder\'s data</button>' : ''}
      </section>`;
  }

  async function onSubmit(e) {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const f = new FormData(form);
    const cur = loadCredentials();
    const next = form.dataset.form === 'client'
      ? { clientId: f.get('clientId'), clientSecret: f.get('clientSecret'), pasted: cur.pasted }
      : { clientId: cur.clientId, clientSecret: cur.clientSecret, pasted: f.get('pasted') };
    if (form.dataset.form === 'client' && (!String(next.clientId).trim() || !String(next.clientSecret).trim())) {
      msg = { text: 'Enter both the client ID and the secret.', tone: 'err' };
      return render();
    }
    await store_(next, 'Saved on this phone.');
  }

  /** Save, ask the browser to keep it, tell the AIS layer, and test. */
  async function store_(next, saved) {
    try {
      saveCredentials(next);
    } catch {
      msg = { text: 'This browser will not store anything (private browsing?). Open Rudder in a normal window.', tone: 'err' };
      return render();
    }
    showSecret = false;
    msg = { text: `${saved} Testing…`, tone: '' };
    render();
    await refreshStorage(true);
    ais.credentialsChanged();
    await test();
  }

  async function test() {
    msg = { text: 'Testing…', tone: '' };
    render();
    const r = await ais.testAccess();
    msg = { text: r.ok ? `${r.message} Ships (AIS) is under the layers button.` : r.message, tone: r.ok ? 'ok' : 'err' };
    render();
  }

  el.addEventListener('submit', onSubmit);
  el.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'reveal') {
      const input = el.querySelector('input[name=clientSecret]');
      showSecret = !showSecret;
      input.type = showSecret ? 'text' : 'password';
      e.target.textContent = showSecret ? 'Hide' : 'Show';
    } else if (act === 'test') await test();
    else if (act === 'forget') {
      if (!confirm('Remove your BarentsWatch access (token, client ID and secret) from this phone?')) return;
      clearCredentials();
      msg = { text: 'Removed from this phone.', tone: '' };
      ais.credentialsChanged();
      render();
    } else if (act === 'persist') await refreshStorage(true);
  });

  render();
  refreshStorage();
  return {
    render,
    /** Rudder was opened again by Shortcuts (handoff.js): keep the token, or say what went wrong. */
    async fromShortcut(h) {
      if (h.status !== 'ok') {
        msg = { text: h.message, tone: h.status === 'cancel' ? '' : 'err' };
        return render();
      }
      const cur = loadCredentials();
      await store_({ clientId: cur.clientId, clientSecret: cur.clientSecret, pasted: h.token }, 'Got a new token from Shortcuts.');
    },
  };
}
