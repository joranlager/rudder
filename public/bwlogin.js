// Getting a BarentsWatch token on any device, with nothing installed.
//
// BarentsWatch's login server (id.barentswatch.no) only lets pages on https://www.barentswatch.no
// read its answers (CORS), so Rudder's page cannot log in itself, and WebAssembly would not help: it
// runs under the same browser rules. A page on the login server's own site can: to it the request is
// not cross-site at all, and its pages need no login to be shown (checked 2026-11-24). So:
//
//   1. Rudder opens https://id.barentswatch.no/ in a new window (and keeps a handle on it).
//   2. There, the user clicks a bookmark (a "bookmarklet": a javascript: link in the bookmarks bar).
//      It runs as part of that page, asks Rudder (its opener) for the client ID and secret, gets the
//      token from the login server, sends the answer back and closes the window.
//
// www.barentswatch.no/minside/ works too (its connect-src allows *.barentswatch.no). The login
// pages are sandboxed without modals, so the bookmark shows its messages as a banner, not alert().
//
// The bookmark holds no secret and is the same for everyone using this copy of Rudder (it only names
// Rudder's origin). Rudder answers only the window it opened, and only when it is on
// www.barentswatch.no; the bookmark only talks to Rudder's origin. Works in Chrome, Edge, Firefox
// and Safari on Windows, macOS and Linux, and in Chrome on Android (run from the address bar).
//
// A second way without installing anything: curl, which comes with Windows 10/11 and macOS, run in a
// terminal with the answer copied to the clipboard (tokenCommand), then pasted into Rudder.

import { tokenFromResult } from './handoff.js';

export const BW_ORIGINS = ['https://id.barentswatch.no', 'https://www.barentswatch.no'];
export const BW_LOGIN_PAGE = 'https://id.barentswatch.no/';
export const TOKEN_ENDPOINT = 'https://id.barentswatch.no/connect/token';
export const BOOKMARK_NAME = 'Rudder token';

/** The bookmarklet for a copy of Rudder served from `rudderOrigin` (for example https://joranlager.github.io). */
export function bookmarkletUrl(rudderOrigin) {
  const R = JSON.stringify(new URL(rudderOrigin).origin);
  // say(): a banner at the top of the page (the login pages block alert()). Click it, or its ×, to
  // close it; messages about using the bookmark in the wrong place also close by themselves.
  const src = `(()=>{const R=${R},o=window.opener,say=(m,ms)=>{let b=document.getElementById('rudder-bw');if(b)b.remove();
b=document.createElement('div');b.id='rudder-bw';b.title='Close';b.onclick=()=>b.remove();
b.style.cssText='position:fixed;z-index:2147483647;top:0;left:0;right:0;padding:14px 48px 14px 18px;background:#0b2236;color:#fff;font:16px/1.4 system-ui,sans-serif;cursor:pointer';
const x=document.createElement('span');x.textContent='×';x.style.cssText='position:absolute;right:18px;top:8px;font-size:26px';
b.append('Rudder token: '+m,x);document.body.appendChild(b);if(ms)setTimeout(()=>b.remove(),ms)};
if(location.origin===R){dispatchEvent(new CustomEvent('rudder-bookmark'));return}
if(!${JSON.stringify(BW_ORIGINS)}.includes(location.origin))return say('click this on BarentsWatch, in the window Rudder opened.',8e3);
if(!o||o.closed)return say('open BarentsWatch from Rudder (Settings, Get token from BarentsWatch), then click this bookmark there.',12e3);
const send=m=>o.postMessage(Object.assign({rudderBw:1},m),R);
say('asking BarentsWatch for a token…');
const h=async e=>{if(e.origin!==R||e.source!==o||!e.data||!e.data.rudderCreds)return;removeEventListener('message',h);
try{const r=await fetch(${JSON.stringify(TOKEN_ENDPOINT)},{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
body:new URLSearchParams({grant_type:'client_credentials',client_id:e.data.id,client_secret:e.data.secret,scope:'ais'})});
const t=await r.text();send({result:t});if(r.ok){say('done. Back to Rudder.');setTimeout(()=>close(),400)}else say('BarentsWatch said '+t)}
catch(x){send({error:String(x&&x.message||x)});say('could not reach the login server from this page ('+(x&&x.message||x)+').')}};
addEventListener('message',h);send({hello:1})})()`;
  return `javascript:${encodeURIComponent(src.replace(/\n/g, ''))}`;
}

