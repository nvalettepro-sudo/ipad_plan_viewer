/** Persistance des plans et de leurs calques d'annotations. */

import { uid } from './geometry.js';
import { idb } from './idb.js';
import { defaultScale } from './units.js';

/** Calque vierge pour un plan qui vient d'être importé. */
export function emptyLayers(planId) {
  return {
    planId,
    pageIndex: 0,
    scale: defaultScale(),
    unit: 'auto',
    view: null,
    measures: [],
    furniture: [],
    updatedAt: Date.now(),
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
  const layers = (await idb.get('layers', id)) || emptyLayers(id);
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
