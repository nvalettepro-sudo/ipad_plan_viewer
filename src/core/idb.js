/**
 * Mini-wrapper IndexedDB (aucune dépendance).
 *
 * Trois magasins :
 *  - `plans`    : le PDF d'origine + ses métadonnées (écrit une fois à l'import)
 *  - `layers`   : les annotations (réécrites à chaque sauvegarde automatique)
 *  - `settings` : préférences et configuration Google
 *
 * Séparer les calques du PDF évite de réécrire plusieurs Mo à chaque
 * déplacement d'un meuble.
 */

const DB_NAME = 'plan-viewer';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('plans')) {
        db.createObjectStore('plans', { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('layers')) {
        db.createObjectStore('layers', { keyPath: 'planId' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Base de données bloquée par un autre onglet.'));
  });
  return dbPromise;
}

async function tx(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    let result;
    try {
      result = fn(store);
    } catch (err) {
      reject(err);
      return;
    }
    transaction.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Transaction annulée'));
  });
}

export const idb = {
  get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
  put: (store, value) => tx(store, 'readwrite', (s) => s.put(value)),
  delete: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
  getAll: (store) => tx(store, 'readonly', (s) => s.getAll()),
  count: (store) => tx(store, 'readonly', (s) => s.count()),
};

/** Lit une préférence, avec valeur par défaut. */
export async function getSetting(key, fallback = null) {
  const row = await idb.get('settings', key);
  return row ? row.value : fallback;
}

/** Écrit une préférence. */
export function setSetting(key, value) {
  return idb.put('settings', { key, value });
}

/**
 * Demande le stockage persistant.
 *
 * Contrainte iPad n°1 : sans ça, Safari purge IndexedDB après 7 jours
 * d'inactivité. La demande n'est réellement accordée qu'en mode standalone
 * (app installée sur l'écran d'accueil).
 */
export async function requestPersistence() {
  if (!navigator.storage?.persist) return { supported: false, persisted: false };
  try {
    const already = await navigator.storage.persisted();
    const persisted = already || (await navigator.storage.persist());
    return { supported: true, persisted };
  } catch {
    return { supported: true, persisted: false };
  }
}

/** Estimation d'occupation, pour l'écran « État du stockage ». */
export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  try {
    return await navigator.storage.estimate();
  } catch {
    return null;
  }
}
