/** Persistance des plans et de leurs calques d'annotations. */

import { uid } from './geometry.js';
import { idb } from './idb.js';
import { defaultScale } from './units.js';

export const LAYERS_VERSION = 2;

/**
 * Calque vierge d'une page.
 *
 * L'échelle est stockée **par page** : un carnet de détails mélange couramment
 * plusieurs échelles (un 1/10 en page 1, un 1/20 en page 2…). Une échelle
 * unique pour tout le document donnerait des cotes fausses sans prévenir.
 */
export function emptyPageLayer(scale = defaultScale()) {
  return { scale, view: null, measures: [], furniture: [] };
}

/** Calque vierge pour un plan qui vient d'être importé. */
export function emptyLayers(planId) {
  return {
    planId,
    version: LAYERS_VERSION,
    pageIndex: 0,
    unit: 'auto',
    pages: { 0: emptyPageLayer() },
    updatedAt: Date.now(),
  };
}

/**
 * Renvoie le calque d'une page, en le créant au besoin.
 * Une nouvelle page hérite de l'échelle de la page courante : c'est le point de
 * départ le plus probable, l'utilisateur ajuste ensuite si besoin.
 */
export function pageLayer(layers, index) {
  const key = String(index);
  if (!layers.pages[key]) {
    const current = layers.pages[String(layers.pageIndex)];
    layers.pages[key] = emptyPageLayer(structuredClone(current?.scale || defaultScale()));
  }
  return layers.pages[key];
}

/** Migre un calque enregistré par une version antérieure. */
function migrateLayers(layers, planId) {
  if (!layers) return emptyLayers(planId);
  if (layers.version === LAYERS_VERSION && layers.pages) return layers;

  // v1 : une seule échelle et une seule liste d'annotations pour tout le document.
  const index = layers.pageIndex ?? 0;
  return {
    planId,
    version: LAYERS_VERSION,
    pageIndex: index,
    unit: layers.unit || 'auto',
    pages: {
      [index]: {
        scale: layers.scale || defaultScale(),
        view: layers.view || null,
        measures: layers.measures || [],
        furniture: layers.furniture || [],
      },
    },
    updatedAt: layers.updatedAt || Date.now(),
  };
}

/**
 * Enregistre un PDF importé.
 * @param {{name:string, bytes:ArrayBuffer, source?:object, pageCount?:number}} input
 */
export async function createPlan({ name, bytes, source = { type: 'file' }, pageCount = 1 }) {
  const plan = {
    id: uid(),
    name,
    source,
    pageCount,
    bytes,
    size: bytes.byteLength,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await idb.put('plans', plan);
  const layers = emptyLayers(plan.id);
  await idb.put('layers', layers);
  return { plan, layers };
}

/** Liste les plans (sans les octets du PDF), du plus récent au plus ancien. */
export async function listPlans() {
  const plans = await idb.getAll('plans');
  return plans
    .map(({ bytes, ...meta }) => meta)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Charge un plan complet + ses calques. */
export async function loadPlan(id) {
  const plan = await idb.get('plans', id);
  if (!plan) return null;
  const layers = migrateLayers(await idb.get('layers', id), id);
  return { plan, layers };
}

/** Supprime un plan et ses annotations. */
export async function deletePlan(id) {
  await idb.delete('layers', id);
  await idb.delete('plans', id);
}

export async function renamePlan(id, name) {
  const plan = await idb.get('plans', id);
  if (!plan) return;
  plan.name = name;
  plan.updatedAt = Date.now();
  await idb.put('plans', plan);
}

/** Écrit les calques. `structuredClone` retire les éventuelles références vivantes. */
export async function saveLayers(layers) {
  const record = { ...layers, updatedAt: Date.now() };
  await idb.put('layers', structuredClone(record));
  const plan = await idb.get('plans', layers.planId);
  if (plan) {
    plan.updatedAt = record.updatedAt;
    await idb.put('plans', plan);
  }
  return record.updatedAt;
}

/**
 * Sauvegarde automatique différée : regroupe les modifications rapprochées
 * (déplacement d'un meuble au doigt = des dizaines d'événements).
 */
export function createAutosave(getLayers, { delay = 700, onState } = {}) {
  let timer = null;
  let pending = false;

  async function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!pending) return;
    pending = false;
    const layers = getLayers();
    if (!layers) return;
    onState?.('saving');
    try {
      await saveLayers(layers);
      onState?.('saved');
    } catch (err) {
      console.error('Échec de la sauvegarde', err);
      onState?.('error');
    }
  }

  return {
    schedule() {
      pending = true;
      onState?.('pending');
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, delay);
    },
    flush,
    get hasPending() {
      return pending;
    },
  };
}
