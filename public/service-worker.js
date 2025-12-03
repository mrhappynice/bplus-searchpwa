const CACHE_NAME = 'bplus-v1';
const ASSETS = [
  './',
  './index.html',
  './pwa-logic.js',
  './sqlite3.js',
  './sqlite3.wasm',
  'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js',
  'https://cdn.jsdelivr.net/npm/marked/marked.min.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('fetch', (e) => {
  // Network first, fall back to cache (good for dev, safe for offline)
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});