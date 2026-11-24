// The Settings panel: BarentsWatch AIS access (kept on this device) and how safely this device keeps it.

import { loadCredentials, saveCredentials, clearCredentials, accessKind, storageState } from './credentials.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const when = (t) => (t ? new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

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
    if (store.ios) return { tone: 'warn', text: 'On iPhone and iPad, Safari clears a website\'s saved data after about 7 days without a visit. Add Rudder to the home screen (Share → Add to Home Screen) and open it from there to keep your settings.' };
    if (store.persisted) return { tone: 'ok', text: 'This browser has agreed to keep Rudder\'s data, and will not clear it to free space.' };
    return { tone: 'warn', text: 'The browser may clear Rudder\'s data when the phone runs short of space. Installing Rudder (browser menu → Install app or Add to Home screen) keeps it safer.' };
  }

  function render() {
    const c = loadCredentials();
    const kind = accessKind(c);
    const s = storageText();
    el.innerHTML = `
      <section class="set-section">
        <h3>BarentsWatch AIS</h3>
        <p class="fine">Ships on the chart come from Kystverket's AIS through BarentsWatch, which needs your own free access:</p>
        <ol class="set-steps fine">
          <li>Log in at <a href="https://www.barentswatch.no/minside/" target="_blank" rel="noopener">BarentsWatch, Min side</a>.</li>
          <li>Under <b>Utviklertilganger</b>, open <b>AIS - API</b> (not BarentsWatch - API) and create a client, for example named <i>rudder</i>.</li>
          <li>Copy the client ID and the secret into the fields below.</li>
        </ol>
        <p class="set-state" data-tone="${kind ? 'ok' : ''}">${
          kind === 'client' ? `Client <b>${esc(c.clientId)}</b> saved on this phone${c.savedAt ? ` (${esc(when(c.savedAt))})` : ''}.`
            : kind === 'token' ? 'An access token is saved on this phone (it lasts about an hour).'
              : 'Nothing saved yet.'
        }</p>
        <form class="set-form" data-form="client" autocomplete="off">
          <label>Client ID
            <input name="clientId" value="${esc(c.clientId)}" placeholder="you@example.com:rudder" spellcheck="false" autocapitalize="off" autocorrect="off" inputmode="email"></label>
          <label>Client secret
            <span class="set-secret"><input name="clientSecret" type="${showSecret ? 'text' : 'password'}" value="${esc(c.clientSecret)}" autocomplete="new-password" spellcheck="false" autocapitalize="off" autocorrect="off">
            <button type="button" class="link-btn" data-act="reveal">${showSecret ? 'Hide' : 'Show'}</button></span></label>
          <div class="set-buttons">
            <button type="submit" class="set-btn primary">Save on this phone</button>
            <button type="button" class="set-btn" data-act="test" ${kind ? '' : 'disabled'}>Test connection</button>
          </div>
        </form>
        <p class="set-msg" data-tone="${msg.tone}" role="status">${esc(msg.text)}</p>
        <details class="set-token" ${kind === 'token' ? 'open' : ''}>
          <summary>Use an access token instead</summary>
          <p class="fine">Only if the app says the BarentsWatch login server does not answer it. Get a token on a computer, valid for about an hour:</p>
          <code class="set-code">curl -d grant_type=client_credentials -d client_id=YOUR_ID -d client_secret=YOUR_SECRET -d scope=ais https://id.barentswatch.no/connect/token</code>
          <form class="set-form" data-form="token" autocomplete="off">
            <label>Access token<textarea name="pasted" rows="3" spellcheck="false" placeholder="eyJ…">${esc(c.pasted)}</textarea></label>
            <div class="set-buttons"><button type="submit" class="set-btn">Save token on this phone</button></div>
          </form>
        </details>
        ${kind ? '<button type="button" class="set-btn danger" data-act="forget">Remove my BarentsWatch access from this phone</button>' : ''}
        <p class="fine">Stored only on this phone, in this browser's storage for Rudder. It is sent only to BarentsWatch, never to anyone else; there is no Rudder server. Anyone who can use this phone unlocked can use it too, so remove it before lending or selling the phone.</p>
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
      ? { clientId: f.get('clientId'), clientSecret: f.get('clientSecret'), pasted: '' }
      : { clientId: cur.clientId, clientSecret: cur.clientSecret, pasted: f.get('pasted') };
    if (form.dataset.form === 'client' && (!String(next.clientId).trim() || !String(next.clientSecret).trim())) {
      msg = { text: 'Enter both the client ID and the secret.', tone: 'err' };
      return render();
    }
    if (form.dataset.form === 'token') { next.clientId = ''; next.clientSecret = ''; }
    try {
      saveCredentials(next);
    } catch {
      msg = { text: 'This browser will not store anything (private browsing?). Open Rudder in a normal window.', tone: 'err' };
      return render();
    }
    showSecret = false;
    msg = { text: 'Saved on this phone. Testing…', tone: '' };
    render();
    await refreshStorage(true); // saving is a good moment to ask the browser to keep the data
    ais.credentialsChanged();
    await test();
  }

  async function test() {
    msg = { text: 'Testing…', tone: '' };
    render();
    const r = await ais.testAccess();
    msg = { text: r.ok ? `${r.message} Switch on Ships (AIS) under the layers button.` : r.message, tone: r.ok ? 'ok' : 'err' };
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
      if (!confirm('Remove your BarentsWatch client ID and secret from this phone?')) return;
      clearCredentials();
      msg = { text: 'Removed from this phone.', tone: '' };
      ais.credentialsChanged();
      render();
    } else if (act === 'persist') await refreshStorage(true);
  });

  render();
  refreshStorage();
  return { render };
}
