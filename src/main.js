/**
 * Point d'entrée : assemble la vue du plan, les dialogues et la persistance.
 */

import './styles.css';

import { getSetting, initStorage, requestPersistence, setSetting, storageEstimate } from './core/idb.js';
import {
  createAutosave,
  createPlan,
  deletePlan,
  listPlans,
  loadPlan,
  openPages,
  pageLayer,
  saveLayers,
} from './core/store.js';
import { calibrationScale, effectiveRatio, formatScale, mmPerPt, toMm } from './core/units.js';
import { buildAnnotatedPdf, exportFileName } from './export/exportPdf.js';
import { loadPdfDocument } from './pdf/loader.js';
import { renderThumbnails } from './pdf/thumbnails.js';
import { isStandalone, registerServiceWorker } from './pwa/updates.js';
import { renderInspector } from './ui/inspector.js';
import { $, confirmAction, formatBytes, formatDate, openDialog, toast } from './ui/ui.js';
import { FURNITURE_COLORS } from './viewer/overlay.js';
import { PlanView } from './viewer/planview.js';

/** État global de la session. */
const state = {
  /** @type {object|null} */ plan: null,
  /** @type {object|null} */ layers: null,
  /** @type {import('pdfjs-dist').PDFDocumentProxy|null} */ pdf: null,
  /** @type {ArrayBuffer|null} */ bytes: null,
  /** @type {(() => Promise<void>)|null} */ destroyPdf: null,
  vectorSegments: null,
  swVersion: null,
};

/**
 * Voile d'attente. L'extraction des tracés d'une planche A3 chargée prend ~1 s
 * sur ordinateur et davantage sur iPad : sans retour visuel, l'app paraît figée.
 */
function setBusy(text) {
  $('busy').hidden = !text;
  if (text) $('busy-text').textContent = text;
}

/**
 * Sur écran étroit, la barre d'état ne peut pas tout porter. Le nom du fichier
 * est ce qu'on sacrifie : il reste consultable dans « Mes plans » et dans le
 * sélecteur de page, alors que le diagnostic (page, tracés) n'apparaît nulle
 * part ailleurs.
 */
const compactStatus = window.matchMedia('(max-width: 560px)');

/** Calque de la page affichée : échelle et annotations sont propres à la page. */
const currentLayer = () => (state.layers ? pageLayer(state.layers, state.layers.pageIndex ?? 0) : null);

/** @type {PlanView} */
let view;
let autosave;
let swControl = { applyUpdate() {}, checkNow() {} };
let calibrationLengthPt = null;
let lastExport = null;
let storageAvailable = true;
// Sur téléphone le volet d'édition mange l'écran : il s'ouvre replié, et la
// pastille de la barre d'état le déplie à la demande.
let inspectorOpen = false;
// Identité de l'objet actuellement rendu dans le volet. Reconstruire le volet
// à chaque frappe détruisait le champ en cours de saisie : sur iPhone, le
// clavier se refermait à chaque lettre.
let inspectorRenderedFor = null;

// ─────────────────────────────────────────────────────────────────────────
// Démarrage
// ─────────────────────────────────────────────────────────────────────────

async function boot() {
  swControl = registerServiceWorker({
    onUpdateReady: () => {
      $('update-banner').hidden = false;
    },
    onVersion: (version) => {
      state.swVersion = version;
    },
  });

  view = new PlanView($('viewport-canvas'), {
    minimap: { root: $('minimap'), canvas: $('minimap-canvas'), view: $('minimap-view') },
    onChange: ({ viewOnly } = {}) => {
      autosave.schedule();
      if (!viewOnly) refreshInspector();
    },
    onSelect: (selection) => {
      // Chaque nouvelle sélection replie le volet sur téléphone : on veut voir
      // le plan qu'on vient de désigner, pas un formulaire par-dessus.
      inspectorOpen = Boolean(selection) && !compactStatus.matches;
      refreshInspector();
    },
    onHud: (text) => {
      const hud = $('hud');
      hud.hidden = !text;
      hud.textContent = text || '';
    },
    onZoom: (percent) => {
      const badge = $('zoom-badge');
      badge.hidden = !state.plan;
      badge.textContent = `${percent} %`;
    },
    onToolChange: () => syncToolButtons(),
    onCalibrate: (lengthPt) => {
      calibrationLengthPt = lengthPt;
      view.setTool('pan');
      openScaleDialog({ calibration: true });
    },
    onUndoChange: (depth) => {
      $('btn-undo').disabled = depth === 0;
    },
    onVectorInfo: (count) => {
      state.vectorSegments = count;
      updateStatus();
      if (count === 0) {
        $('chk-grid').checked = true;
        view.setGridEnabled(true);
        syncGridUi();
        toast(
          "Aucun tracé vectoriel dans ce PDF (scan ?) : l'accrochage est indisponible, la grille magnétique a été activée.",
          { duration: 6000 },
        );
      }
    },
  });

  autosave = createAutosave(() => state.layers, { onState: setSaveState });

  wireUi();
  await setupStorage();

  // Préférence d'affichage : elle doit survivre au redémarrage de l'app.
  const showDims = await getSetting('showFurnitureDims', true);
  $('chk-dims').checked = showDims;
  view.setShowDimensions(showDims);

  await restoreLastPlan();
  await refreshRecentList();
}

