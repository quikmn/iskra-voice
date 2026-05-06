const CACHE = 'iskra-v1';
const SHELL = ['/index.html', '/manifest.json'];

self.addEventListener('install', e => e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL))
));

self.addEventListener('activate', e => e.waitUntil(
    caches.keys().then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    ))
));

self.addEventListener('fetch', e => {
    if (e.request.method !== 'GET') return;
    e.respondWith(
        caches.match(e.request).then(r => r || fetch(e.request))
    );
});
