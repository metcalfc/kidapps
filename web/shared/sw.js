// Offline support for one app. The server puts VERSION, APP and PRECACHE above this line.
// Pages: network first, cached copy when offline. Everything else: cache first.
// Saves (/api/) never go through the cache.
const CACHE = APP + '-' + VERSION;
const SHELL = '/' + APP + '/';

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith(APP + '-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

function timeout(ms) { return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)); }

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.includes('/api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await Promise.race([fetch(req), timeout(4000)]);
        if (res.ok && url.pathname === SHELL) (await caches.open(CACHE)).put(SHELL, res.clone());
        return res;
      } catch (e) {
        return (await caches.match(SHELL)) || Response.error();
      }
    })());
    return;
  }

  if (url.pathname.endsWith('/manifest.webmanifest')) return;
  event.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
    return res;
  })());
});