async function setupStorage() {
  // Safari supprime purement et simplement IndexedDB en navigation privée et
  // quand « Bloquer tous les cookies » est actif. L'app fonctionne quand même,
  // en session temporaire — mais il faut le dire clairement.
  const storage = await initStorage();
  storageAvailable = storage.available;

  if (!storageAvailable) {
    toast(
      'Stockage local indisponible : vous êtes probablement en navigation privée, ou « Bloquer tous les cookies » est activé dans Réglages → Safari. ' +
        'Vous pouvez consulter, mesurer et exporter, mais rien ne sera conservé à la fermeture.',
      { error: true, duration: 12_000 },
    );
    setSaveState('unavailable');
    return;
  }

  const { supported, persisted } = await requestPersistence();
  if (!supported) return;
  if (!persisted && !isStandalone()) {
    toast(
      "Installez l'app sur l'écran d'accueil (Partager → Sur l'écran d'accueil) pour que vos annotations soient conservées.",
      { duration: 7000 },
    );
  }
}

async function restoreLastPlan() {
  const lastId = await getSetting('lastPlanId', null);
  if (!lastId) return;
  try {
    await openPlan(lastId);
  } catch (err) {
    console.warn('Dernier plan non rouvert', err);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Chargement des plans
// ─────────────────────────────────────────────────────────────────────────

async function openPlan(id) {
  const record = await loadPlan(id);
  if (!record) {
    toast('Plan introuvable.', { error: true });
    return;
  }
  await autosave.flush();
  const previous = state.destroyPdf;
  setBusy('Ouverture du plan…');

  state.plan = record.plan;
  state.layers = record.layers;
  state.bytes = record.plan.bytes;
  state.vectorSegments = null;

  const { pdf, destroy } = await loadPdfDocument(state.bytes);
  state.pdf = pdf;
  state.destroyPdf = destroy;
  if (state.plan.pageCount !== pdf.numPages) {
    state.plan.pageCount = pdf.numPages;
  }

  await view.setDocument(state.pdf, state.layers);
  await previous?.().catch(() => {});

  $('empty-state').hidden = true;
  await setSetting('lastPlanId', id);
  renderTabs();
  syncToolButtons();
  syncScaleUi();
  syncGridUi();
  updateStatus();
  refreshInspector();
  setBusy(null);
}

/** Enregistre un PDF importé puis l'ouvre. */
async function importPdf(name, bytes, source) {
  if (!bytes || bytes.byteLength === 0) {
    toast('Fichier vide ou illisible.', { error: true });
    return;
  }
  let probe = null;
  try {
    setBusy('Lecture du PDF…');
    // Validation avant écriture : inutile de stocker un fichier illisible.
    probe = await loadPdfDocument(bytes);
    const pageCount = probe.pdf.numPages;

    // Sur un document à plusieurs pages, on demande laquelle ouvrir *avant*
    // de charger quoi que ce soit : inutile de rendre et d'indexer une page
    // dont l'utilisateur ne veut pas (une planche A3 coûte ~1 s).
    let pageIndex = 0;
    if (pageCount > 1) {
      setBusy(null);
      pageIndex = await openPagePicker(probe.pdf, { context: 'import' });
      if (pageIndex === null) {
        await probe.destroy();
        return;
      }
    }

    setBusy('Ouverture du plan…');
    const { plan } = await createPlan({ name, bytes, source, pageCount, pageIndex });
    await probe.destroy();
    probe = null;

    await openPlan(plan.id);
    await refreshRecentList();
    openScaleDialog({ firstTime: true });
  } catch (err) {
    console.error(err);
    setBusy(null);
    await probe?.destroy().catch(() => {});
    toast(`PDF illisible : ${err.message}`, { error: true });
  }
}

function handleFilePick(file) {
  if (!file) return;
  file
    .arrayBuffer()
    .then((bytes) => importPdf(file.name, bytes, { type: 'file' }))
    .catch((err) => toast(`Lecture impossible : ${err.message}`, { error: true }));
}


// ─────────────────────────────────────────────────────────────────────────
// Interface
// ─────────────────────────────────────────────────────────────────────────

function wireUi() {
  // Import
  $('file-input').addEventListener('change', (e) => {
    handleFilePick(e.target.files?.[0]);
    e.target.value = '';
  });
  const openFile = () => $('file-input').click();
  $('btn-open').addEventListener('click', openFile);
  $('empty-open').addEventListener('click', openFile);

  // Outils
  for (const btn of document.querySelectorAll('.tool')) {
    btn.addEventListener('click', () => view.setTool(btn.dataset.tool));
  }
  $('btn-add-furniture').addEventListener('click', () => openFurnitureDialog());
  $('btn-undo').addEventListener('click', undoLastAction);
  $('btn-fit').addEventListener('click', () => view.fit());
  $('btn-scale').addEventListener('click', () => openScaleDialog());
  $('btn-export').addEventListener('click', () => exportPdf());
  $('btn-menu').addEventListener('click', () => openMenu());
  // Écouteur en phase de bouillonnement : les gestionnaires des boutons ont
  // déjà tourné quand il ferme le menu. C'est ce qui laisse « Ouvrir un
  // fichier » déclencher le sélecteur dans le même geste utilisateur — iOS
  // n'ouvre le sélecteur que depuis un tap non interrompu.
  $('dlg-menu').addEventListener('click', (e) => {
    if (e.target.closest('.menu-list button')) $('dlg-menu').close();
  });

  // Délégation : les onglets sont reconstruits à chaque changement de page,
  // un écouteur par onglet serait à recâbler à chaque fois.
  $('tabs').addEventListener('click', (e) => {
    const closer = e.target.closest('[data-close]');
    if (closer) {
      closeTab(Number(closer.dataset.close));
      return;
    }
    const tab = e.target.closest('.tab');
    if (!tab) return;
    const index = Number(tab.dataset.page);
    if (index !== state.layers?.pageIndex) showPage(index);
  });

  $('chk-snap').addEventListener('change', (e) => view.setSnapEnabled(e.target.checked));
  $('chk-grid').addEventListener('change', (e) => {
    view.setGridEnabled(e.target.checked);
    syncGridUi();
  });
  $('btn-grid-step').addEventListener('click', () => {
    view.cycleGridStep();
    syncGridUi();
    autosave.schedule();
  });
  $('chk-dims').addEventListener('change', (e) => {
    view.setShowDimensions(e.target.checked);
    setSetting('showFurnitureDims', e.target.checked);
  });

  // Replier, sans désélectionner : l'objet reste manipulable au doigt et la
  // pastille permet de rouvrir le volet.
  $('inspector-close').addEventListener('click', () => {
    inspectorOpen = false;
    refreshInspector();
  });
  $('btn-inspector').addEventListener('click', () => {
    inspectorOpen = !inspectorOpen;
    refreshInspector();
  });

  // Mise à jour PWA
  $('update-reload').addEventListener('click', () => {
    $('update-banner').hidden = true;
    swControl.applyUpdate();
  });
  $('update-dismiss').addEventListener('click', () => {
    $('update-banner').hidden = true;
  });

  // Confort au clavier pendant le développement sur ordinateur.
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      e.preventDefault();
      undoLastAction();
    }
  });

  // Sauvegarde de sécurité quand l'app passe en arrière-plan (iOS peut la
  // suspendre puis la tuer sans autre évènement).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') autosave.flush();
  });
  window.addEventListener('pagehide', () => autosave.flush());

  // Rotation de l'iPad, Slide Over : le seuil peut être franchi en cours de route.
  compactStatus.addEventListener('change', () => {
    updateStatus();
    refreshInspector();
  });

  wireScaleDialog();
  wireFurnitureDialog();
  wireMenuDialog();
  wireExportDialog();
}

