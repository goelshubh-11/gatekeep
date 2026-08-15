// Bump this version string whenever you deploy a meaningfully new
// version of the app shell, so installed devices pick up the update
// instead of serving a stale cached copy.
const CACHE_NAME = 'gatekeep-shell-v1';

const SHELL_FILES = [
  '/',
  '/jsQR.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls - always go live, this is where actual
  // roster/scan/auth data lives and must never be served stale.
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Network-first for the app shell, so a normal deploy is picked up
  // immediately when online; falls back to cache only when offline.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
