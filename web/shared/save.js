/* Saves for the kids' apps.
   The apps were written for claude.ai, where window.claude.use('db') and use('user') give
   each viewer a private document store. This file provides the same small API backed by
   this server, so the apps' own sync code (local copy first, server copy as backup, merge
   on conflict) runs unchanged.

   Identity is a save code such as OTTER-4821, kept in localStorage. The server issues one
   the first time a device connects. Entering the same code on another device loads that
   save there. Each app (<html data-app="...">) has its own codes and its own database. */
(function () {
  'use strict';
  const APP = document.documentElement.dataset.app;
  const API = '/' + APP + '/api';
  const CODE_KEY = APP + ':save-code';
  // localStorage keys each app owns, cleared when the device switches to another save.
  // Prefixes must not match CODE_KEY (e.g. 'signal:save-code'), or switching would forget the new code.
  const OWNED = { dm: ['pda-'], chain: ['chain-reaction'], signal: ['signal:v'] }[APP] || [];
  const POLL_MS = 20000;
  const CODE_RE = /^[A-Z]{3,8}-\d{4}$/;

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  function normalize(raw) {
    const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const m = s.match(/^([A-Z]{3,8})(\d{4})$/);
    return m ? m[1] + '-' + m[2] : '';
  }

  function err(code, message) { const e = new Error(message || code); e.code = code; return e; }

  async function call(method, path, body) {
    let res;
    try {
      res = await fetch(API + path, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
        keepalive: method === 'PUT',
      });
    } catch (e) { throw err('unavailable'); }
    if (res.status === 429) throw err('resource_exhausted');
    return res;
  }

  async function codeExists(code) {
    const res = await call('GET', '/codes/' + encodeURIComponent(code));
    if (res.ok) return true;
    if (res.status === 404) return false;
    throw err('unavailable');
  }

  // A home-screen app on iOS starts with empty storage, separate from Safari's. The manifest's
  // start_url carries the code (see linkManifest), so the installed app picks up the same save.
  let codeP = null;
  function ensureCode() {
    if (codeP) return codeP;
    codeP = (async () => {
      const url = new URL(location.href);
      const fromUrl = normalize(url.searchParams.get('code'));
      if (url.searchParams.has('code')) {
        url.searchParams.delete('code');
        history.replaceState(history.state, '', url.pathname + url.search + url.hash);
      }
      let code = lsGet(CODE_KEY);
      if (!code && fromUrl && await codeExists(fromUrl)) { code = fromUrl; lsSet(CODE_KEY, code); }
      if (!code) {
        const res = await call('POST', '/codes');
        if (!res.ok) throw err(res.status === 429 ? 'resource_exhausted' : 'unavailable');
        code = (await res.json()).code;
        lsSet(CODE_KEY, code);
      }
      linkManifest(code);
      return code;
    })();
    codeP.catch(() => { codeP = null; });
    return codeP;
  }

  function linkManifest(code) {
    const link = document.querySelector('link[rel="manifest"]');
    if (link) link.href = 'manifest.webmanifest?code=' + encodeURIComponent(code);
  }

  function snapshot(data) {
    return { exists: data !== undefined, data: () => data, metadata: { hasPendingWrites: false } };
  }

  function doc(path) {
    // Paths look like data/users/<code>/<doc>, as the apps build them from user.id().
    const parts = String(path).split('/');
    const code = parts[2], name = parts[3];
    const url = '/saves/' + encodeURIComponent(code) + '/' + encodeURIComponent(name);
    let lastText = null;

    async function read() {
      const res = await call('GET', url);
      if (res.status === 404) { lastText = ''; return undefined; }
      if (!res.ok) throw err('unavailable');
      const text = await res.text();
      lastText = text;
      return JSON.parse(text);
    }

    const ref = {
      async get() { return snapshot(await read()); },
      async set(data) {
        const res = await call('PUT', url, data);
        if (res.status === 404) throw err('not_granted', 'unknown save code');
        if (!res.ok) throw err(res.status >= 500 ? 'unavailable' : 'invalid_argument');
        lastText = JSON.stringify(data);
      },
      async update(fields) {
        const cur = (await read()) || {};
        await ref.set(Object.assign(cur, fields));
      },
      // Polls while the app is on screen, and checks right away when it comes back to the
      // front, which is when another device's progress matters.
      onSnapshot(cb, onError) {
        let stopped = false, timer = 0;
        const tick = async () => {
          clearTimeout(timer);
          if (stopped) return;
          if (document.visibilityState === 'visible') {
            try {
              const before = lastText;
              const data = await read();
              if (!stopped && lastText !== before) cb(snapshot(data));
            } catch (e) { /* offline: try again next tick */ }
          }
          if (!stopped) timer = setTimeout(tick, POLL_MS);
        };
        const wake = () => { if (document.visibilityState === 'visible') tick(); };
        document.addEventListener('visibilitychange', wake);
        addEventListener('online', wake);
        addEventListener('focus', wake);
        timer = setTimeout(tick, POLL_MS);
        return () => {
          stopped = true; clearTimeout(timer);
          document.removeEventListener('visibilitychange', wake);
          removeEventListener('online', wake);
          removeEventListener('focus', wake);
        };
      },
    };
    return ref;
  }

  const db = { doc };
  const user = { id: ensureCode };

  window.claude = {
    async use(name) {
      if (name === 'db') return db;
      if (name === 'user') return user;
      throw err('not_granted');
    },
  };

  // For the apps' parent screens.
  window.KidSave = {
    code: () => lsGet(CODE_KEY) || '',
    normalize,
    // Point this device at another save. Resolves only if the code exists; then reloads.
    async switchTo(raw) {
      const code = normalize(raw);
      if (!CODE_RE.test(code)) throw err('invalid_argument', 'Codes look like OTTER-4821.');
      if (code === lsGet(CODE_KEY)) throw err('invalid_argument', 'This device already uses that code.');
      let ok;
      try { ok = await codeExists(code); } catch (e) { throw err(e.code, 'Could not reach the server. Try again when online.'); }
      if (!ok) throw err('not_found', 'No save has that code.');
      try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const k = localStorage.key(i);
          if (k && OWNED.some(p => k.startsWith(p))) localStorage.removeItem(k);
        }
      } catch (e) {}
      lsSet(CODE_KEY, code);
      location.reload();
    },
  };

  const known = lsGet(CODE_KEY);
  if (known) linkManifest(known);

  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (e) {}
  if ('serviceWorker' in navigator) {
    addEventListener('load', () => { navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {}); });
  }
})();