/** Pastille du pas de grille : visible seulement quand la grille l'est. */
function syncGridUi() {
  const chip = $('btn-grid-step');
  const on = Boolean(view?.gridEnabled && state.plan);
  chip.hidden = !on;
  if (!on) return;
  const stepMm = view.gridState?.stepMm ?? 1000;
  chip.textContent = stepMm >= 1000 ? `${stepMm / 1000} m` : `${stepMm / 10} cm`;
}

/** Annule la dernière action, quelle qu'elle soit. */
function undoLastAction() {
  if (!view?.undo()) {
    toast('Rien à annuler.');
    return;
  }
  refreshInspector();
  syncScaleUi();
  syncGridUi();
  autosave.schedule();
}

function syncToolButtons() {
  for (const btn of document.querySelectorAll('.tool')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.tool === view.tool));
  }
}

/**
 * La barre d'état ne parle que lorsqu'il y a quelque chose à dire.
 *
 * Afficher « Enregistrement… » puis « Enregistré » à chaque modification
 * n'apprend rien — la sauvegarde automatique est censée être invisible — et
 * ces deux textes de largeurs différentes décalaient les cases à cocher à
 * chaque cycle. Ne restent que les états anormaux.
 */
function setSaveState(status) {
  const el = $('status-save');

  if (status === 'unavailable') {
    el.className = 'save-state warn-state';
    el.textContent = compactStatus.matches ? 'Temporaire' : 'Session temporaire';
    return;
  }
  if (!storageAvailable) return; // le rappel permanent ne doit pas être écrasé

  if (status === 'error') {
    el.className = 'save-state error-state';
    el.textContent = compactStatus.matches ? 'Échec' : 'Échec de sauvegarde';
    return;
  }
  el.className = 'save-state';
  el.textContent = '';
}

