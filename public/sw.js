// DJ Stream Service Worker
const CACHE = 'djstream-v5';

// Static assets to pre-cache on install
const PRECACHE = [
  '/watch.html',
  '/profile.html',
  '/offline.html',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Only handle GET from same origin
  if (e.request.method !== 'GET') return;
  if (!e.request.url.startsWith(self.location.origin)) return;

  const { pathname } = new URL(e.request.url);

  // Never cache API responses, live HLS streams, or icon/favicon files
  if (pathname.startsWith('/api/') ||
      pathname.startsWith('/live/') ||
      pathname.startsWith('/ws')   ||
      pathname === '/favicon.ico'  ||
      pathname === '/icon.svg'     ||
      pathname === '/icon-192.png' ||
      pathname === '/icon-512.png') return;

  // Network-first for HTML pages (always fresh), cache-first for assets
  const isHtml = pathname.endsWith('.html') || pathname === '/';
  if (isHtml) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(e.request).then(cached => cached || caches.match('/offline.html')))
    );
  } else {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        }).catch(() => new Response('', { status: 404, statusText: 'Not Found' }));
      })
    );
  }
});

// ── Push notification handler ──────────────────────────────────────────────
self.addEventListener('push', e => {
  if (!e.data) return;
  try {
    const { title, body, url } = e.data.json();
    e.waitUntil(
      self.registration.showNotification(title || 'DJ Stream', {
        body:    body  || 'The stream is live!',
        icon:    '/icon.svg',
        badge:   '/icon.svg',
        data:    { url: url || '/watch.html' },
        vibrate: [200, 100, 200],
      })
    );
  } catch {}
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/watch.html';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => {
        for (const c of clients) {
          if (c.url.includes(url) && 'focus' in c) return c.focus();
        }
        if (self.clients.openWindow) return self.clients.openWindow(url);
      })
  );
});
