// The Settings panel: BarentsWatch AIS access (kept on this device) and how safely this device keeps it.
//
// BarentsWatch's login server only answers its own website in a browser, so Rudder gets the token
// one of three ways, none of which installs anything:
//   - iPhone, iPad (and Mac): the Shortcuts app (handoff.js);
//   - any browser on Windows, macOS, Linux or Android: a bookmark clicked on BarentsWatch (bwlogin.js);
//   - Windows or macOS: a curl command in a terminal, its answer pasted back here.

import { loadCredentials, saveCredentials, clearCredentials, accessKind, storageState } from './credentials.js';
import { pastedToken } from './ais.js';
import { SHORTCUT_NAME, shortcutUrl, tokenFromResult } from './handoff.js';
import { loadGithub, saveGithub, clearGithub, repoFromLocation, branchFromBuild, validRepo } from './github.js';
import { BOOKMARK_NAME, BW_LOGIN_PAGE, bookmarkletUrl, deviceInfo, tokenCommand, startBookmarkLogin } from './bwlogin.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const when = (t) => (t ? new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const clock = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const mask = (s) => (s ? `${s.slice(0, 2)}${'•'.repeat(Math.max(4, s.length - 4))}${s.slice(-2)}` : '');

/**
 * Builds the settings into `el`. `ais` is the AIS layer (aismap.js): told when the credentials
 * change, asked to test them, and switched on when a new token arrives.
 */