function updateStatus() {
  const name = document.querySelector('#status-doc .doc-name');
  const meta = document.querySelector('#status-doc .doc-meta');

  if (!state.plan) {
    name.textContent = 'Aucun plan';
    meta.textContent = '';
    $('chk-snap').disabled = false;
    return;
  }

  const compact = compactStatus.matches;
  const page = (state.layers.pageIndex ?? 0) + 1;
  const parts = [];
  if (state.plan.pageCount > 1) {
    parts.push(compact ? `p.${page}/${state.plan.pageCount}` : `page ${page}/${state.plan.pageCount}`);
  }
  // « sans tracés » est une alerte : elle passe partout. Le nombre de tracés
  // n'est qu'un indicateur de confort, on le laisse tomber sur écran étroit.
  if (state.vectorSegments === 0) parts.push('sans tracés');
  else if (state.vectorSegments > 0 && !compact) {
    parts.push(`${state.vectorSegments.toLocaleString('fr-FR')} tracés`);
  }

  name.textContent = compact ? '' : state.plan.name;
  const info = parts.join(' · ');
  meta.textContent = name.textContent && info ? ` · ${info}` : info;

  $('chk-snap').disabled = state.vectorSegments === 0;
}

/**
 * Reflète la sélection courante : pastille dans la barre d'état, et volet
 * d'édition seulement s'il est déplié.
 */
function refreshInspector() {
  const chip = $('btn-inspector');
  const panel = $('inspector');
  const object = view?.getSelected();
  const selection = object ? view.selection : null;

  chip.hidden = !selection;
  // Sur écran étroit la pastille prend la place des infos du document : la
  // barre n'a pas la largeur pour les deux.
  $('status-doc').hidden = Boolean(selection) && compactStatus.matches;

  if (!selection) {
    panel.hidden = true;
    inspectorRenderedFor = null;
    return;
  }

  $('inspector-chip-label').textContent =
    selection.type === 'furniture' ? object.label || 'Meuble' : 'Cote';
  chip.setAttribute('aria-expanded', String(inspectorOpen));

  if (!inspectorOpen) {
    panel.hidden = true;
    inspectorRenderedFor = null;
    return;
  }

  // Le volet n'est reconstruit que si l'objet affiché change : sinon on
  // arracherait le champ que l'utilisateur est en train de remplir.
  const key = `${selection.type}:${selection.id}`;
  if (key === inspectorRenderedFor) return;
  inspectorRenderedFor = key;

  renderInspector(
    view,
    { root: panel, title: $('inspector-title'), body: $('inspector-body') },
    () => {
      autosave.schedule();
      // Renommer un meuble doit se voir aussitôt sur la pastille.
      $('inspector-chip-label').textContent = view.getSelected()?.label || 'Meuble';
    },
  );
}

function syncScaleUi() {
  const label = $('scale-label');
  const alert = $('menu-alert');
  if (!state.layers) {
    label.textContent = '—';
    label.className = 'menu-value';
    alert.hidden = true;
    return;
  }
  const layer = currentLayer();
  // Tant que l'échelle n'a pas été confirmée pour cette page, elle n'est qu'une
  // valeur héritée : le « ? » évite de mesurer en croyant l'échelle établie.
  label.textContent = `${formatScale(layer.scale)}${layer.scaleSet ? '' : ' ?'}`;
  label.className = `menu-value${layer.scaleSet ? '' : ' scale-warn'}`;
  // Le menu étant fermé la plupart du temps, l'alerte doit rester visible
  // depuis la barre d'outils.
  alert.hidden = layer.scaleSet;
}

