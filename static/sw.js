// Served at /sw.js (app.py service_worker) so it controls the whole app.
// Bump CACHE when the list of shell files changes.
const CACHE = 'shiloh-v2';
const SHELL = [
  '/',
  '/static/css/app.css',
  '/static/js/app.js',
  '/static/manifest.json',
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // API: always the network - never stale bills or sign-in state
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(JSON.stringify({ status: 'error', message: "You're offline. Please reconnect and try again." }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }))
    );
    return;
  }

  // Shell & static files: network first so a deploy shows up on the next open; the cache is
  // only the offline fallback. Any app page (/join/CODE ...) falls back to the cached shell.
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok && (url.pathname === '/' || url.pathname.startsWith('/static/'))) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request).then(hit => hit || caches.match('/')))
  );
});

// Web Push (sent by app.py send_push): show it like the bell would
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) { data = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(data.title || 'Shiloh Living', {
    body: data.body || '',
    icon: '/static/icons/icon-192.png',
    badge: '/static/icons/icon-192.png',
    tag: data.id ? 'n' + data.id : undefined,
    data: { page: data.page || '', id: data.id || null },
  }));
});

// Tapping it opens the page it's about, reusing an open Shiloh window if there is one
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const { page, id } = e.notification.data || {};
  const params = new URLSearchParams();
  if (page) params.set('open', page);
  if (id) params.set('notif', id);
  const target = new URL('/?' + params.toString(), self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find(w => new URL(w.url).origin === self.location.origin);
    if (win) {
      await win.focus();
      win.postMessage({ type: 'open-page', page, id });
      return;
    }
    return clients.openWindow(target);
  })());
});