export function createSettings(el, { ais, openPanel = () => {} }) {
  const device = deviceInfo();
  let msg = { text: '', tone: '' };
  let showSecret = false;
  let store = { persisted: null, standalone: false, ios: false };
  let login = null; // a bookmark login in progress (bwlogin.js)
  let cmdOs = device.os === 'mac' ? 'mac' : 'windows';
  let ghMsg = { text: '', tone: '' };

  async function refreshStorage(ask = false) {
    store = await storageState({ ask });
    render();
  }

  function storageText() {
    if (store.standalone) return { tone: 'ok', text: 'Rudder runs as an installed app here, so this device keeps its settings.' };
    if (store.ios) return { tone: 'warn', text: 'On iPhone and iPad, Safari clears a website\'s saved data after about 7 days without a visit. Add Rudder to the home screen (Share → Add to Home Screen) to keep your settings.' };
    if (store.persisted) return { tone: 'ok', text: 'This browser has agreed to keep Rudder\'s data, and will not clear it to free space.' };
    return { tone: 'warn', text: 'The browser may clear Rudder\'s data when the device runs short of space. Installing Rudder (browser menu → Install app, or Add to Home screen) keeps it safer.' };
  }

  function accessText(c) {
    const t = c.pasted ? pastedToken(c.pasted) : null;
    const client = accessKind(c) === 'client' ? ` Client <b>${esc(c.clientId)}</b> is saved for getting new ones.` : '';
    if (t && t.expiresAt > Date.now()) return { tone: 'ok', html: `A BarentsWatch token is saved on this device, valid until <b>${clock(t.expiresAt)}</b>.${client}` };
    if (t) return { tone: 'warn', html: `The saved token ran out at ${clock(t.expiresAt)}. Get a new one with the button below.${client}` };
    if (client) return { tone: 'warn', html: `Client <b>${esc(c.clientId)}</b> saved${c.savedAt ? ` (${esc(when(c.savedAt))})` : ''}. Get a token with the button below.` };
    return { tone: '', html: 'No BarentsWatch access on this device yet. Start with step 1 below.' };
  }

  function clientForm(c) {
    return `<form class="set-form" data-form="client" autocomplete="off">
      <label>Client ID
        <input name="clientId" value="${esc(c.clientId)}" placeholder="you@example.com:rudder" spellcheck="false" autocapitalize="off" autocorrect="off" inputmode="email"></label>
      <label>Client secret
        <span class="set-secret"><input name="clientSecret" type="${showSecret ? 'text' : 'password'}" value="${esc(c.clientSecret)}" autocomplete="new-password" spellcheck="false" autocapitalize="off" autocorrect="off">
        <button type="button" class="link-btn" data-act="reveal">${showSecret ? 'Hide' : 'Show'}</button></span></label>
      <div class="set-buttons"><button type="submit" class="set-btn">Save on this device</button></div>
    </form>`;
  }

  function render() {
    const c = loadCredentials();
    const kind = accessKind(c);
    const hasClient = kind === 'client';
    const a = accessText(c);
    const s = storageText();
    const bookmarkBtn = `<button type="button" class="set-btn ${device.method === 'bookmark' ? 'primary' : ''}" data-bwlogin ${hasClient ? '' : 'disabled'}>Get token from BarentsWatch</button>`;
    const shortcutBtn = device.apple ? `<button type="button" class="set-btn ${device.method === 'shortcut' ? 'primary' : ''}" data-shortcut>Get token with Shortcuts</button>` : '';
    const cmd = tokenCommand(c, cmdOs);
    const shownCmd = tokenCommand({ clientId: c.clientId, clientSecret: mask(c.clientSecret) }, cmdOs);
    el.innerHTML = `
      <section class="set-section">
        <h3>BarentsWatch AIS</h3>
        <p class="fine">Ships on the chart come from Kystverket's AIS through BarentsWatch, which needs your own free access. A token lasts about an hour.</p>
        <p class="set-state" data-tone="${a.tone}">${a.html}</p>
        <div class="set-buttons">
          ${device.method === 'shortcut' ? shortcutBtn + bookmarkBtn : bookmarkBtn + shortcutBtn}
          <button type="button" class="set-btn" data-act="test" ${kind ? '' : 'disabled'}>Test connection</button>
        </div>
        <p class="set-msg" data-tone="${msg.tone}" role="status">${esc(msg.text)}</p>

        <details class="set-more" ${hasClient ? '' : 'open'}>
          <summary>1. Your BarentsWatch client</summary>
          <p class="fine">On <a href="https://www.barentswatch.no/minside/" target="_blank" rel="noopener">BarentsWatch, Min side</a>, under <b>Utviklertilganger</b>, open <b>AIS - API</b> and create a client (for example <i>rudder</i>). Save its ID and secret here.</p>
          ${clientForm(c)}
        </details>

        <details class="set-more" ${hasClient && device.method === 'bookmark' && !c.pasted ? 'open' : ''}>
          <summary>2. Any browser: the "${esc(BOOKMARK_NAME)}" bookmark (once)</summary>
          <p class="fine">Works in Chrome, Edge, Firefox and Safari on Windows, Mac and Linux. Nothing to install: BarentsWatch only answers its own website, so the bookmark fetches the token while you are on it.</p>
          <ol class="set-steps fine">
            <li>Show the bookmarks bar (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd>, on Mac <kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd>), then drag this to it:
              <a class="set-bookmarklet" href="${esc(bookmarkletUrl(location.origin))}" data-bookmarklet title="Drag me to the bookmarks bar">⚓ ${esc(BOOKMARK_NAME)}</a>
              <br>Cannot drag? <button type="button" class="link-btn" data-act="copy-bookmark">Copy its address</button>, add any bookmark named <i>${esc(BOOKMARK_NAME)}</i> and paste it as the URL.</li>
            <li>Tap <b>Get token from BarentsWatch</b>. BarentsWatch opens in a new window (no need to log in).</li>
            <li>There, click the <b>${esc(BOOKMARK_NAME)}</b> bookmark. The window closes and Rudder has the token. On Android Chrome, type <i>${esc(BOOKMARK_NAME)}</i> in the address bar and pick the bookmark.</li>
          </ol>
          <p class="fine">The bookmark holds no secret: it asks this Rudder window for the client ID and secret, and Rudder answers only the BarentsWatch window it opened.</p>
        </details>

        ${device.apple ? `<details class="set-more" ${!hasClient && device.method === 'shortcut' && !c.pasted ? 'open' : ''}>
          <summary>${device.method === 'shortcut' ? '2' : '3'}. iPhone, iPad, Mac: the Shortcuts app (once)</summary>
          <p class="fine">Rudder asks the Shortcuts app for the token. Your secret stays in the shortcut.</p>
          <ol class="set-steps fine">
            <li>In <b>Shortcuts</b>, tap <b>+</b> and name the shortcut exactly <b>${esc(SHORTCUT_NAME)}</b>.</li>
            <li>Add <b>Get Contents of URL</b> with <code>https://id.barentswatch.no/connect/token</code>. Under Show More: Method <b>POST</b>, Request Body <b>Form</b>, and four text fields:
              <code>grant_type</code> = <code>client_credentials</code>, <code>client_id</code> = your client ID, <code>client_secret</code> = your secret, <code>scope</code> = <code>ais</code>.</li>
            <li>Add <b>Get Dictionary Value</b>: Get <b>Value</b> for <code>access_token</code> in <i>Contents of URL</i>. Add nothing after it.</li>
            <li>Back here, tap <b>Get token with Shortcuts</b>. Shortcuts runs and comes back to Rudder, which keeps the token on this device.</li>
          </ol>
          <p class="fine">If Shortcuts opens Rudder in another browser than the one you use it in, the token is saved there instead: use Rudder in your default browser.</p>
        </details>` : ''}

        <details class="set-more">
          <summary>Or: a command on Windows or Mac, then paste</summary>
          <p class="fine">curl comes with Windows 10 and 11 and with macOS. Run this in ${cmdOs === 'mac' ? '<b>Terminal</b>' : '<b>PowerShell</b> or <b>Command Prompt</b>'}; it copies BarentsWatch's answer to the clipboard. Then tap <b>Paste token</b>.</p>
          <div class="set-buttons set-tabs" role="group" aria-label="Computer">
            <button type="button" class="link-btn" data-os="windows" aria-pressed="${cmdOs === 'windows'}">Windows</button>
            <button type="button" class="link-btn" data-os="mac" aria-pressed="${cmdOs === 'mac'}">Mac</button>
          </div>
          <code class="set-code">${esc(shownCmd)}</code>
          <div class="set-buttons"><button type="button" class="set-btn" data-act="copy-cmd" data-cmd="${esc(cmd)}">Copy command</button>
            <button type="button" class="set-btn" data-act="paste">Paste token</button></div>
          ${hasClient ? '<p class="fine">The copied command contains your secret, so it lands in the terminal\'s history.</p>' : '<p class="fine">Save your client in step 1 first to have it filled in.</p>'}
          <form class="set-form" data-form="token" autocomplete="off">
            <label>Or paste the token (or the whole answer) here<textarea name="pasted" rows="3" spellcheck="false" placeholder="eyJ… or {&quot;access_token&quot;: …}"></textarea></label>
            <div class="set-buttons"><button type="submit" class="set-btn">Save token on this device</button></div>
          </form>
        </details>

        ${kind ? '<button type="button" class="set-btn danger" data-act="forget">Remove my BarentsWatch access from this device</button>' : ''}
        <p class="fine">Stored only on this device, in this browser's storage for Rudder, and sent only to BarentsWatch. There is no Rudder server. Anyone who can use this device unlocked can use it too.</p>
      </section>
      ${githubSection()}
      <section class="set-section">
        <h3>Storage on this device</h3>
        <p class="set-state" data-tone="${s.tone}">${s.text}</p>
        ${!store.standalone && store.persisted === false ? '<button type="button" class="set-btn" data-act="persist">Ask the browser to keep Rudder\'s data</button>' : ''}
      </section>`;
  }

  /** GitHub, for the ship builder's "Commit to GitHub" (github.js): repository, branch and token. */
  function githubSection() {
    const g = loadGithub();
    const repo = g.repo || repoFromLocation();
    const branch = g.branch || branchFromBuild(document.getElementById('build')?.textContent);
    return `<section class="set-section">
        <h3>GitHub (vessel models)</h3>
        <p class="fine">The ship builder can commit a vessel's model to Rudder's repository, so she is drawn with it on the chart after the next deploy. Use a fine-grained token for that repository with <b>Contents: read and write</b>.</p>
        ${ghMsg.text ? `<p class="set-state" data-tone="${ghMsg.tone}">${esc(ghMsg.text)}</p>` : g.token ? '<p class="set-state" data-tone="ok">A GitHub token is saved on this device.</p>' : ''}
        <form class="set-form" data-form="github" autocomplete="off">
          <label>Repository<input name="repo" value="${esc(repo)}" placeholder="owner/rudder" spellcheck="false" autocapitalize="off" autocorrect="off"></label>
          <label>Branch<input name="branch" value="${esc(branch)}" placeholder="the repository's default branch" spellcheck="false" autocapitalize="off" autocorrect="off"></label>
          <label>Token<input name="token" type="password" value="${esc(g.token)}" placeholder="github_pat_…" autocomplete="new-password" spellcheck="false" autocapitalize="off" autocorrect="off"></label>
          <div class="set-buttons"><button type="submit" class="set-btn">Save on this device</button>${g.token ? '<button type="button" class="set-btn danger" data-act="github-forget">Remove</button>' : ''}</div>
        </form>
        <p class="fine">Kept only on this device and sent only to api.github.com.</p>
      </section>`;
  }

  function say(text, tone = '') { msg = { text, tone }; render(); }

  async function onSubmit(e) {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const f = new FormData(form);
    if (form.dataset.form === 'github') {
      const repo = String(f.get('repo') ?? '').trim();
      if (repo && !validRepo(repo)) { ghMsg = { text: 'Write the repository as owner/name.', tone: 'err' }; return render(); }
      try { saveGithub({ repo, branch: f.get('branch'), token: f.get('token') }); } catch { ghMsg = { text: 'This browser will not store anything (private browsing?).', tone: 'err' }; return render(); }
      ghMsg = { text: 'GitHub settings saved on this device.', tone: 'ok' };
      return render();
    }
    const cur = loadCredentials();
    if (form.dataset.form === 'client') {
      const next = { clientId: f.get('clientId'), clientSecret: f.get('clientSecret'), pasted: cur.pasted };
      if (!String(next.clientId).trim() || !String(next.clientSecret).trim()) return say('Enter both the client ID and the secret.', 'err');
      try { saveCredentials(next); } catch { return say('This browser will not store anything (private browsing?). Open Rudder in a normal window.', 'err'); }
      showSecret = false;
      ais.credentialsChanged();
      refreshStorage(true);
      return say(cur.pasted ? 'Client saved on this device.' : 'Client saved. Now get a token with the button above.', 'ok');
    }
    await useTokenText(f.get('pasted'));
  }

  /** A token, "Bearer …" or BarentsWatch's whole JSON answer, typed or from the clipboard. */
  async function useTokenText(text) {
    let token = null;
    try { token = tokenFromResult(text); } catch (e) { return say(`BarentsWatch refused the login (${e.message}). Check the client ID and secret.`, 'err'); }
    if (!token) return say('That does not look like a token. Paste the access_token value, or the whole answer from BarentsWatch.', 'err');
    await fromToken({ status: 'ok', token }, 'Token saved.');
  }

  /** Save, ask the browser to keep it, tell the AIS layer, and test. */
  async function store_(next, saved) {
    try {
      saveCredentials(next);
    } catch {
      return say('This browser will not store anything (private browsing?). Open Rudder in a normal window.', 'err');
    }
    showSecret = false;
    say(`${saved} Testing…`);
    await refreshStorage(true);
    ais.credentialsChanged();
    return test();
  }

  async function test() {
    say('Testing…');
    const r = await ais.testAccess();
    say(r.ok ? `${r.message} Ships (AIS) is under the layers button.` : r.message, r.ok ? 'ok' : 'err');
    return r.ok;
  }

  /** A token arrived (from Shortcuts, the bookmark or a paste): keep it, test it, and show the ships. */
  async function fromToken(h, saved = 'Got a new token.') {
    if (h.status !== 'ok') return say(h.message, h.status === 'cancel' ? '' : 'err');
    const cur = loadCredentials();
    const ok = await store_({ clientId: cur.clientId, clientSecret: cur.clientSecret, pasted: h.token }, saved);
    if (ok) ais.setOn(true);
  }

  /** Open BarentsWatch Min side and wait for the bookmark there (bwlogin.js). Must run from a click. */
  function bookmarkLogin() {
    const c = loadCredentials();
    openPanel(); // the steps and the outcome are shown in Settings
    if (accessKind(c) !== 'client') {
      return say('Save your BarentsWatch client ID and secret first (step 1).', 'err');
    }
    login?.stop();
    try {
      login = startBookmarkLogin({
        getCreds: () => loadCredentials(),
        onHello: () => say('The bookmark is asking BarentsWatch for a token…'),
        onResult: (h) => { login = null; window.focus(); fromToken(h, 'Got a new token from BarentsWatch.'); },
      });
    } catch (e) {
      login = null;
      return say(e.message, 'err');
    }
    say(`BarentsWatch opened in a new window. Click the "${BOOKMARK_NAME}" bookmark there.`);
  }

  /** "Get a new token" anywhere: the way that suits this device. */
  function renew() {
    if (device.method === 'shortcut') location.href = shortcutUrl(location.href);
    else bookmarkLogin();
  }

  async function copy(text, done) {
    try { await navigator.clipboard.writeText(text); say(done, 'ok'); } catch { say('Could not copy here: select the text and copy it yourself.', 'err'); }
  }

  el.addEventListener('submit', onSubmit);
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-bookmarklet]')) {
      e.preventDefault();
      return say(`Drag "${BOOKMARK_NAME}" to the bookmarks bar instead; it only works when clicked on BarentsWatch.`);
    }
    const os = e.target.closest('[data-os]')?.dataset.os;
    if (os) { cmdOs = os; return render(); }
    const btn = e.target.closest('[data-act]');
    const act = btn?.dataset.act;
    if (act === 'reveal') {
      const input = el.querySelector('input[name=clientSecret]');
      showSecret = !showSecret;
      input.type = showSecret ? 'text' : 'password';
      btn.textContent = showSecret ? 'Hide' : 'Show';
    } else if (act === 'test') await test();
    else if (act === 'copy-bookmark') await copy(bookmarkletUrl(location.origin), `Copied. Add a bookmark named "${BOOKMARK_NAME}" with this as its URL.`);
    else if (act === 'copy-cmd') await copy(btn.dataset.cmd, 'Command copied. Run it, then tap Paste token.');
    else if (act === 'paste') {
      let text = '';
      try { text = await navigator.clipboard.readText(); } catch {
        return say('The browser did not let Rudder read the clipboard. Paste into the box below instead.', 'err');
      }
      await useTokenText(text);
    } else if (act === 'forget') {
      if (!confirm('Remove your BarentsWatch access (token, client ID and secret) from this device?')) return;
      clearCredentials();
      ais.credentialsChanged();
      say('Removed from this device.');
    } else if (act === 'persist') await refreshStorage(true);
    else if (act === 'github-forget') {
      clearGithub();
      ghMsg = { text: 'GitHub token removed from this device.', tone: '' };
      render();
    }
  });

  render();
  refreshStorage();
  /** The bookmark was clicked on Rudder itself: point to the button that opens BarentsWatch. */
  function bookmarkClickedHere() {
    openPanel();
    const c = loadCredentials();
    say(accessKind(c) === 'client'
      ? `The "${BOOKMARK_NAME}" bookmark works on BarentsWatch, not here. Tap Get token from BarentsWatch, then click the bookmark in the window that opens.`
      : `The "${BOOKMARK_NAME}" bookmark is set up. Save your BarentsWatch client in step 1, then tap Get token from BarentsWatch and click the bookmark in the window that opens.`);
    el.querySelector('[data-bwlogin]:not(:disabled)')?.focus();
  }

  return { render, renew, bookmarkLogin, bookmarkClickedHere, fromToken, device };
}