async function refreshRecentList() {
  const list = $('recent-list');
  const plans = await listPlans();
  list.replaceChildren();
  list.hidden = plans.length === 0;
  for (const plan of plans.slice(0, 5)) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    const name = document.createElement('span');
    name.textContent = plan.name;
    const meta = document.createElement('span');
    meta.textContent = formatDate(plan.updatedAt);
    btn.append(name, meta);
    btn.addEventListener('click', () => openPlan(plan.id).catch((e) => toast(e.message, { error: true })));
    li.append(btn);
    list.append(li);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Dialogue « Échelle »
// ─────────────────────────────────────────────────────────────────────────

function wireScaleDialog() {
  for (const chip of document.querySelectorAll('#scale-ratio-row .chip')) {
    chip.addEventListener('click', () => {
      $('scale-ratio').value = chip.dataset.ratio;
      document.querySelector('input[name="scale-mode"][value="ratio"]').checked = true;
      updateScalePreview();
    });
  }
  $('scale-ratio').addEventListener('input', updateScalePreview);
  $('scale-calib-value').addEventListener('input', updateScalePreview);
  $('scale-calib-unit').addEventListener('change', updateScalePreview);
  for (const radio of document.querySelectorAll('input[name="scale-mode"]')) {
    radio.addEventListener('change', updateScalePreview);
  }

  $('scale-calib-start').addEventListener('click', () => {
    $('dlg-scale').close('calibrate');
  });
}

function currentDialogScale() {
  const mode = document.querySelector('input[name="scale-mode"]:checked')?.value || 'ratio';
  if (mode === 'calibration') {
    const value = Number($('scale-calib-value').value);
    if (!calibrationLengthPt || !Number.isFinite(value) || value <= 0) return null;
    return calibrationScale(calibrationLengthPt, toMm(value, $('scale-calib-unit').value));
  }
  const ratio = Number($('scale-ratio').value);
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  return { mode: 'ratio', ratio };
}

function updateScalePreview() {
  // Toujours en premier : c'est le retour qui confirme que le segment de
  // référence a bien été capté, avant même que la valeur soit saisie.
  $('scale-calib-info').textContent = calibrationLengthPt
    ? `✅ Segment de référence capté (${calibrationLengthPt.toFixed(1)} pt sur le papier). Saisissez sa valeur imprimée.`
    : 'Aucun segment de référence tracé pour le moment.';

  const scale = currentDialogScale();
  const info = $('scale-preview');
  if (!scale || !view?.vp?.base) {
    info.textContent = '';
    return;
  }
  const perPt = mmPerPt(scale);
  const wMm = view.vp.base.width * perPt;
  const hMm = view.vp.base.height * perPt;
  info.textContent = `Échelle 1/${Math.round(effectiveRatio(scale))} — la page représente ${(wMm / 1000).toFixed(2)} × ${(hMm / 1000).toFixed(2)} m.`;

}

async function openScaleDialog({ firstTime = false, calibration = false } = {}) {
  if (!state.layers) {
    toast('Ouvrez d’abord un plan.');
    return;
  }
  const scale = currentLayer().scale;
  const mode = calibration || firstTime ? 'calibration' : scale.mode;
  document.querySelector(`input[name="scale-mode"][value="${mode}"]`).checked = true;
  $('scale-ratio').value = String(Math.round(effectiveRatio(scale)));
  $('unit-display').value = state.layers.unit || 'auto';
  $('scale-page-label').textContent =
    state.plan.pageCount > 1 ? `— page ${(state.layers.pageIndex ?? 0) + 1}/${state.plan.pageCount}` : '';
  updateScalePreview();

  const result = await openDialog($('dlg-scale'));

  if (result === 'calibrate') {
    view.setTool('calibrate');
    syncToolButtons();
    toast('Tracez un segment le long d’une cote imprimée du plan.', { duration: 4500 });
    return;
  }
  if (result !== 'ok') {
    if (firstTime) {
      toast(
        `Échelle non confirmée pour cette page (${formatScale(currentLayer().scale)} supposée) — le menu ☰ reste marqué d'une pastille orange.`,
        { duration: 5000 },
      );
      syncScaleUi();
    }
    return;
  }

  const next = currentDialogScale();
  if (!next) {
    const mode = document.querySelector('input[name="scale-mode"]:checked')?.value;
    toast(
      mode === 'calibration' && !calibrationLengthPt
        ? 'Tracez d’abord le segment de référence, puis saisissez sa valeur imprimée.'
        : 'Échelle invalide.',
      { error: true },
    );
    return;
  }
  view.pushUndo(); // l'échelle fait partie des actions annulables
  const layer = currentLayer();
  layer.scale = next;
  layer.scaleSet = true;
  state.layers.unit = $('unit-display').value;
  calibrationLengthPt = null;
  view.refresh();
  syncScaleUi();
  refreshInspector();
  autosave.schedule();
  if (next.mode === 'calibration') {
    toast(`Échelle calibrée : ${formatScale(next)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Dialogue « Meuble »
// ─────────────────────────────────────────────────────────────────────────

let furnitureColor = FURNITURE_COLORS[0];

function wireFurnitureDialog() {
  const holder = $('furniture-colors');
  holder.replaceChildren();
  for (const color of FURNITURE_COLORS) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'swatch';
    swatch.style.background = color;
    swatch.setAttribute('aria-pressed', String(color === furnitureColor));
    swatch.addEventListener('click', () => {
      furnitureColor = color;
      for (const s of holder.children) s.setAttribute('aria-pressed', 'false');
      swatch.setAttribute('aria-pressed', 'true');
    });
    holder.append(swatch);
  }
}

async function openFurnitureDialog() {
  if (!state.layers) {
    toast('Ouvrez d’abord un plan.');
    return;
  }
  const result = await openDialog($('dlg-furniture'));
  if (result !== 'ok') return;

  const unit = $('furniture-unit').value;
  const length = Number($('furniture-length').value);
  const width = Number($('furniture-width').value);
  if (!(length > 0) || !(width > 0)) {
    toast('Dimensions invalides.', { error: true });
    return;
  }
  view.addFurniture({
    label: $('furniture-name').value.trim(),
    lengthMm: toMm(length, unit),
    widthMm: toMm(width, unit),
    color: furnitureColor,
  });
  $('furniture-name').value = '';
}

// ─────────────────────────────────────────────────────────────────────────
// Menu
// ─────────────────────────────────────────────────────────────────────────

function wireMenuDialog() {
  $('menu-library').addEventListener('click', () => {
    $('dlg-menu').close();
    openLibrary();
  });
  $('menu-page').addEventListener('click', () => {
    $('dlg-menu').close();
    openPageDialog();
  });
  $('menu-clear').addEventListener('click', async () => {
    $('dlg-menu').close();
    if (!state.layers) return;
    if (await confirmAction('Effacer les annotations', 'Toutes les cotes et tous les meubles de ce plan seront supprimés.')) {
      view.clearAnnotations();
      toast('Annotations effacées.');
    }
  });
  $('menu-storage').addEventListener('click', async () => {
    $('dlg-menu').close();
    const estimate = await storageEstimate();
    const persisted = (await navigator.storage?.persisted?.()) ?? false;
    const plans = await listPlans();
    toast(
      `${plans.length} plan(s) · ${estimate ? formatBytes(estimate.usage) : '—'} utilisés · stockage ${
        persisted ? 'persistant' : 'non persistant'
      } · mode ${isStandalone() ? 'standalone' : 'navigateur'}`,
      { duration: 6500 },
    );
  });
  $('menu-install').addEventListener('click', () => {
    $('dlg-menu').close();
    $('install-state').textContent = isStandalone()
      ? '✅ L’app est déjà lancée en mode standalone.'
      : '⚠️ Vous êtes actuellement dans un onglet Safari.';
    $('dlg-install').showModal();
  });
}

function openMenu() {
  $('menu-version').textContent = state.swVersion
    ? `Version installée : ${state.swVersion}`
    : 'Version : développement';
  $('dlg-menu').showModal();
}

async function openLibrary() {
  const list = $('library-list');
  const plans = await listPlans();
  list.replaceChildren();

  if (plans.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'Aucun plan enregistré.';
    list.append(li);
  }

  for (const plan of plans) {
    const li = document.createElement('li');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'btn wide name';
    open.textContent = plan.name;
    open.addEventListener('click', () => {
      $('dlg-library').close();
      openPlan(plan.id).catch((e) => toast(e.message, { error: true }));
    });

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = formatBytes(plan.size);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-btn';
    remove.textContent = '🗑';
    remove.setAttribute('aria-label', `Supprimer ${plan.name}`);
    remove.addEventListener('click', async () => {
      if (!(await confirmAction('Supprimer le plan', `« ${plan.name} » et ses annotations seront supprimés.`))) return;
      await deletePlan(plan.id);
      if (state.plan?.id === plan.id) {
        state.plan = null;
        state.layers = null;
        state.pdf = null;
        $('empty-state').hidden = false;
        await setSetting('lastPlanId', null);
        updateStatus();
      }
      await refreshRecentList();
      openLibrary();
    });

    li.append(open, meta, remove);
    list.append(li);
  }

  $('dlg-library').showModal();
}

/**
 * Sélecteur de page, avec vignettes.
 *
 * Sur un carnet, un numéro de page ne dit rien : il faut voir la planche. Les
 * vignettes sont rendues une par une et le rendu s'arrête dès la fermeture du
 * dialogue, pour ne pas occuper l'iPad inutilement.
 *
 * @param {import('pdfjs-dist').PDFDocumentProxy} pdf
 * @param {{context: 'import'|'switch'}} options
 * @returns {Promise<number|null>} index de page choisi, ou null si annulé
 */
async function openPagePicker(pdf, { context = 'switch' } = {}) {
  const dialog = $('dlg-page');
  const grid = $('page-grid');
  const current = context === 'switch' ? (state.layers?.pageIndex ?? 0) : null;

  $('page-title').textContent =
    context === 'import' ? `Quelle page ouvrir ? (${pdf.numPages} pages)` : 'Changer de page';
  $('page-hint').textContent =
    context === 'import'
      ? 'Chaque page a sa propre échelle et ses propres annotations. Vous pourrez changer de page à tout moment (menu ⋯).'
      : 'L’échelle et les annotations affichées sont celles de la page choisie.';
  $('page-cancel').textContent = context === 'import' ? 'Annuler l’import' : 'Annuler';

  const thumbs = [];
  grid.replaceChildren();
  for (let i = 0; i < pdf.numPages; i++) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'page-card';
    card.setAttribute('aria-current', String(i === current));

    const thumb = document.createElement('div');
    thumb.className = 'thumb loading';
    thumbs.push(thumb);

    const caption = document.createElement('div');
    caption.className = 'caption';
    const label = document.createElement('span');
    label.textContent = `Page ${i + 1}`;
    const note = document.createElement('em');
    note.textContent = describePage(i);
    caption.append(label, note);

    card.append(thumb, caption);
    card.addEventListener('click', () => dialog.close(String(i)));
    grid.append(card);
  }

  let closed = false;
  renderThumbnails(
    pdf,
    (index, canvas) => {
      thumbs[index]?.replaceChildren(canvas);
      thumbs[index]?.classList.remove('loading');
    },
    { shouldStop: () => closed },
  );

  const result = await openDialog(dialog);
  closed = true;

  const index = Number(result);
  return Number.isInteger(index) && index >= 0 && index < pdf.numPages ? index : null;
}

/** Résumé d'une page pour le sélecteur : échelle réglée et annotations posées. */
function describePage(index) {
  const layer = state.layers?.pages?.[String(index)];
  if (!layer) return '';
  const parts = [];
  if (layer.scaleSet) parts.push(formatScale(layer.scale));
  const count = layer.measures.length + layer.furniture.length;
  if (count) parts.push(`${count} annot.`);
  return parts.join(' · ');
}

/** Ouvre une page depuis le menu, dans un onglet, puis réclame son échelle. */
async function openPageDialog() {
  if (!state.pdf) return;
  const index = await openPagePicker(state.pdf, { context: 'switch' });
  if (index === null || index === state.layers.pageIndex) return;
  await showPage(index);
}

// ─────────────────────────────────────────────────────────────────────────
// Onglets de pages
// ─────────────────────────────────────────────────────────────────────────

/**
 * Barre d'onglets. Elle ne s'affiche qu'à partir de deux pages ouvertes : sur
 * téléphone, une rangée prise au plan pour un onglet unique serait du gâchis.
 */
function renderTabs() {
  const bar = $('tabs');
  if (!state.layers || !state.pdf) {
    bar.hidden = true;
    return;
  }
  const pages = openPages(state.layers);
  bar.hidden = pages.length < 2;
  if (bar.hidden) {
    bar.replaceChildren();
    return;
  }

  const active = state.layers.pageIndex ?? 0;
  bar.replaceChildren(
    ...pages.map((index) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'tab';
      tab.dataset.page = String(index);
      tab.setAttribute('aria-current', String(index === active));

      const label = document.createElement('span');
      label.textContent = `Page ${index + 1}`;
      tab.append(label);

      const close = document.createElement('span');
      close.className = 'close';
      close.textContent = '✕';
      close.dataset.close = String(index);
      close.setAttribute('aria-hidden', 'true');
      tab.append(close);

      return tab;
    }),
  );
}

/**
 * Ferme un onglet. La page garde ses annotations : fermer un onglet range une
 * page, ça ne détruit rien — c'est « Effacer les annotations » qui détruit.
 */
async function closeTab(index) {
  const pages = openPages(state.layers);
  if (pages.length < 2) return; // le dernier onglet ne se ferme pas
  state.layers.openPages = pages.filter((i) => i !== index);
  if (index === state.layers.pageIndex) {
    await showPage(state.layers.openPages[0]);
  } else {
    renderTabs();
    autosave.schedule();
  }
}

/** Affiche une page et demande son échelle si elle n'a jamais été confirmée. */
async function showPage(index) {
  await autosave.flush();
  state.vectorSegments = null;
  setBusy(`Ouverture de la page ${index + 1}…`);
  await view.setPage(index, { restoreView: true });
  // `setPage` a mis à jour `pageIndex` ; `openPages` inscrit la page dans les
  // onglets si elle n'y était pas encore.
  openPages(state.layers);
  await saveLayers(state.layers);
  setBusy(null);
  renderTabs();
  syncScaleUi();
  syncGridUi();
  updateStatus();
  refreshInspector();

  // Une page jamais calibrée hérite d'une échelle *supposée* : on demande
  // confirmation plutôt que de laisser mesurer avec une valeur héritée.
  if (!currentLayer().scaleSet) openScaleDialog({ firstTime: true });
}

// ─────────────────────────────────────────────────────────────────────────
// Export PDF
// ─────────────────────────────────────────────────────────────────────────

function wireExportDialog() {
  $('export-download').addEventListener('click', () => {
    if (!lastExport) return;
    const url = URL.createObjectURL(lastExport.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = lastExport.name;
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  });

  $('export-share').addEventListener('click', async () => {
    if (!lastExport) return;
    const file = new File([lastExport.blob], lastExport.name, { type: 'application/pdf' });
    if (!navigator.canShare?.({ files: [file] })) {
      toast('Partage indisponible sur cet appareil, utilisez « Télécharger ».', { error: true });
      return;
    }
    try {
      await navigator.share({ files: [file], title: lastExport.name });
      $('dlg-export').close();
    } catch (err) {
      if (err?.name !== 'AbortError') toast(`Partage impossible : ${err.message}`, { error: true });
    }
  });
}

async function exportPdf() {
  if (!state.layers || !state.bytes) {
    toast('Ouvrez d’abord un plan.');
    return;
  }
  const count = Object.values(state.layers.pages).reduce(
    (n, page) => n + page.measures.length + page.furniture.length,
    0,
  );
  toast('Génération du PDF annoté…');
  try {
    await autosave.flush();
    const blob = await buildAnnotatedPdf({
      // pdf-lib ne détache pas le buffer, mais on isole quand même la copie
      // utilisée par PDF.js pour éviter toute surprise.
      bytes: state.bytes.slice(0),
      layers: state.layers,
      name: state.plan.name,
      // Ce qui est masqué à l'écran l'est aussi à l'export : on exporte le
      // plan tel qu'on vient de le composer.
      showDimensions: view.showDimensions,
    });
    lastExport = { blob, name: exportFileName(state.plan.name) };
    $('export-info').textContent = `${lastExport.name} — ${formatBytes(blob.size)}, ${count} annotation(s).`;
    // Le partage iOS exige un geste utilisateur : on passe par ce dialogue
    // plutôt que d'appeler navigator.share() après un traitement asynchrone.
    $('dlg-export').showModal();
  } catch (err) {
    console.error(err);
    toast(`Export impossible : ${err.message}`, { error: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────

boot().catch((err) => {
  console.error(err);
  toast(`Démarrage impossible : ${err.message}`, { error: true });
});

// Point d'entrée de débogage (console Safari sur l'iPad) et de test automatisé.
window.planViewer = {
  state,
  get view() {
    return view;
  },
  openPlan,
  importPdf,
  flushSave: () => autosave.flush(),
  renderTabs,
  buildExport: () =>
    buildAnnotatedPdf({
      bytes: state.bytes.slice(0),
      layers: state.layers,
      name: state.plan.name,
      showDimensions: view.showDimensions,
    }),
};
