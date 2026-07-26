const CACHE_NAME = 'zk-fitness-v1';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './exercises.js',
  './lib/fitness.js',
  './vendor/argon2.min.js',
  './vendor/noble-pqc.js',
  './icon-192.png',
  './icon-512.png',
  '../assets/favicon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE)).catch((err) => {
      console.error('ZK Fitness service worker cache prep failed', err);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // SECURITY: Never cache or intercept API requests. This is a zero-knowledge
  // app; encrypted blobs and auth material must not be stored by the service worker.
  if (url.pathname.includes('/api/')) {
    return;
  }

  // Only cache GET requests for the app shell. Everything else goes straight to the network.
  if (request.method !== 'GET') {
    return;
  }

  event.respondWith(
    fetch(request)
      .then(async (response) => {
        if (response.ok) {
          const clone = response.clone();
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, clone);
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});
