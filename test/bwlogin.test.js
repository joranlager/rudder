import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BW_ORIGINS, BW_LOGIN_PAGE, TOKEN_ENDPOINT, bookmarkletUrl, deviceInfo, tokenCommand, readBookmarkResult, startBookmarkLogin,
} from '../public/bwlogin.js';

const RUDDER = 'https://joranlager.github.io';
const BW_ORIGIN = BW_ORIGINS[0];
const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjE5MDAwMDAwMDB9.c2lnbmF0dXJlLXNpZ25hdHVyZQ';
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Run the bookmarklet as if clicked on a page at `origin`, opened by `opener`. */
function runBookmarklet(url, { origin = BW_ORIGIN, opener, fetchImpl }) {
  const listeners = new Set();
  const events = [];
  const timers = [];
  let shown = null; // the banner on the page, if any
  const el = () => {
    const e = { style: {}, text: '', id: '', append: (...p) => { e.text = p.map((x) => (typeof x === 'string' ? x : x.textContent)).join(''); },
      remove: () => { if (shown === e) shown = null; } };
    return e;
  };
  const document = { getElementById: (id) => (shown?.id === id ? shown : null), createElement: el, body: { appendChild: (e) => { shown = e; } } };
  let closed = false;
  const g = {
    location: { origin },
    window: { opener },
    document,
    addEventListener: (t, f) => listeners.add(f),
    removeEventListener: (t, f) => listeners.delete(f),
    dispatchEvent: (e) => events.push(e.type),
    CustomEvent: class { constructor(type) { this.type = type; } },
    fetch: fetchImpl,
    close: () => { closed = true; },
    setTimeout: (f, ms) => timers.push([f, ms]),
    URLSearchParams,
  };
  const src = decodeURIComponent(url.slice('javascript:'.length));
  new Function(...Object.keys(g), src)(...Object.values(g));
  return {
    banner: () => shown?.text ?? '',
    clickBanner: () => shown?.onclick(),
    runTimers: () => timers.splice(0).forEach(([f]) => f()),
    timers, events,
    dispatch: (e) => [...listeners].forEach((f) => f(e)), isClosed: () => closed, listeners,
  };
}

test('the bookmarklet is one javascript: link naming only Rudder\'s origin', () => {
  const url = bookmarkletUrl(`${RUDDER}/rudder/#at=9/59/5`);
  assert.ok(url.startsWith('javascript:'));
  assert.ok(!/\s/.test(url), 'no spaces or line breaks in a bookmark URL');
  const src = decodeURIComponent(url.slice(11));
  assert.ok(src.includes(JSON.stringify(RUDDER)));
  assert.ok(!src.includes('/rudder/'), 'origin only, so postMessage can target it');
  assert.doesNotThrow(() => new Function(src));
});

test('the bookmarklet asks Rudder for the client, gets the token and sends it back', async () => {
  const sent = [];
  const opener = { closed: false, postMessage: (m, o) => sent.push([m, o]) };
  let request;
  const run = runBookmarklet(bookmarkletUrl(RUDDER), {
    opener,
    fetchImpl: async (u, init) => { request = { u, init }; return { ok: true, text: async () => JSON.stringify({ access_token: JWT }) }; },
  });
  assert.deepEqual(sent[0], [{ rudderBw: 1, hello: 1 }, RUDDER]);
  run.dispatch({ origin: 'https://evil.example', source: opener, data: { rudderCreds: 1, id: 'x', secret: 'y' } });
  run.dispatch({ origin: RUDDER, source: {}, data: { rudderCreds: 1, id: 'x', secret: 'y' } });
  assert.equal(request, undefined, 'only Rudder, in the window that opened it, is answered');
  run.dispatch({ origin: RUDDER, source: opener, data: { rudderCreds: 1, id: 'me@x.no:rudder', secret: 's3cret' } });
  await tick();
  assert.equal(request.u, TOKEN_ENDPOINT);
  const body = new URLSearchParams(request.init.body);
  assert.deepEqual(Object.fromEntries(body), { grant_type: 'client_credentials', client_id: 'me@x.no:rudder', client_secret: 's3cret', scope: 'ais' });
  assert.deepEqual(sent[1], [{ rudderBw: 1, result: JSON.stringify({ access_token: JWT }) }, RUDDER]);
  assert.match(run.banner(), /done/);
  run.runTimers();
  assert.equal(run.isClosed(), true);
  assert.equal(run.listeners.size, 0);
});

test('clicked on Rudder itself, the bookmark tells Rudder instead of showing a banner', () => {
  const here = runBookmarklet(bookmarkletUrl(RUDDER), { origin: RUDDER, opener: null });
  assert.deepEqual(here.events, ['rudder-bookmark']);
  assert.equal(here.banner(), '');
});

