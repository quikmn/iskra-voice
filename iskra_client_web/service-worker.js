const CACHE = 'iskra-v3';
const SHELL = ['/index.html', '/manifest.json'];

self.addEventListener('install', e => e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
));

self.addEventListener('activate', e => e.waitUntil(
    caches.keys().then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
));

self.addEventListener('fetch', e => {
    if (e.request.method !== 'GET') return;
    // Network-first for HTML so updates are always picked up
    if (e.request.destination === 'document') {
        e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
        return;
    }
    e.respondWith(
        caches.match(e.request).then(r => r || fetch(e.request))
    );
});
