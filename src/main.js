/**
 * Point d'entrée : assemble la vue du plan, les dialogues et la persistance.
 */

import './styles.css';

import { getSetting, requestPersistence, setSetting, storageEstimate } from './core/idb.js';
import {
  createAutosave,
  createPlan,
  deletePlan,
  listPlans,
  loadPlan,
  saveLayers,
} from './core/store.js';
import { calibrationScale, effectiveRatio, formatScale, mmPerPt, toMm } from './core/units.js';
import { DriveClient } from './drive/google.js';
import { buildAnnotatedPdf, exportFileName } from './export/exportPdf.js';
import { loadPdfDocument } from './pdf/loader.js';
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

const drive = new DriveClient();

/** @type {PlanView} */
let view;
let autosave;
let swControl = { applyUpdate() {}, checkNow() {} };
let calibrationLengthPt = null;
let lastExport = null;

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
    onSelect: () => refreshInspector(),
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
    onCalibrate: (lengthPt) => {
      calibrationLengthPt = lengthPt;
      view.setTool('pan');
      syncToolButtons();
      openScaleDialog({ calibration: true });
    },
    onVectorInfo: (count) => {
      state.vectorSegments = count;
      updateStatus();
      if (count === 0) {
        $('chk-grid').checked = true;
        view.setGridEnabled(true);
        toast(
          "Aucun tracé vectoriel dans ce PDF (scan ?) : l'accrochage est indisponible, la grille magnétique a été activée.",
          { duration: 6000 },
        );
      }
    },
  });

  autosave = createAutosave(() => state.layers, { onState: setSaveState });

  wireUi();
  await setupPersistence();

  // Préchargement Google : indispensable pour que le tap « Drive » puisse
  // ouvrir la popup sans attente (contrainte iPad n°2).
  drive.preload().catch((err) => console.warn('Google non préchargé', err));

  await restoreLastPlan();
  await refreshRecentList();
}

async function setupPersistence() {
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
  syncToolButtons();
  syncScaleUi();
  updateStatus();
  refreshInspector();
}

/** Enregistre un PDF importé puis l'ouvre. */
async function importPdf(name, bytes, source) {
  if (!bytes || bytes.byteLength === 0) {
    toast('Fichier vide ou illisible.', { error: true });
    return;
  }
  try {
    // Validation avant écriture : inutile de stocker un fichier illisible.
    const probe = await loadPdfDocument(bytes);
    const pageCount = probe.pdf.numPages;
    await probe.destroy();

    const { plan } = await createPlan({ name, bytes, source, pageCount });
    await openPlan(plan.id);
    await refreshRecentList();
    openScaleDialog({ firstTime: true });
  } catch (err) {
    console.error(err);
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

/**
 * Import Drive. Appelée *directement* depuis le gestionnaire de clic :
 * aucun `await` ne doit précéder `drive.requestFile()`.
 */
function handleDriveImport() {
  let request;
  try {
    request = drive.requestFile();
  } catch (err) {
    toast(err.message, { error: true });
    return;
  }
  request
    .then((file) => {
      if (!file) return null;
      return importPdf(file.name, file.bytes, { type: 'drive', fileId: file.fileId });
    })
    .catch((err) => {
      console.error(err);
      toast(err.message, { error: true });
    });
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
  $('btn-drive').addEventListener('click', handleDriveImport);
  $('empty-drive').addEventListener('click', handleDriveImport);

  // Outils
  for (const btn of document.querySelectorAll('.tool')) {
    btn.addEventListener('click', () => {
      view.setTool(btn.dataset.tool);
      syncToolButtons();
    });
  }
  $('btn-add-furniture').addEventListener('click', () => openFurnitureDialog());
  $('btn-fit').addEventListener('click', () => view.fit());
  $('btn-scale').addEventListener('click', () => openScaleDialog());
  $('btn-export').addEventListener('click', () => exportPdf());
  $('btn-menu').addEventListener('click', () => openMenu());

  $('chk-snap').addEventListener('change', (e) => view.setSnapEnabled(e.target.checked));
  $('chk-grid').addEventListener('change', (e) => view.setGridEnabled(e.target.checked));

  $('inspector-close').addEventListener('click', () => view.select(null));

  // Mise à jour PWA
  $('update-reload').addEventListener('click', () => {
    $('update-banner').hidden = true;
    swControl.applyUpdate();
  });
  $('update-dismiss').addEventListener('click', () => {
    $('update-banner').hidden = true;
  });

  // Sauvegarde de sécurité quand l'app passe en arrière-plan (iOS peut la
  // suspendre puis la tuer sans autre évènement).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') autosave.flush();
  });
  window.addEventListener('pagehide', () => autosave.flush());

  wireScaleDialog();
  wireFurnitureDialog();
  wireMenuDialog();
  wireGoogleDialog();
  wireExportDialog();
}

function syncToolButtons() {
  for (const btn of document.querySelectorAll('.tool')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.tool === view.tool));
  }
}

