/** Persistance des plans et de leurs calques d'annotations. */

import { uid } from './geometry.js';
import { idb } from './idb.js';
import { defaultScale } from './units.js';

export const LAYERS_VERSION = 3;

/**
 * Calque vierge d'une page.
 *
 * L'échelle est stockée **par page** : un carnet de détails mélange couramment
 * plusieurs échelles (un 1/10 en page 1, un 1/20 en page 2…). Une échelle
 * unique pour tout le document donnerait des cotes fausses sans prévenir.
 */
export function emptyPageLayer(scale = defaultScale()) {
  // `scaleSet` distingue une échelle *choisie* d'une valeur par défaut héritée :
  // tant qu'elle est fausse, l'app réclame confirmation avant de laisser mesurer.
  return { scale, scaleSet: false, view: null, measures: [], furniture: [] };
}

/** Calque vierge pour un plan qui vient d'être importé. */
export function emptyLayers(planId, pageIndex = 0) {
  return {
    planId,
    version: LAYERS_VERSION,
    pageIndex,
    // Pages ouvertes en onglets. Travailler sur un plan et sa coupe suppose de
    // passer de l'un à l'autre sans les rouvrir à chaque fois.
    openPages: [pageIndex],
    unit: 'auto',
    pages: { [pageIndex]: emptyPageLayer() },
    updatedAt: Date.now(),
  };
}

/**
 * Liste des pages ouvertes, normalisée : entiers uniques, triés, contenant
 * toujours la page active. Les calques enregistrés avant les onglets n'ont pas
 * ce champ, et une liste corrompue ne doit pas priver l'utilisateur de son
 * travail — on la reconstruit plutôt que de la rejeter.
 */
export function openPages(layers) {
  const active = layers.pageIndex ?? 0;
  const raw = Array.isArray(layers.openPages) ? layers.openPages : [];
  const clean = [...new Set(raw.filter((i) => Number.isInteger(i) && i >= 0))].sort((a, b) => a - b);
  if (!clean.includes(active)) clean.push(active);
  clean.sort((a, b) => a - b);
  layers.openPages = clean;
  return clean;
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

  // v2 → v3 : les onglets. Le seul manque est la liste des pages ouvertes,
  // que `openPages()` reconstruit à partir de la page active.
  if (layers.version === 2 && layers.pages) {
    layers.version = LAYERS_VERSION;
    openPages(layers);
    return layers;
  }
  if (layers.version === LAYERS_VERSION && layers.pages) {
    openPages(layers);
    return layers;
  }

  // v1 : une seule échelle et une seule liste d'annotations pour tout le document.
  const index = layers.pageIndex ?? 0;
  return {
    planId,
    version: LAYERS_VERSION,
    pageIndex: index,
    openPages: [index],
    unit: layers.unit || 'auto',
    pages: {
      [index]: {
        scale: layers.scale || defaultScale(),
        scaleSet: true, // une échelle enregistrée en v1 avait été choisie

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
export async function createPlan({ name, bytes, source = { type: 'file' }, pageCount = 1, pageIndex = 0 }) {
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
  const layers = emptyLayers(plan.id, pageIndex);
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
