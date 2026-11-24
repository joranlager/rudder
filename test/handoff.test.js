import { test } from 'node:test';
import assert from 'node:assert/strict';
import { returnUrl, shortcutUrl, tokenFromResult, readHandoff, SHORTCUT_NAME } from '../public/handoff.js';

const PAGE = 'https://joranlager.github.io/rudder/#at=11.5/59.05/9.72';
const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjE5MDAwMDAwMDB9.c2lnbmF0dXJlLXNpZ25hdHVyZQ';

test('Shortcuts comes back to Rudder, with the chart position in the query (Shortcuts appends to it)', () => {
  assert.equal(returnUrl(PAGE, 'ok'), 'https://joranlager.github.io/rudder/?bwtoken=ok&at=11.5%2F59.05%2F9.72');
  const u = new URL(shortcutUrl(PAGE).replace('shortcuts://', 'https://'));
  assert.equal(u.hostname, 'x-callback-url');
  assert.equal(u.pathname, '/run-shortcut');
  assert.equal(u.searchParams.get('name'), SHORTCUT_NAME);
  assert.ok(!shortcutUrl(PAGE).includes('+'), 'spaces as %20, which Shortcuts reads');
  assert.equal(u.searchParams.get('x-success'), returnUrl(PAGE, 'ok'));
  assert.equal(u.searchParams.get('x-cancel'), returnUrl(PAGE, 'cancel'));
  assert.equal(u.searchParams.get('x-error'), returnUrl(PAGE, 'error'));
});

test('the token is read from the bare token, "Bearer …" or the whole JSON answer', () => {
  assert.equal(tokenFromResult(JWT), JWT);
  assert.equal(tokenFromResult(` Bearer ${JWT}\n`), JWT);
  assert.equal(tokenFromResult(JSON.stringify({ access_token: JWT, expires_in: 3600 })), JWT);
  assert.throws(() => tokenFromResult(JSON.stringify({ error: 'invalid_client' })), /invalid_client/);
  assert.equal(tokenFromResult(''), null);
  assert.equal(tokenFromResult('Dictionary'), null);
});

test('a return from Shortcuts gives the token and a clean address with the chart position', () => {
  const h = readHandoff(`${returnUrl(PAGE, 'ok')}&result=${encodeURIComponent(JWT)}`);
  assert.deepEqual(h, { cleanUrl: 'https://joranlager.github.io/rudder/#at=11.5/59.05/9.72', status: 'ok', token: JWT });
});

test('cancel, errors and a missing token are reported, never saved', () => {
  assert.equal(readHandoff(returnUrl(PAGE, 'cancel')).status, 'cancel');
  const e = readHandoff(`${returnUrl(PAGE, 'error')}&errorMessage=${encodeURIComponent('Shortcut not found')}`);
  assert.equal(e.status, 'error');
  assert.match(e.message, /Shortcut not found/);
  assert.equal(readHandoff(`${returnUrl(PAGE, 'ok')}&result=`).status, 'error');
  assert.match(readHandoff(`${returnUrl(PAGE, 'ok')}&result=${encodeURIComponent('{"error":"invalid_client"}')}`).message, /invalid_client/);
  assert.equal(readHandoff(PAGE), null, 'an ordinary visit');
});
