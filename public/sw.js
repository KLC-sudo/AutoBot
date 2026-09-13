// sw.js — Cache-clearing service worker
// This unregisters itself and clears all caches on load
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => {
      return Promise.all(
        names.map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});
