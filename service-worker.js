// Service Worker
const CACHE_NAME = 'lyrics-app-cache-v9';

// Same-origin files to precache (UI only)
const CRITICAL_FILES = [
  '/',              // shell
  '/index.html',
  '/playlist.html',
  '/src/index.js',
  '/src/playlist.js',
  '/favicon.svg'
];

// External CDN assets (best-effort caching; failures ignored)
const EXTERNAL_ASSETS = [
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore-compat.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    // 1) Precache local assets
    await cache.addAll(CRITICAL_FILES);

    // 2) Try to cache externals individually; ignore failures
    await Promise.allSettled(EXTERNAL_ASSETS.map(async (url) => {
      try {
        const resp = await fetch(url, { mode: 'no-cors', credentials: 'omit' });
        if (resp && (resp.ok || resp.type === 'opaque')) {
          await cache.put(url, resp.clone());
        }
      } catch {}
    }));

    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.map((k) => (k === CACHE_NAME ? Promise.resolve() : caches.delete(k)))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // --- Always network (no cache) for admin.html (any querystring) ---
  if (
    sameOrigin &&
    url.pathname === '/admin.html' &&
    (req.mode === 'navigate' || req.destination === 'document' || req.method === 'GET')
  ) {
    event.respondWith(
      fetch(req, { cache: 'no-store' }).catch(async () => {
        // Offline fallback to shell
        const fallback = await caches.match('/index.html');
        return fallback || new Response('Offline', { status: 503 });
      })
    );
    return;
  }

  // --- Never cache API calls; go straight to network ---
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(req, { cache: 'no-store' }).catch(() => new Response('Offline', { status: 503 }))
    );
    return;
  }

  // --- Let Firebase/Firestore traffic bypass the SW cache logic entirely ---
  const isFirebaseNetwork =
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('gstatic.com') ||
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('googleusercontent.com');
  if (isFirebaseNetwork) {
    // Don’t interfere with SDK’s own offline/online handling
    return; // browser handles normally
  }

  // Only cache GET requests for same-origin UI assets
  if (req.method !== 'GET') return;

  event.respondWith((async () => {
    // 1) Cache-first for UI assets
    const cached = await caches.match(req);
    if (cached) return cached;

    // 2) Network, then stash successful same-origin responses
    try {
      const resp = await fetch(req);
      if (sameOrigin && resp && resp.ok) {
        const cache = await caches.open(CACHE_NAME);
        // Extra guard: don't cache admin or api dynamically
        if (url.pathname !== '/admin.html' && !url.pathname.startsWith('/api/')) {
          cache.put(req, resp.clone()).catch(() => {});
        }
      }
      return resp;
    } catch {
      // 3) Offline fallback: app shell
      if (sameOrigin) {
        const fallback = await caches.match('/index.html');
        if (fallback) return fallback;
      }
      return new Response('Offline', { status: 503 });
    }
  })());
});
