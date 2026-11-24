import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCredentials, saveCredentials, clearCredentials, accessKind } from '../public/credentials.js';

const memory = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
};

test('nothing saved reads as empty', () => {
  assert.deepEqual(loadCredentials(memory()), { clientId: '', clientSecret: '', pasted: '', savedAt: null });
  assert.equal(accessKind(loadCredentials(memory())), null);
});

test('credentials are saved trimmed, with the time, and read back', () => {
  const s = memory();
  saveCredentials({ clientId: ' me@example.com:rudder ', clientSecret: ' pw\n' }, s, 1000);
  assert.deepEqual(loadCredentials(s), { clientId: 'me@example.com:rudder', clientSecret: 'pw', pasted: '', savedAt: 1000 });
  assert.equal(accessKind(loadCredentials(s)), 'client');
  clearCredentials(s);
  assert.equal(accessKind(loadCredentials(s)), null);
});

test('a pasted token counts as access when no client is set', () => {
  const s = memory();
  saveCredentials({ pasted: 'eyJ.abc.def' }, s);
  assert.equal(accessKind(loadCredentials(s)), 'token');
  assert.equal(accessKind({ clientId: 'a', clientSecret: '', pasted: '' }), null, 'an ID without its secret is not enough');
});

test('credentials from the first AIS build move to their own place, keeping the layer switch', () => {
  const s = memory({ 'rudder.ais.v1': JSON.stringify({ on: true, clientId: 'me:rudder', clientSecret: 'pw', pasted: '' }) });
  const c = loadCredentials(s);
  assert.equal(c.clientId, 'me:rudder');
  assert.equal(c.clientSecret, 'pw');
  assert.deepEqual(JSON.parse(s.getItem('rudder.ais.v1')), { on: true }, 'no secret left in the layer settings');
  assert.equal(JSON.parse(s.getItem('rudder.barentswatch.v1')).clientId, 'me:rudder');
});

test('damaged storage reads as empty instead of breaking the app', () => {
  assert.equal(loadCredentials(memory({ 'rudder.barentswatch.v1': '{not json' })).clientId, '');
});
