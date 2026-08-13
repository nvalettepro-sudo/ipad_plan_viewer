/**
 * Enregistrement du service worker et détection des mises à jour.
 *
 * Piège PWA classique : une fois installée, l'app continue de servir la version
 * en cache même après un déploiement. On ne fait donc jamais de rechargement
 * silencieux : la nouvelle version reste en attente (`waiting`) et un bandeau
 * « Mise à jour disponible » laisse l'utilisateur décider — pattern
 * `updatefound` + `skipWaiting`.
 */

const CHECK_INTERVAL_MS = 30 * 60 * 1000;

export function isStandalone() {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}

/**
 * @param {{onUpdateReady: () => void, onVersion?: (v: string) => void}} handlers
 * @returns {{applyUpdate: () => void, checkNow: () => void}}
 */
export function registerServiceWorker({ onUpdateReady, onVersion }) {
  const noop = { applyUpdate() {}, checkNow() {} };
  if (!('serviceWorker' in navigator)) return noop;
  // En développement (vite dev), aucun sw.js n'est généré.
  if (import.meta.env.DEV) return noop;

  let registration = null;
  let waiting = null;
  let reloading = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });

  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'VERSION') onVersion?.(event.data.version);
  });

  const track = (worker) => {
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      // `controller` présent = une version tournait déjà : c'est bien une mise
      // à jour, pas la première installation.
      if (worker.state === 'installed' && navigator.serviceWorker.controller) {
        waiting = worker;
        onUpdateReady();
      }
    });
  };

  navigator.serviceWorker
    .register(`${__APP_BASE__}sw.js`, { scope: __APP_BASE__ })
    .then((reg) => {
      registration = reg;
      if (reg.waiting && navigator.serviceWorker.controller) {
        waiting = reg.waiting;
        onUpdateReady();
      }
      track(reg.installing);
      reg.addEventListener('updatefound', () => track(reg.installing));
      navigator.serviceWorker.controller?.postMessage('GET_VERSION');
    })
    .catch((err) => console.warn('Service worker non enregistré', err));

  const checkNow = () => registration?.update().catch(() => {});

  // Nouvelle version détectée au retour dans l'app (cas d'usage principal :
  // on rouvre l'app sur l'iPad après un `git push`).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkNow();
  });
  setInterval(checkNow, CHECK_INTERVAL_MS);

  return {
    applyUpdate() {
      const target = waiting || registration?.waiting;
      if (target) target.postMessage('SKIP_WAITING');
      else window.location.reload();
    },
    checkNow,
  };
}