function setSaveState(status) {
  const el = $('status-save');
  el.className = `save-state ${status === 'saved' ? 'saved' : status === 'saving' ? 'saving' : ''}`;
  el.textContent =
    status === 'saving' ? 'Enregistrement…' : status === 'saved' ? 'Enregistré' : status === 'error' ? 'Erreur' : '';
  if (status === 'saved') setTimeout(() => (el.textContent = ''), 1800);
}

function updateStatus() {
  const parts = [];
  if (state.plan) {
    parts.push(state.plan.name);
    if (state.plan.pageCount > 1) parts.push(`page ${(state.layers.pageIndex ?? 0) + 1}/${state.plan.pageCount}`);
    if (state.vectorSegments === 0) parts.push('sans tracés vectoriels');
    else if (state.vectorSegments > 0) parts.push(`${state.vectorSegments.toLocaleString('fr-FR')} tracés`);
  } else {
    parts.push('Aucun plan');
  }
  $('status-doc').textContent = parts.join(' · ');
  $('chk-snap').disabled = state.vectorSegments === 0;
}

function refreshInspector() {
  renderInspector(
    view,
    { root: $('inspector'), title: $('inspector-title'), body: $('inspector-body') },
    () => autosave.schedule(),
  );
}

function syncScaleUi() {
  $('scale-label').textContent = state.layers ? formatScale(state.layers.scale) : 'Échelle';
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

  $('scale-calib-info').textContent = calibrationLengthPt
    ? `Segment de référence mesuré : ${calibrationLengthPt.toFixed(1)} pt.`
    : 'Aucun segment de référence tracé pour le moment.';
}

async function openScaleDialog({ firstTime = false, calibration = false } = {}) {
  if (!state.layers) {
    toast('Ouvrez d’abord un plan.');
    return;
  }
  const scale = state.layers.scale;
  const mode = calibration ? 'calibration' : scale.mode;
  document.querySelector(`input[name="scale-mode"][value="${mode}"]`).checked = true;
  $('scale-ratio').value = String(Math.round(effectiveRatio(scale)));
  $('unit-display').value = state.layers.unit || 'auto';
  updateScalePreview();

  const result = await openDialog($('dlg-scale'));

  if (result === 'calibrate') {
    view.setTool('calibrate');
    syncToolButtons();
    toast('Tracez un segment sur une cote connue du plan.', { duration: 4500 });
    return;
  }
  if (result !== 'ok') {
    if (firstTime) toast(`Échelle conservée : ${formatScale(state.layers.scale)}`);
    return;
  }

  const next = currentDialogScale();
  if (!next) {
    toast('Échelle invalide.', { error: true });
    return;
  }
  state.layers.scale = next;
  state.layers.unit = $('unit-display').value;
  view.refresh();
  syncScaleUi();
  refreshInspector();
  autosave.schedule();
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
  syncToolButtons();
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
  $('menu-google').addEventListener('click', () => {
    $('dlg-menu').close();
    openGoogleDialog();
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

async function openPageDialog() {
  if (!state.pdf) return;
  const select = $('page-select');
  select.replaceChildren();
  for (let i = 0; i < state.pdf.numPages; i++) {
    const option = document.createElement('option');
    option.value = String(i);
    option.textContent = `Page ${i + 1}`;
    option.selected = i === (state.layers.pageIndex ?? 0);
    select.append(option);
  }
  if ((await openDialog($('dlg-page'))) !== 'ok') return;

  const index = Number(select.value);
  if (index === state.layers.pageIndex) return;
  await autosave.flush();
  state.layers.view = null;
  state.vectorSegments = null;
  await view.setPage(index, { restoreView: false });
  await saveLayers(state.layers);
  updateStatus();
}

// ─────────────────────────────────────────────────────────────────────────
// Configuration Google
// ─────────────────────────────────────────────────────────────────────────

function wireGoogleDialog() {
  $('g-origin').textContent = `Origine à autoriser dans Google Cloud : ${location.origin}`;
}

async function openGoogleDialog() {
  const config = await drive.loadConfig();
  $('g-client-id').value = config.clientId || '';
  $('g-api-key').value = config.apiKey || '';
  $('g-app-id').value = config.appId || '';

  if ((await openDialog($('dlg-google'))) !== 'ok') return;

  await drive.saveConfig({
    clientId: $('g-client-id').value.trim(),
    apiKey: $('g-api-key').value.trim(),
    appId: $('g-app-id').value.trim(),
  });
  toast(drive.isConfigured ? 'Configuration Google enregistrée.' : 'Configuration incomplète.');
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
  const count = state.layers.measures.length + state.layers.furniture.length;
  toast('Génération du PDF annoté…');
  try {
    await autosave.flush();
    const blob = await buildAnnotatedPdf({
      // pdf-lib ne détache pas le buffer, mais on isole quand même la copie
      // utilisée par PDF.js pour éviter toute surprise.
      bytes: state.bytes.slice(0),
      layers: state.layers,
      name: state.plan.name,
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
  buildExport: () =>
    buildAnnotatedPdf({ bytes: state.bytes.slice(0), layers: state.layers, name: state.plan.name }),
};
