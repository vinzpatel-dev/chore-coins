/* Chore Coins service worker */
const VERSION = 'cc-v2-1';
const SHELL = 'cc-shell-' + VERSION;
const RUNTIME = 'cc-runtime-' + VERSION;

const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/favicon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== SHELL && k !== RUNTIME).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never cache Supabase API / realtime traffic
  if (url.hostname.endsWith('supabase.co')) return;

  // App navigations: network-first, fall back to cached shell (offline)
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('./index.html')));
    return;
  }

  // CDN modules + Google Fonts + own assets: stale-while-revalidate
  e.respondWith(
    caches.match(req).then(cached => {
      const network = fetch(req).then(res => {
        if (res && (res.ok || res.type === 'opaque')) {
          const copy = res.clone();
          caches.open(RUNTIME).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