/** Which way to get a token suits this device: Shortcuts on iPhone and iPad, the bookmark elsewhere. */
export function deviceInfo(nav = globalThis.navigator ?? {}) {
  const ua = nav.userAgent ?? '';
  const ios = /iPhone|iPad|iPod/.test(ua) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  const mac = !ios && /Macintosh|Mac OS X/.test(ua);
  const windows = /Windows/.test(ua);
  const android = /Android/.test(ua);
  return { ios, mac, windows, android, apple: ios || mac, method: ios ? 'shortcut' : 'bookmark', os: mac ? 'mac' : windows ? 'windows' : 'other' };
}

/**
 * A terminal command that gets a token and copies BarentsWatch's answer to the clipboard.
 * Windows (PowerShell or Command Prompt) uses curl.exe and clip; macOS uses curl and pbcopy.
 */
export function tokenCommand({ clientId = '', clientSecret = '' } = {}, os = 'windows') {
  const id = clientId || 'YOUR_CLIENT_ID', secret = clientSecret || 'YOUR_SECRET';
  if (os === 'mac') {
    const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    return `curl -s -d grant_type=client_credentials --data-urlencode ${q(`client_id=${id}`)} --data-urlencode ${q(`client_secret=${secret}`)} -d scope=ais ${TOKEN_ENDPOINT} | pbcopy`;
  }
  const q = (s) => `"${String(s).replace(/"/g, '')}"`;
  return `curl.exe -s -d grant_type=client_credentials --data-urlencode ${q(`client_id=${id}`)} --data-urlencode ${q(`client_secret=${secret}`)} -d scope=ais ${TOKEN_ENDPOINT} | clip`;
}

/** Turn the bookmarklet's message into { status, token | message }, like a return from Shortcuts. */
export function readBookmarkResult(data) {
  if (data?.error) return { status: 'error', message: `The bookmark could not reach BarentsWatch's login server (${data.error}). Click it on the BarentsWatch window Rudder opened.` };
  try {
    const token = tokenFromResult(data?.result);
    if (token) return { status: 'ok', token };
  } catch (e) {
    return { status: 'error', message: e.message === 'invalid_client'
      ? 'BarentsWatch did not accept the client ID or secret saved in Rudder.'
      : e.message === 'invalid_scope' ? 'This client may not read AIS. Create an "AIS - API" client on Min side.'
        : `BarentsWatch refused the login (${e.message}).` };
  }
  return { status: 'error', message: 'BarentsWatch did not return a token.' };
}

/**
 * Open BarentsWatch's login site and wait for the bookmark. `getCreds()` gives { clientId, clientSecret };
 * `onResult` gets { status, token | message } once. Returns { stop } (or throws if the window was blocked).
 */
export function startBookmarkLogin({ getCreds, onResult, onHello = () => {}, win = globalThis.window, timeoutMs = 20 * 60e3 }) {
  const popup = win.open(BW_LOGIN_PAGE, 'rudder-barentswatch');
  if (!popup) throw new Error('The browser blocked the BarentsWatch window. Allow pop-ups for Rudder (the icon at the right of the address bar), then try again.');
  let done = false;
  const stop = () => { done = true; win.removeEventListener('message', onMessage); clearTimeout(timer); };
  function onMessage(e) {
    if (done || !BW_ORIGINS.includes(e.origin) || e.source !== popup || !e.data?.rudderBw) return;
    if (e.data.hello) {
      const c = getCreds();
      onHello();
      popup.postMessage({ rudderCreds: 1, id: c.clientId, secret: c.clientSecret }, e.origin);
      return;
    }
    stop();
    onResult(readBookmarkResult(e.data));
  }
  const timer = setTimeout(stop, timeoutMs);
  win.addEventListener('message', onMessage);
  return { stop, popup };
}
