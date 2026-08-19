/* eslint-disable no-restricted-globals */
// Service worker généré au build par vite.config.js — ne pas éditer dist/sw.js à la main.

const VERSION = '__SW_VERSION__';
const BASE = '__SW_BASE__';
const CACHE = `plan-viewer-${VERSION}`;
const PRECACHE = "__SW_PRECACHE__";

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // `reload` évite de re-précacher depuis le cache HTTP du navigateur.
      await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })));
      // Pas de skipWaiting() ici : la nouvelle version attend que l'utilisateur
      // appuie sur le bandeau « Mise à jour disponible ».
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
  if (event.data === 'GET_VERSION') event.source?.postMessage({ type: 'VERSION', version: VERSION });
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // On ne touche pas au cross-origin : le cache ne couvre que l'app elle-même.
  if (url.origin !== self.location.origin) return;

  // Navigation : on sert l'app shell depuis le cache (mode standalone hors ligne),
  // avec repli réseau si le précache a échoué.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cached = await caches.match(BASE, { ignoreSearch: true });
        if (cached) return cached;
        try {
          return await fetch(request);
        } catch {
          return new Response('Hors ligne et aucune version en cache.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        }
      })(),
    );
    return;
  }

  // Assets : cache d'abord (les noms sont hashés au build), réseau en repli.
  event.respondWith(
    (async () => {
      const cached = await caches.match(request, { ignoreSearch: false });
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') {
        const cache = await caches.open(CACHE);
        cache.put(request, response.clone());
      }
      return response;
    })(),
  );
});
