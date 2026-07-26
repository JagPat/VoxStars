/* Keep only the static app shell available offline. API responses and player
   data are deliberately never stored here; live/cached team state remains in
   the app's existing authenticated API + localStorage flow. */
const SHELL_CACHE = 'voxstars-shell-v2';
const SHELL_FILES = ['/index.html', '/app-core.js', '/competitor-core.js'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(key => key.startsWith('voxstars-shell-') && key !== SHELL_CACHE)
        .map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

async function shellFromNetwork(request, cacheKey) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(cacheKey, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await caches.match(cacheKey);
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(shellFromNetwork(request, '/index.html'));
  } else if (SHELL_FILES.includes(url.pathname)) {
    event.respondWith(shellFromNetwork(request, url.pathname));
  }
});