test('banners close on a click, and wrong-place ones by themselves', () => {
  const elsewhere = runBookmarklet(bookmarkletUrl(RUDDER), { origin: 'https://example.com', opener: null });
  assert.match(elsewhere.banner(), /BarentsWatch/);
  assert.ok(elsewhere.timers[0][1] >= 5000, 'stays long enough to read');
  elsewhere.runTimers();
  assert.equal(elsewhere.banner(), '', 'gone after a while');
  const notOpened = runBookmarklet(bookmarkletUrl(RUDDER), { opener: null });
  notOpened.clickBanner();
  assert.equal(notOpened.banner(), '', 'gone when clicked');
});

test('the bookmarklet explains itself when used in the wrong place', () => {
  const elsewhere = runBookmarklet(bookmarkletUrl(RUDDER), { origin: 'https://example.com', opener: { postMessage() {} } });
  assert.match(elsewhere.banner(), /BarentsWatch/);
  const notOpened = runBookmarklet(bookmarkletUrl(RUDDER), { opener: null });
  assert.match(notOpened.banner(), /open BarentsWatch from Rudder/);
  const onWww = runBookmarklet(bookmarkletUrl(RUDDER), { origin: 'https://www.barentswatch.no', opener: { closed: false, postMessage() {} } });
  assert.match(onWww.banner(), /asking BarentsWatch/, 'Min side on www works too');
});

test('the device decides the suggested way', () => {
  const iphone = deviceInfo({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' });
  assert.equal(iphone.method, 'shortcut');
  const ipad = deviceInfo({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 });
  assert.equal(ipad.method, 'shortcut');
  const mac = deviceInfo({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 });
  assert.deepEqual([mac.method, mac.apple, mac.os], ['bookmark', true, 'mac']);
  const win = deviceInfo({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
  assert.deepEqual([win.method, win.apple, win.os], ['bookmark', false, 'windows']);
  assert.equal(deviceInfo({ userAgent: 'Mozilla/5.0 (Linux; Android 15)' }).method, 'bookmark');
});

test('terminal commands use the curl that comes with Windows and macOS, and copy the answer', () => {
  const c = { clientId: 'me@x.no:rudder', clientSecret: "a'b$c" };
  const w = tokenCommand(c, 'windows');
  assert.ok(w.startsWith('curl.exe '), 'curl.exe, not PowerShell\'s curl alias');
  assert.ok(w.endsWith('| clip'));
  assert.ok(w.includes('"client_id=me@x.no:rudder"'));
  const m = tokenCommand(c, 'mac');
  assert.ok(m.startsWith('curl ') && m.endsWith('| pbcopy'));
  assert.ok(m.includes(`'client_secret=a'\\''b$c'`), 'single quotes keep $ and quote the quote');
  assert.ok(tokenCommand({}, 'mac').includes('YOUR_CLIENT_ID'));
});

test('bookmark answers become a token or a clear message', () => {
  assert.deepEqual(readBookmarkResult({ result: JSON.stringify({ access_token: JWT, expires_in: 3600 }) }), { status: 'ok', token: JWT });
  assert.match(readBookmarkResult({ result: '{"error":"invalid_client"}' }).message, /did not accept/);
  assert.match(readBookmarkResult({ result: '{"error":"invalid_scope"}' }).message, /AIS - API/);
  assert.match(readBookmarkResult({ error: 'Failed to fetch' }).message, /Failed to fetch/);
  assert.equal(readBookmarkResult({ result: '<html>' }).status, 'error');
});

test('Rudder opens Min side, answers only that window on BarentsWatch, and takes one result', () => {
  const posted = [];
  const popup = { postMessage: (m, o) => posted.push([m, o]) };
  const listeners = new Set();
  let opened;
  const win = {
    open: (u, name) => { opened = [u, name]; return popup; },
    addEventListener: (t, f) => listeners.add(f),
    removeEventListener: (t, f) => listeners.delete(f),
  };
  const results = [];
  startBookmarkLogin({ win, getCreds: () => ({ clientId: 'id', clientSecret: 'sec' }), onResult: (r) => results.push(r), timeoutMs: 1e6 });
  assert.equal(opened[0], BW_LOGIN_PAGE);
  const send = (e) => [...listeners].forEach((f) => f(e));
  send({ origin: 'https://evil.example', source: popup, data: { rudderBw: 1, hello: 1 } });
  send({ origin: BW_ORIGIN, source: {}, data: { rudderBw: 1, hello: 1 } });
  assert.equal(posted.length, 0, 'nothing for other sites or other BarentsWatch windows');
  send({ origin: BW_ORIGIN, source: popup, data: { rudderBw: 1, hello: 1 } });
  assert.deepEqual(posted, [[{ rudderCreds: 1, id: 'id', secret: 'sec' }, BW_ORIGIN]]);
  send({ origin: BW_ORIGIN, source: popup, data: { rudderBw: 1, result: JSON.stringify({ access_token: JWT }) } });
  assert.deepEqual(results, [{ status: 'ok', token: JWT }]);
  assert.equal(listeners.size, 0, 'stops listening after the result');
  assert.throws(() => startBookmarkLogin({ win: { ...win, open: () => null }, getCreds() {}, onResult() {} }), /blocked/);
});
