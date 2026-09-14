// sw.js — No-op, kept to satisfy any existing registrations
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());
