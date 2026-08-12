const CACHE_NAME = 'zk-fitness-v8';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './styles.css',
  './app.js',
  './config.js',
  './install.js',
  './exercises.js',
  './lib/crypto.js',
  './lib/db.js',
  './lib/fitness.js',
  './lib/workout.js',
  './vendor/argon2.min.js',
  './vendor/noble-pqc.js',
  './icon-192.png',
  './icon-512.png',
  './app-icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await Promise.all(ASSETS_TO_CACHE.map(async (asset) => {
        try {
          await cache.add(asset);
        } catch (error) {
          console.error(`ZK Fitness could not cache ${asset}`, error);
        }
      }));
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
  const isApiRequest = url.pathname === '/api' || url.pathname.startsWith('/api/');
  if (isApiRequest || url.origin !== self.location.origin) {
    return;
  }

  // Only cache navigations and static app-shell resources. Do not cache arbitrary
  // same-origin GET requests because future routes may contain sensitive data.
  const isFrontendNavigation = request.mode === 'navigate'
    && (url.pathname === '/frontend/' || url.pathname === '/frontend/index.html');
  const isStaticAssetRequest = ['script', 'style', 'image', 'font'].includes(request.destination);
  const isAppShellRequest = isFrontendNavigation || isStaticAssetRequest;
  if (request.method !== 'GET' || !isAppShellRequest) {
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
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      })
  );
});
