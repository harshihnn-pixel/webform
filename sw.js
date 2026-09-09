/**
 * sw.js
 * Service worker for the CFF PWA.
 *
 * Strategy:
 * - App shell (HTML/CSS/JS/icons/fonts): cache-first, so the app still opens
 *   and is fully navigable offline or on a flaky connection.
 * - /api/* requests: always network, NEVER cached — these are live AI calls
 *   and must never serve stale or fake data.
 * - Bumping CACHE_VERSION below forces every client to fetch fresh assets
 *   on next load (old caches are deleted in the 'activate' step).
 */

const CACHE_VERSION = 'cff-v3';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/storage.js',
  './js/auth.js',
  './js/api.js',
  './js/app.js',
  './js/ai-widget.js',
  './vendor/supabase.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

/*
 * Paths that must always come from the network first.
 *
 * js/config.js is generated per-request by the server and carries the
 * Supabase project URL and publishable key. Serving a cached copy after a
 * key rotation or a fresh deploy would silently break login, so it gets a
 * network-first strategy with the cache only as an offline fallback.
 */
const NETWORK_FIRST = ['/js/config.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).catch((err) => {
      // Don't let a single missing/blocked asset stop the whole install —
      // log it and continue, the fetch handler will fall back to network.
      console.warn('CFF SW: some app-shell assets failed to precache', err);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Never intercept or cache API calls — always go straight to the network
  // so AI analysis and chat replies are always live.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(req));
    return;
  }

  // Only handle same-origin GET requests for the app shell.
  if (req.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  // Network-first for runtime-generated config.
  if (NETWORK_FIRST.includes(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached); // offline — fall back to whatever we have cached

      // Cache-first for instant loads; refresh the cache in the background.
      return cached || networkFetch;
    })
  );
});
