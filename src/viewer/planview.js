/**
 * Vue interactive d'un plan : rendu, gestes, outils de mesure et de mobilier.
 *
 * C'est le composant central de l'app. Il possède le canvas visible, le
 * `Viewport` (zoom/déplacement), le `PageRenderer` (bitmap de la page) et
 * l'index d'accrochage. Il ne touche jamais à IndexedDB : il modifie l'objet
 * `layers` qu'on lui confie et signale les changements via `onChange`, à charge
 * de l'appelant de déclencher la sauvegarde.
 */

import { clamp, dist, pointInRect, rectCorners, uid } from '../core/geometry.js';
import { pageLayer } from '../core/store.js';
import { formatLength, mmPerPt } from '../core/units.js';
import { extractSegments, SnapIndex } from '../pdf/vector.js';
import { GestureController } from './gestures.js';
import {
  drawAxisGuide,
  drawDraftMeasure,
  drawFurniture,
  drawGrid,
  drawGridOrigin,
  drawMeasure,
  drawSnapGuides,
  drawSnapMarker,
  FURNITURE_COLORS,
} from './overlay.js';
import { PageRenderer } from './renderer.js';
import { Viewport } from './viewport.js';

const HIT_TOLERANCE_PX = 16; // zone tactile généreuse : pas de précision au pixel
// Les poignées d'extrémité de cote priment sur le corps de la cote, et
// méritent une zone plus large encore : c'est le geste le plus fin de l'app.
const HANDLE_TOLERANCE_PX = 26;
const SNAP_RADIUS_PX = 22;
const MIN_MEASURE_PX = 12;
const QUALITY_DEBOUNCE_MS = 220;
// Deux pas seulement : au-delà, choisir devient une corvée alors que 1 m et
// 50 cm couvrent l'implantation de mobilier.
export const GRID_STEPS_MM = [1000, 500];
const FURNITURE_SNAP_PX = 20; // attraction des arêtes d'un meuble vers les murs
const UNDO_DEPTH = 50;
const UNDO_COALESCE_MS = 900;

export class PlanView {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{
   *   minimap?: {root: HTMLElement, canvas: HTMLCanvasElement, view: HTMLElement},
   *   onChange?: () => void,
   *   onSelect?: (sel: {type:string, id:string}|null) => void,
   *   onHud?: (text: string|null) => void,
   *   onZoom?: (percent: number) => void,
   *   onCalibrate?: (lengthPt: number) => void,
   *   onVectorInfo?: (segmentCount: number) => void,
   * }} options
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.opts = options;

    this.vp = new Viewport();
    this.renderer = new PageRenderer();

    /** @type {import('pdfjs-dist').PDFDocumentProxy|null} */
    this.pdf = null;
    /** @type {import('pdfjs-dist').PDFPageProxy|null} */
    this.page = null;
    /** @type {SnapIndex|null} */
    this.snapIndex = null;
    this.layers = null;

    this.tool = 'pan';
    this.snapEnabled = true;
    this.gridEnabled = false;
    this.showDimensions = true;
    this.selection = null;
    this.draft = null;
    this.activeSnap = null;
    /** Arêtes actuellement collées à un tracé, dessinées en vert pendant le geste. */
    this.activeSnapGuides = [];
    this.dragState = null;
    this.thumbnail = null;

    this.drawQueued = false;
    this.qualityTimer = null;

    // Historique d'annulation : instantanés du calque de la page courante.
    // Les calques sont de simples données, un clone est bien plus sûr qu'un
    // journal d'opérations inverses à maintenir pour chaque type d'action.
    this.undoStack = [];
    this.lastUndoKey = null;
    this.lastUndoAt = 0;

    this.gestures = new GestureController(canvas, {
      onDragStart: (p) => this.#onDragStart(p),
      onDragMove: (p) => this.#onDragMove(p),
      onDragEnd: (p, moved) => this.#onDragEnd(p, moved),
      onDragCancel: () => this.#onDragCancel(),
      onTransform: (t) => this.#onTransform(t),
      onTransformEnd: () => this.#onTransformEnd(),
      onDoubleTap: (p) => this.#onDoubleTap(p),
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);

    if (options.minimap) this.#setupMinimap(options.minimap);
  }

  // ── Cycle de vie ────────────────────────────────────────────────────────

  /**
   * Charge un document et ses calques.
   * @param {import('pdfjs-dist').PDFDocumentProxy} pdf
   * @param {object} layers
   */
  async setDocument(pdf, layers) {
    this.pdf = pdf;
    this.layers = layers;
    this.selection = null;
    this.draft = null;
    await this.setPage(layers.pageIndex ?? 0, { restoreView: true });
  }

  /** Change de page (les annotations sont propres à la page enregistrée). */
  async setPage(pageIndex, { restoreView = false } = {}) {
    if (!this.pdf) return;
    const index = clamp(pageIndex, 0, this.pdf.numPages - 1);
    this.layers.pageIndex = index;
    // L'historique porte sur une page : il n'a plus de sens sur une autre.
    this.#clearUndo();

    this.page = await this.pdf.getPage(index + 1);
    const base = this.page.getViewport({ scale: 1 });
    this.vp.setBase(base);
    this.renderer.setPage(this.page, base);
    this.resize({ silent: true });

    if (!(restoreView && this.vp.restore(this.layer.view))) this.vp.fit();
    this.vp.clampPan();

    this.thumbnail = null;
    this.snapIndex = null;
    this.#draw();

    await this.#renderQuality();
    this.#buildSnapIndex();
    this.#buildThumbnail();
    this.#draw();
  }

  destroy() {
    this.gestures.destroy();
    this.resizeObserver.disconnect();
    this.renderer.destroy();
    clearTimeout(this.qualityTimer);
    this.pdf = null;
    this.page = null;
    this.snapIndex = null;
  }

  // ── Réglages ────────────────────────────────────────────────────────────

  setTool(tool) {
    this.tool = tool;
    this.draft = null;
    this.activeSnap = null;
    if (tool !== 'pan') this.select(null);
    this.opts.onHud?.(tool === 'calibrate' ? 'Tracez le segment de référence' : null);
    // L'outil change aussi de l'intérieur — après une cote posée, après un
    // meuble créé : c'est la vue qui prévient la barre d'outils, sinon les
    // boutons resteraient allumés sur un outil qui n'est plus actif.
    this.opts.onToolChange?.(tool);
    this.#draw();
  }

  setSnapEnabled(value) {
    this.snapEnabled = value;
    this.#draw();
  }

  setGridEnabled(value) {
    this.gridEnabled = value;
    this.#draw();
  }

  /**
   * Réglages de la grille, attachés à la page : origine et pas.
   * L'origine `null` signifie « coin de la page », tant que l'utilisateur ne
   * l'a pas déplacée.
   */
  get gridState() {
    const layer = this.layer;
    if (!layer) return null;
    layer.grid ??= { x: null, y: null, stepMm: GRID_STEPS_MM[0] };
    return layer.grid;
  }

  /** Origine de la grille en coordonnées PDF, valeurs par défaut résolues. */
  gridOrigin() {
    const grid = this.gridState;
    const [x0, y0] = this.page?.view || [0, 0];
    if (!grid) return { x: x0, y: y0 };
    return { x: grid.x ?? x0, y: grid.y ?? y0 };
  }

  /** Bascule le pas de la grille entre 1 m et 50 cm. */
  cycleGridStep() {
    const grid = this.gridState;
    if (!grid) return null;
    this.pushUndo();
    const index = GRID_STEPS_MM.indexOf(grid.stepMm);
    grid.stepMm = GRID_STEPS_MM[(index + 1) % GRID_STEPS_MM.length];
    this.#changed();
    return grid.stepMm;
  }

  /** Affiche ou masque les cotes portées par les meubles (le nom reste). */
  setShowDimensions(value) {
    this.showDimensions = value;
    this.#draw();
  }

  /** L'accrochage vectoriel n'est possible que si la page contient des tracés. */
  get hasVectorGeometry() {
    return !!this.snapIndex && !this.snapIndex.isEmpty;
  }

  /** Calque de la page affichée (échelle et annotations propres à cette page). */
  get layer() {
    return this.layers ? pageLayer(this.layers, this.layers.pageIndex ?? 0) : null;
  }

  get scale() {
    return this.layer?.scale;
  }

  get unit() {
    return this.layers?.unit || 'auto';
  }

  // ── Vue ─────────────────────────────────────────────────────────────────

  resize({ silent = false } = {}) {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    const changed = this.canvas.width !== w || this.canvas.height !== h || this.dpr !== dpr;

    if (changed) {
      // Écrire dans canvas.width efface le canvas — en `alpha: false`, il vire
      // au noir. Attendre la frame suivante pour redessiner laisse voir ce
      // flash noir : le repaint plus bas est donc synchrone, pas en rAF.
      this.canvas.width = w;
      this.canvas.height = h;
      this.dpr = dpr;
    }

    // Toujours recalculé, même sans changement de canvas : la page courante
    // peut avoir d'autres dimensions que la précédente.
    this.vp.setContainer(rect.width, rect.height);
    this.vp.refreshFitScale();
    this.vp.clampPan();

    // Sans changement réel, rien à repeindre : ResizeObserver se déclenche
    // aussi pour des variations nulles.
    if (silent || !changed) return;
    this.#paint();
    this.#scheduleQuality();
  }

  fit() {
    this.vp.fit();
    this.#persistView();
    this.#draw();
    this.#scheduleQuality();
  }

  zoomBy(factor) {
    this.vp.zoomAt(this.vp.width / 2, this.vp.height / 2, factor);
    this.vp.clampPan();
    this.#persistView();
    this.#draw();
    this.#scheduleQuality();
  }

  // ── Annulation ──────────────────────────────────────────────────────────

  /**
   * Enregistre l'état courant avant une modification.
   *
   * `key` regroupe les actions continues : toutes les frappes dans le champ
   * « Nom » d'un même meuble ne forment qu'un seul point d'annulation, sinon
   * annuler ne reculerait que d'une lettre.
   */
  pushUndo(key = null) {
    if (!this.layer) return;
    const now = performance.now();
    if (key && key === this.lastUndoKey && now - this.lastUndoAt < UNDO_COALESCE_MS) {
      this.lastUndoAt = now;
      return;
    }
    this.lastUndoKey = key;
    this.lastUndoAt = now;
    this.#pushSnapshot(structuredClone(this.layer));
  }

  #pushSnapshot(snapshot) {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift();
    this.opts.onUndoChange?.(this.undoStack.length);
  }

  #clearUndo() {
    this.undoStack = [];
    this.lastUndoKey = null;
    this.opts.onUndoChange?.(0);
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  /** Revient à l'état précédent. La position de la vue n'est pas touchée. */
  undo() {
    const previous = this.undoStack.pop();
    if (!previous || !this.layers) return false;

    // Annuler une modification ne doit pas ramener la caméra en arrière :
    // l'utilisateur perdrait de vue ce qu'il vient de corriger.
    previous.view = this.layer.view;
    this.layers.pages[String(this.layers.pageIndex ?? 0)] = previous;

    this.lastUndoKey = null;
    this.select(null);
    this.#draw();
    this.opts.onUndoChange?.(this.undoStack.length);
    this.opts.onChange?.({});
    return true;
  }

  // ── Annotations ─────────────────────────────────────────────────────────

  /** Ajoute un meuble au centre de la vue. */
  addFurniture({ label = '', lengthMm, widthMm, color = FURNITURE_COLORS[0] }) {
    if (!this.layers) return null;
    this.pushUndo();
    const center = this.vp.toPdf(this.vp.width / 2, this.vp.height / 2);
    const item = {
      id: uid(),
      type: 'furniture',
      label,
      lengthMm,
      widthMm,
      color,
      cx: center.x,
      cy: center.y,
      rot: 0,
    };
    this.layer.furniture.push(item);
    this.select({ type: 'furniture', id: item.id });
    this.setTool('pan');
    this.#changed();
    return item;
  }

  /** Applique des modifications à l'objet sélectionné. */
  updateSelected(patch, undoKey = null) {
    const obj = this.getSelected();
    if (!obj) return;
    this.pushUndo(undoKey ?? `${Object.keys(patch).join(',')}:${obj.id}`);
    Object.assign(obj, patch);
    this.#changed();
  }

  rotateSelected(deltaDeg = 90) {
    const obj = this.getSelected();
    if (!obj || this.selection.type !== 'furniture') return;
    this.pushUndo();
    obj.rot = (((obj.rot + deltaDeg) % 360) + 360) % 360;
    this.#changed();
  }

  deleteSelected() {
    if (!this.selection || !this.layers) return;
    this.pushUndo();
    const key = this.selection.type === 'furniture' ? 'furniture' : 'measures';
    this.layer[key] = this.layer[key].filter((o) => o.id !== this.selection.id);
    this.select(null);
    this.#changed();
  }

  clearAnnotations() {
    if (!this.layers) return;
    this.pushUndo();
    this.layer.measures = [];
    this.layer.furniture = [];
    this.select(null);
    this.#changed();
  }

  getSelected() {
    if (!this.selection || !this.layers) return null;
    const list = this.selection.type === 'furniture' ? this.layer.furniture : this.layer.measures;
    return list.find((o) => o.id === this.selection.id) || null;
  }

  select(selection) {
    this.selection = selection;
    this.opts.onSelect?.(selection);
    this.#draw();
  }

  /** Exposé pour les tests : accrochage grille d'un point, en coordonnées PDF. */
  snapGridForTest(point) {
    return this.#snapGrid(point);
  }

  /** Recalcule l'affichage après un changement d'échelle ou d'unité. */
  refresh() {
    this.#draw();
  }

  /**
   * À appeler après une modification du calque faite hors des méthodes de la
   * vue : recale les cotes ancrées, repeint et déclenche la sauvegarde.
   */
  refreshLayer() {
    this.#changed();
  }

  // ── Gestes ──────────────────────────────────────────────────────────────

  #onDragStart(p) {
    if (!this.page) return;
    const pdfPoint = this.vp.toPdf(p.x, p.y);

    if (this.tool === 'measure' || this.tool === 'calibrate') {
      if (this.tool === 'calibrate') {
        // Segment de référence : libre, on accroche simplement au plus proche.
        const snap = this.#snap(pdfPoint);
        this.activeSnap = snap;
        const start = snap ? { x: snap.x, y: snap.y } : pdfPoint;
        this.draft = { origin: pdfPoint, a: start, b: start, axis: null, free: true };
      } else {
        // Cote : les deux extrémités seront posées sur des tracés que la cote
        // TRAVERSE. L'accrochage n'a donc de sens qu'une fois l'axe connu,
        // c'est-à-dire au premier déplacement — on garde le point brut ici.
        this.draft = { origin: pdfPoint, a: pdfPoint, b: pdfPoint, axis: null, free: false };
        this.activeSnap = null;
      }
      this.dragState = { kind: 'draft', startScreen: p };
      this.#draw();
      return;
    }

    // Poignée d'origine de la grille : elle n'existe que grille affichée, et
    // se saisit directement — c'est un réglage visible, pas une annotation
    // qu'on risquerait de déplacer sans le vouloir.
    if (this.gridEnabled && this.tool === 'pan') {
      const origin = this.gridOrigin();
      if (dist(pdfPoint, origin) <= this.vp.lengthToPdf(HANDLE_TOLERANCE_PX)) {
        this.dragState = { kind: 'grid', snapshot: structuredClone(this.layer) };
        this.select(null);
        return;
      }
    }

    // Outil navigation : c'est aussi lui qui sert à sélectionner et à éditer.
    //
    // Règle, pensée pour le doigt : seul l'objet DÉJÀ sélectionné se déplace.
    // Un glissement sur le plan, sur le vide comme sur un objet quelconque,
    // navigue toujours — impossible de décaler une cote par mégarde en
    // voulant simplement se déplacer dans le plan. La sélection, elle, se fait
    // par un appui simple, sans glissement.
    const hit = this.#hitTest(p, pdfPoint);
    const isSelected = hit && this.selection && hit.id === this.selection.id;

    if (isSelected) {
      // L'instantané est pris maintenant mais n'entre dans l'historique qu'à
      // la fin du geste, et seulement si quelque chose a bougé.
      this.dragState = { kind: 'move', hit, last: pdfPoint, snapshot: structuredClone(this.layer) };
      return;
    }
    this.dragState = { kind: 'pan', last: p, tapHit: hit };
  }

  #onDragMove(p) {
    const state = this.dragState;
    if (!state) return;

    if (state.kind === 'pan') {
      this.vp.panBy(p.x - state.last.x, p.y - state.last.y);
      state.last = p;
      this.vp.clampPan();
      this.#draw();
      return;
    }

    const pdfPoint = this.vp.toPdf(p.x, p.y);

    if (state.kind === 'draft') {
      this.#updateDraft(pdfPoint);
      this.#draw();
      return;
    }

    if (state.kind === 'grid') {
      const snap = this.#snapGridOrigin(pdfPoint);
      this.activeSnap = snap;
      const grid = this.gridState;
      grid.x = snap ? snap.x : pdfPoint.x;
      grid.y = snap ? snap.y : pdfPoint.y;
      this.#draw();
      return;
    }

    if (state.kind === 'move') {
      this.#applyMove(state, pdfPoint);
      this.#draw();
    }
  }

  #onDragEnd(p, moved) {
    const state = this.dragState;
    this.dragState = null;
    if (!state) return;

    if (state.kind === 'draft') {
      this.#commitDraft(p, moved);
      return;
    }

    if (state.kind === 'grid') {
      this.activeSnap = null;
      if (moved) {
        this.#pushSnapshot(state.snapshot);
        this.#changed();
      } else {
        this.#draw();
      }
      return;
    }

    if (state.kind === 'move') {
      this.activeSnap = null;
      this.activeSnapGuides = [];
      this.opts.onHud?.(null);
      if (moved) {
        this.#pushSnapshot(state.snapshot);
        this.lastUndoKey = null;
        this.#changed();
      } else {
        this.#draw();
      }
      return;
    }

    if (state.kind === 'pan') {
      if (moved) {
        this.#persistView();
        this.#scheduleQuality();
        return;
      }
      // Appui simple : sélectionne ce qui se trouve sous le doigt, ou
      // désélectionne si c'est le vide.
      this.select(state.tapHit ? { type: state.tapHit.type, id: state.tapHit.id } : null);
    }
  }

  #onDragCancel() {
    this.dragState = null;
    this.draft = null;
    this.activeSnap = null;
    this.activeSnapGuides = [];
    this.opts.onHud?.(null);
    this.#draw();
  }

  #onTransform({ dx, dy, scale, cx, cy }) {
    if (!this.page) return;
    if (dx || dy) this.vp.panBy(dx, dy);
    if (scale !== 1) this.vp.zoomAt(cx, cy, scale);
    this.vp.clampPan();
    this.#draw();
  }

  #onTransformEnd() {
    this.#persistView();
    this.#scheduleQuality();
  }

  #onDoubleTap(p) {
    if (!this.page) return;
    const zoomed = this.vp.scale > this.vp.fitScale * 1.2;
    if (zoomed) this.vp.fit();
    else this.vp.zoomAt(p.x, p.y, 2.5);
    this.vp.clampPan();
    this.#persistView();
    this.#draw();
    this.#scheduleQuality();
  }

  // ── Mesure ──────────────────────────────────────────────────────────────

  /** Axe PDF correspondant à l'axe écran demandé (tient compte de la rotation). */
  #pdfAxis(screenAxis) {
    const rotated = (this.vp.base?.rotation || 0) % 180 !== 0;
    if (!rotated) return screenAxis;
    return screenAxis === 'h' ? 'v' : 'h';
  }

  #updateDraft(pdfPoint) {
    const draft = this.draft;
    if (!draft) return;

    if (draft.free) {
      // Calibration : segment libre, accrochage 2D simple.
      const snap = this.#snap(pdfPoint);
      this.activeSnap = snap;
      draft.b = snap ? { x: snap.x, y: snap.y } : pdfPoint;
      this.opts.onHud?.(`Référence : ${Math.hypot(draft.b.x - draft.a.x, draft.b.y - draft.a.y).toFixed(1)} pt`);
      return;
    }

    // Cotation contrainte : l'axe dominant fixe la ligne de cote, qui passe par
    // le point de départ. Les DEUX extrémités sont ensuite posées sur les
    // tracés que cette ligne rencontre — une cote va d'un trait à l'autre.
    const origin = draft.origin;
    const o = this.vp.toScreen(origin.x, origin.y);
    const b = this.vp.toScreen(pdfPoint.x, pdfPoint.y);
    const screenAxis = Math.abs(b.x - o.x) >= Math.abs(b.y - o.y) ? 'h' : 'v';
    const axis = this.#pdfAxis(screenAxis);
    draft.axis = axis;

    const onLine = (point) =>
      axis === 'h' ? { x: point.x, y: origin.y } : { x: origin.x, y: point.y };

    const startSnap = this.#snapOnAxis(origin, axis, origin) || this.#snapGrid(onLine(origin), axis);
    draft.a = startSnap ? { x: startSnap.x, y: startSnap.y } : onLine(origin);
    draft.attachA = startSnap?.attach || null;

    const endSnap = this.#snapOnAxis(origin, axis, pdfPoint) || this.#snapGrid(onLine(pdfPoint), axis);
    this.activeSnap = endSnap;
    draft.b = endSnap ? { x: endSnap.x, y: endSnap.y } : onLine(pdfPoint);
    draft.attachB = endSnap?.attach || null;

    const lengthMm = dist(draft.a, draft.b) * mmPerPt(this.scale);
    this.opts.onHud?.(`${axis === 'h' ? '↔' : '↕'} ${formatLength(lengthMm, this.unit)}`);
  }

  #commitDraft(screenPoint, moved) {
    const draft = this.draft;
    this.draft = null;
    this.activeSnap = null;
    this.opts.onHud?.(null);
    if (!draft || !moved) {
      this.#draw();
      return;
    }

    const a = this.vp.toScreen(draft.a.x, draft.a.y);
    const b = this.vp.toScreen(draft.b.x, draft.b.y);
    if (Math.hypot(b.x - a.x, b.y - a.y) < MIN_MEASURE_PX) {
      this.#draw();
      return;
    }

    if (draft.free) {
      this.opts.onCalibrate?.(dist(draft.a, draft.b));
      this.#draw();
      return;
    }

    this.pushUndo();
    const measure = {
      id: uid(),
      type: 'measure',
      a: draft.a,
      b: draft.b,
      axis: draft.axis || 'h',
      // Extrémités posées sur l'arête d'un meuble : la cote reste solidaire de
      // ce meuble et se recalcule quand il bouge.
      attach: { a: draft.attachA || null, b: draft.attachB || null },
    };
    this.layer.measures.push(measure);
    this.#changed();

    // Retour à la navigation : une cote se pose, puis on regarde le plan. Sans
    // ça, le glissement suivant traçait une seconde cote au lieu de déplacer
    // la vue — et l'outil Mesurer empêche la sélection, donc la retouche.
    // La cote n'est pas sélectionnée pour autant : un volet d'édition surgissant
    // après chaque cote gênerait plus qu'il n'aiderait.
    this.setTool('pan');
  }

  // ── Accrochage ──────────────────────────────────────────────────────────

  /**
   * Boîte englobante d'un meuble. La rotation étant un multiple de 90°, elle
   * reste alignée sur les axes : une simple permutation largeur/longueur.
   */
  #furnitureBox(item) {
    const perMm = 1 / mmPerPt(this.scale);
    const quarterTurn = Math.abs(Math.round(item.rot / 90)) % 2 === 1;
    const bw = (quarterTurn ? item.widthMm : item.lengthMm) * perMm;
    const bh = (quarterTurn ? item.lengthMm : item.widthMm) * perMm;
    return {
      x0: item.cx - bw / 2,
      x1: item.cx + bw / 2,
      y0: item.cy - bh / 2,
      y1: item.cy + bh / 2,
    };
  }

  /**
   * Colle les arêtes d'un meuble à ce qui l'entoure : les tracés du plan, les
   * autres meubles, et à défaut la grille. C'est ce qui permet de plaquer un
   * meuble contre un mur, ou deux meubles bord à bord, au point près.
   *
   * Une seule correction par axe est retenue — la plus faible — pour ne pas
   * tirailler le rectangle entre deux murs opposés. La grille n'intervient que
   * sur les axes où rien n'a été trouvé : sinon elle défairait aussitôt
   * l'accrochage au mur, qui a toujours raison contre un repère abstrait.
   */
  #snapFurniture(item) {
    this.activeSnapGuides = [];
    const box = this.#furnitureBox(item);
    const grid = this.gridEnabled ? this.gridOrigin() : null;

    // Les deux axes sont calculés sur la MÊME boîte, avant toute correction :
    // appliquer l'un puis recalculer l'autre rendrait le résultat dépendant de
    // l'ordre, donc imprévisible au doigt.
    const horizontal = this.#bestFurnitureShift(item, 'v', box);
    const vertical = this.#bestFurnitureShift(item, 'h', box);

    const apply = (found, axis, edges, origin, from, to) => {
      if (found) {
        this.activeSnapGuides.push(found.guide);
        return found.shift;
      }
      if (origin === undefined) return 0;
      // Guide vert sur la ligne de grille retenue : sans lui, rien ne
      // distingue « posé sur le quadrillage » de « lâché à peu près là ».
      const { shift, value } = this.#gridShift(edges, origin);
      this.activeSnapGuides.push({ axis, value, from, to });
      return shift;
    };

    item.cx += apply(horizontal, 'v', [box.x0, box.x1], grid?.x, box.y0, box.y1);
    item.cy += apply(vertical, 'h', [box.y0, box.y1], grid?.y, box.x0, box.x1);
  }

  /**
   * Meilleure correction du meuble sur un axe : on essaie ses deux arêtes,
   * contre les tracés du plan puis contre les autres meubles, et on garde le
   * plus petit déplacement.
   *
   * `axis` vaut `'v'` pour les arêtes verticales (correction en x) et `'h'`
   * pour les horizontales (correction en y).
   */
  #bestFurnitureShift(item, axis, box) {
    if (!this.snapEnabled) return null;

    const radius = this.vp.lengthToPdf(FURNITURE_SNAP_PX);
    const vertical = axis === 'v';
    const edges = vertical ? [box.x0, box.x1] : [box.y0, box.y1];
    const from = vertical ? box.y0 : box.x0;
    const to = vertical ? box.y1 : box.x1;

    let best = null;
    const consider = (edge, value, guideFrom, guideTo) => {
      const shift = value - edge;
      if (Math.abs(shift) > radius) return;
      if (best && Math.abs(shift) >= Math.abs(best.shift)) return;
      best = { shift, guide: { axis, value, from: guideFrom, to: guideTo } };
    };

    for (const edge of edges) {
      if (this.snapIndex && !this.snapIndex.isEmpty) {
        const hit = this.snapIndex.nearestParallel(axis, edge, from, to, radius);
        if (hit !== null) consider(edge, hit, from, to);
      }

      // Les autres meubles, eux, accrochent même sans se faire face : aligner
      // une rangée de meubles sur un même nu d'un bout à l'autre de la pièce
      // est justement ce qu'on cherche à faire. Un tracé du plan, au
      // contraire, est un mur : on s'y adosse, on ne s'aligne pas sur son
      // prolongement — d'où la portée limitée imposée à `nearestParallel`.
      for (const other of this.layer?.furniture || []) {
        if (other.id === item.id) continue;
        const b = this.#furnitureBox(other);
        const lo = vertical ? b.y0 : b.x0;
        const hi = vertical ? b.y1 : b.x1;
        // Les deux arêtes du voisin : la proche pour se poser bord à bord, la
        // lointaine pour aligner les deux meubles sur un même nu.
        for (const value of vertical ? [b.x0, b.x1] : [b.y0, b.y1]) {
          consider(edge, value, Math.min(from, lo), Math.max(to, hi));
        }
      }
    }
    return best;
  }

  /**
   * Correction amenant l'arête la plus proche sur une ligne de grille, et
   * position de cette ligne.
   *
   * On aligne les ARÊTES, pas le centre : un meuble de 90 cm centré sur un
   * nœud a ses deux bords à 45 cm des lignes, et l'accrochage semble alors
   * sans rapport avec le quadrillage affiché.
   */
  #gridShift(edges, origin) {
    const step = this.#gridStepPt();
    let best = { shift: 0, value: edges[0] };
    let bestAbs = Infinity;
    for (const edge of edges) {
      const value = origin + Math.round((edge - origin) / step) * step;
      if (Math.abs(value - edge) < bestAbs) {
        bestAbs = Math.abs(value - edge);
        best = { shift: value - edge, value };
      }
    }
    return best;
  }

  get #snapRadiusPt() {
    return this.vp.lengthToPdf(SNAP_RADIUS_PX);
  }

  /**
   * Portée de la recherche élargie. Une cote doit relier deux traits : plutôt
   * que d'abandonner l'accrochage quand rien n'est sous le doigt, on cherche
   * plus loin. La recherche s'arrête au premier trait trouvé, donc elle ne
   * coûte cher que sur un plan très clairsemé.
   */
  get #maxSnapRadiusPt() {
    return this.snapIndex ? this.snapIndex.maxReach : this.#snapRadiusPt;
  }

  /** Pas de la grille en points PDF (1 m ou 50 cm selon le réglage). */
  #gridStepPt() {
    return (this.gridState?.stepMm ?? GRID_STEPS_MM[0]) / mmPerPt(this.scale);
  }

  #snapGrid(point, axis = null) {
    if (!this.gridEnabled) return null;
    const step = this.#gridStepPt();
    const origin = this.gridOrigin();
    // Le pas est compté depuis l'origine, pas depuis le coin de la page :
    // c'est tout l'intérêt de pouvoir déplacer celle-ci.
    const round = (v, o) => o + Math.round((v - o) / step) * step;
    if (axis === 'h') return { x: round(point.x, origin.x), y: point.y, kind: 'grid' };
    if (axis === 'v') return { x: point.x, y: round(point.y, origin.y), kind: 'grid' };
    return { x: round(point.x, origin.x), y: round(point.y, origin.y), kind: 'grid' };
  }

  /**
   * Accrochage de l'origine de la grille : les angles d'abord — c'est le
   * repère naturel — puis les tracés, puis rien.
   */
  #snapGridOrigin(point) {
    if (!this.snapEnabled || !this.snapIndex || this.snapIndex.isEmpty) return null;
    const radius = this.vp.lengthToPdf(HANDLE_TOLERANCE_PX);
    return this.snapIndex.nearestCorner(point, radius) ?? this.snapIndex.nearest(point, radius);
  }

  /** Accrochage 2D : tracés du PDF, puis extrémités d'annotations, puis grille. */
  #snap(point) {
    const radius = this.#snapRadiusPt;
    if (this.snapEnabled && this.snapIndex) {
      const hit = this.snapIndex.nearest(point, radius, this.#maxSnapRadiusPt);
      if (hit) return hit;
    }
    const own = this.#snapToAnnotations(point, radius);
    if (own) return own;
    return this.#snapGrid(point);
  }

  /** Accrochage contraint le long de l'axe de cote. */
  #snapOnAxis(anchor, axis, point) {
    if (!this.snapEnabled) return null;
    const target = axis === 'h' ? point.x : point.y;
    let best = null;
    let bestD = Infinity;

    const consider = (candidate) => {
      if (!candidate) return;
      const d = Math.abs((axis === 'h' ? candidate.x : candidate.y) - target);
      if (d < bestD) {
        bestD = d;
        best = candidate;
      }
    };

    if (this.snapIndex) {
      // Intersection du trait de cote avec un tracé du plan : c'est ce qui
      // fait coter d'un mur à l'autre.
      consider(this.snapIndex.nearestOnAxis(anchor, axis, point, this.#snapRadiusPt, this.#maxSnapRadiusPt));
    }
    // Les meubles posés sont eux aussi des obstacles à coter : leurs arêtes
    // valent les murs du plan.
    consider(this.#furnitureEdgeOnAxis(anchor, axis, target));
    return best;
  }

  /**
   * Arête de meuble traversée par le trait de cote, la plus proche du doigt.
   * @param {'h'|'v'} axis direction de la cote
   */
  #furnitureEdgeOnAxis(anchor, axis, target) {
    let best = null;
    let bestD = Infinity;

    for (const item of this.layer?.furniture || []) {
      const box = this.#furnitureBox(item);
      // Le trait de cote doit réellement traverser le meuble.
      const across = axis === 'h' ? anchor.y : anchor.x;
      const lo = axis === 'h' ? box.y0 : box.x0;
      const hi = axis === 'h' ? box.y1 : box.x1;
      if (across < lo || across > hi) continue;

      for (const name of axis === 'h' ? ['x0', 'x1'] : ['y0', 'y1']) {
        const edge = box[name];
        const d = Math.abs(edge - target);
        if (d >= bestD) continue;
        bestD = d;
        // `anchor` retient le meuble et l'arête visés : c'est ce qui permettra
        // à la cote de suivre le meuble quand il sera déplacé.
        const attach = { id: item.id, edge: name };
        best =
          axis === 'h'
            ? { x: edge, y: anchor.y, kind: 'edge', attach }
            : { x: anchor.x, y: edge, kind: 'edge', attach };
      }
    }
    return best;
  }

  /** Les extrémités des cotes existantes servent aussi de points d'accrochage. */
  #snapToAnnotations(point, radius) {
    let best = null;
    let bestD = radius;
    const consider = (p) => {
      const d = dist(point, p);
      if (d < bestD) {
        bestD = d;
        best = { x: p.x, y: p.y, kind: 'endpoint' };
      }
    };
    for (const m of this.layer?.measures || []) {
      if (this.selection?.id === m.id) continue;
      consider(m.a);
      consider(m.b);
    }
    for (const f of this.layer?.furniture || []) {
      const perMm = 1 / mmPerPt(this.scale);
      for (const c of rectCorners(f.cx, f.cy, f.lengthMm * perMm, f.widthMm * perMm, f.rot)) consider(c);
    }
    return best;
  }

  #buildSnapIndex() {
    if (!this.page) return;
    const page = this.page;
    extractSegments(page)
      .then((segments) => {
        if (this.page !== page) return; // page changée entre-temps
        const [x0, y0, x1, y1] = page.view;
        this.snapIndex = new SnapIndex(segments, {
          x: x0,
          y: y0,
          width: x1 - x0,
          height: y1 - y0,
        });
        this.opts.onVectorInfo?.(this.snapIndex.count);
      })
      .catch((err) => {
        console.warn("Extraction des tracés impossible, l'accrochage sera désactivé", err);
        this.snapIndex = null;
        this.opts.onVectorInfo?.(0);
      });
  }

  // ── Sélection / déplacement ─────────────────────────────────────────────

  #hitTest(screenPoint, pdfPoint) {
    const tol = this.vp.lengthToPdf(HIT_TOLERANCE_PX);
    const handleTol = this.vp.lengthToPdf(HANDLE_TOLERANCE_PX);

    // Priorité absolue aux poignées de la cote déjà sélectionnée : c'est ce
    // qui permet de saisir une extrémité même quand le corps de la cote, ou
    // un meuble, passe juste dessous.
    const selected = this.getSelected();
    if (selected && this.selection.type === 'measure') {
      for (const end of ['a', 'b']) {
        if (dist(pdfPoint, selected[end]) <= handleTol) {
          return { type: 'measure', id: selected.id, part: end, object: selected };
        }
      }
    }

    const measures = this.layer?.measures || [];
    for (let i = measures.length - 1; i >= 0; i--) {
      const m = measures[i];
      for (const end of ['a', 'b']) {
        if (dist(pdfPoint, m[end]) <= tol) return { type: 'measure', id: m.id, part: end, object: m };
      }
      const near = closestPointOnMeasure(pdfPoint, m);
      if (near <= tol) return { type: 'measure', id: m.id, part: 'body', object: m };
    }

    const furniture = this.layer?.furniture || [];
    const perMm = 1 / mmPerPt(this.scale);
    for (let i = furniture.length - 1; i >= 0; i--) {
      const f = furniture[i];
      if (pointInRect(pdfPoint, f.cx, f.cy, f.lengthMm * perMm, f.widthMm * perMm, f.rot, tol / 2)) {
        return { type: 'furniture', id: f.id, part: 'body', object: f };
      }
    }
    return null;
  }

  #applyMove(state, pdfPoint) {
    const { hit } = state;
    const dx = pdfPoint.x - state.last.x;
    const dy = pdfPoint.y - state.last.y;
    state.last = pdfPoint;

    if (hit.type === 'furniture') {
      // On repart de la position libre à chaque déplacement : sans ça, un
      // accrochage précédent freinerait le meuble contre le mur qui l'a happé.
      state.free = state.free || { cx: hit.object.cx, cy: hit.object.cy };
      state.free.cx += dx;
      state.free.cy += dy;
      hit.object.cx = state.free.cx;
      hit.object.cy = state.free.cy;

      // Murs, meubles voisins et grille sont traités ensemble : les faire
      // jouer l'un après l'autre revenait à ce que le dernier écrase le
      // précédent, et la grille paraissait sans effet.
      this.#snapFurniture(hit.object);
      // Pendant le glissement, pas seulement à son terme : une cote qui ne
      // rattraperait le meuble qu'au lâcher donnerait une valeur fausse tout
      // le temps du geste, précisément quand on la regarde.
      this.#syncAttachedMeasures();
      return;
    }

    const m = hit.object;
    if (hit.part === 'body') {
      m.a = { x: m.a.x + dx, y: m.a.y + dy };
      m.b = { x: m.b.x + dx, y: m.b.y + dy };
      // Emmener une cote ailleurs, c'est la détacher : sans ça elle serait
      // ramenée sur son meuble au premier recalcul, et paraîtrait bloquée.
      m.attach = null;
      return;
    }

    // Déplacement d'une extrémité : la contrainte d'axe est conservée.
    const anchor = hit.part === 'a' ? m.b : m.a;
    const axis = m.axis || 'h';
    const constrained = axis === 'h' ? { x: pdfPoint.x, y: anchor.y } : { x: anchor.x, y: pdfPoint.y };
    const snap = this.#snapOnAxis(anchor, axis, pdfPoint) || this.#snapGrid(constrained, axis);
    this.activeSnap = snap;
    m[hit.part] = snap ? { x: snap.x, y: snap.y } : constrained;
    // L'extrémité reprise change d'ancre — ou en perd une si elle atterrit sur
    // un mur ou dans le vide.
    m.attach = { ...(m.attach || { a: null, b: null }), [hit.part]: snap?.attach || null };

    const lengthMm = dist(m.a, m.b) * mmPerPt(this.scale);
    this.opts.onHud?.(formatLength(lengthMm, this.unit));
  }

  // ── Rendu ───────────────────────────────────────────────────────────────

  #draw() {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      this.#paint();
    });
  }

  #paint() {
    const ctx = this.ctx;
    if (!ctx || !this.canvas.width) return;
    const dpr = this.dpr || 1;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a0d12';
    ctx.fillRect(0, 0, this.vp.width, this.vp.height);

    if (!this.page) return;

    this.renderer.drawInto(ctx, this.vp);

    if (this.gridEnabled) {
      const origin = this.gridOrigin();
      drawGrid(ctx, this.vp, this.#gridStepPt(), origin);
    }

    const opts = { scale: this.scale, unit: this.unit };
    for (const f of this.layer?.furniture || []) {
      drawFurniture(ctx, this.vp, f, {
        ...opts,
        selected: this.selection?.id === f.id,
        showDimensions: this.showDimensions,
      });
    }
    for (const m of this.layer?.measures || []) {
      drawMeasure(ctx, this.vp, m, { ...opts, selected: this.selection?.id === m.id });
    }

    if (this.draft) {
      if (this.draft.axis) drawAxisGuide(ctx, this.vp, this.draft.origin, this.draft.axis);
      drawDraftMeasure(ctx, this.vp, this.draft, opts);
    }
    if (this.gridEnabled) drawGridOrigin(ctx, this.vp, this.gridOrigin());
    if (this.activeSnapGuides.length) drawSnapGuides(ctx, this.vp, this.activeSnapGuides);
    if (this.activeSnap) drawSnapMarker(ctx, this.vp, this.activeSnap);

    this.#updateMinimap();
    this.opts.onZoom?.(Math.round((this.vp.scale / this.vp.fitScale) * 100));
  }

  #scheduleQuality() {
    clearTimeout(this.qualityTimer);
    this.qualityTimer = setTimeout(() => this.#renderQuality(), QUALITY_DEBOUNCE_MS);
  }

  async #renderQuality() {
    if (!this.page) return;
    const deviceScale = this.vp.scale * (this.dpr || 1);
    if (!this.renderer.needsRerender(deviceScale)) return;
    try {
      await this.renderer.render(deviceScale);
      this.#draw();
    } catch (err) {
      console.error('Rendu de la page impossible', err);
    }
  }

  // ── Mini-carte ──────────────────────────────────────────────────────────

  #setupMinimap({ root, canvas, view }) {
    this.minimap = { root, canvas, view, ctx: canvas.getContext('2d') };
    const jump = (event) => {
      if (!this.page || !this.thumbnail) return;
      const rect = canvas.getBoundingClientRect();
      const fx = (event.clientX - rect.left) / rect.width;
      const fy = (event.clientY - rect.top) / rect.height;
      const target = this.vp.base.convertToPdfPoint(fx * this.vp.base.width, fy * this.vp.base.height);
      this.vp.centerOn(target[0], target[1]);
      this.vp.clampPan();
      this.#persistView();
      this.#draw();
      this.#scheduleQuality();
    };
    root.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      jump(e);
    });
  }

  async #buildThumbnail() {
    if (!this.minimap) return;
    const page = this.page;
    const thumb = await this.renderer.thumbnail(240);
    if (!thumb || this.page !== page) return;
    this.thumbnail = thumb;
    const { canvas, ctx } = this.minimap;
    canvas.width = thumb.width;
    canvas.height = thumb.height;
    ctx.drawImage(thumb, 0, 0);
    this.#updateMinimap();
  }

  #updateMinimap() {
    if (!this.minimap || !this.thumbnail || !this.vp.base) return;
    const zoomed = this.vp.scale > this.vp.fitScale * 1.35;
    this.minimap.root.hidden = !zoomed;
    if (!zoomed) return;

    const rect = this.vp.visibleBaseRect();
    const w = this.minimap.canvas.clientWidth || this.thumbnail.width;
    const h = (w * this.thumbnail.height) / this.thumbnail.width;
    const sx = w / this.vp.base.width;
    const sy = h / this.vp.base.height;

    const left = clamp(rect.x * sx, 0, w);
    const top = clamp(rect.y * sy, 0, h);
    const width = clamp(rect.width * sx, 4, w - left);
    const height = clamp(rect.height * sy, 4, h - top);

    Object.assign(this.minimap.view.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`,
    });
  }

  // ── Divers ──────────────────────────────────────────────────────────────

  #persistView() {
    if (!this.layers) return;
    this.layer.view = this.vp.toJSON();
    this.opts.onChange?.({ viewOnly: true });
  }

  #changed() {
    this.#syncAttachedMeasures();
    this.#draw();
    this.opts.onChange?.({});
  }

  /**
   * Recale les cotes posées sur un meuble.
   *
   * Une cote entre un mur et un meuble, ou entre deux meubles, n'a de sens que
   * si elle suit le meuble : sans ça, déplacer un meuble de 10 cm laissait une
   * cote qui affirmait toujours l'ancienne distance, sans rien signaler.
   *
   * Appelé depuis `#changed()`, donc après *toute* modification du calque —
   * déplacement, rotation, redimensionnement, suppression, annulation. C'est
   * volontaire : une liste d'appels ciblés finirait par en oublier un.
   */
  #syncAttachedMeasures() {
    const layer = this.layer;
    if (!layer?.measures?.length) return;

    const boxes = new Map();
    for (const item of layer.furniture) boxes.set(item.id, this.#furnitureBox(item));

    for (const m of layer.measures) {
      if (!m.attach) continue;
      const axis = m.axis || 'h';

      // Le meuble a disparu : on relâche l'ancre plutôt que de traîner une
      // référence morte. La cote reste où elle est, figée.
      for (const end of ['a', 'b']) {
        if (m.attach[end] && !boxes.has(m.attach[end].id)) m.attach[end] = null;
      }
      if (!m.attach.a && !m.attach.b) continue;

      // Réorientation : le trait de cote doit continuer de traverser le meuble
      // qu'il désigne, sinon il pointerait une arête qu'il ne rencontre plus.
      // On le ramène dans l'emprise commune aux meubles ancrés.
      let lo = -Infinity;
      let hi = Infinity;
      for (const end of ['a', 'b']) {
        const box = m.attach[end] && boxes.get(m.attach[end].id);
        if (!box) continue;
        lo = Math.max(lo, axis === 'h' ? box.y0 : box.x0);
        hi = Math.min(hi, axis === 'h' ? box.y1 : box.x1);
      }
      if (lo <= hi) {
        const across = clamp(axis === 'h' ? m.a.y : m.a.x, lo, hi);
        if (axis === 'h') m.a.y = m.b.y = across;
        else m.a.x = m.b.x = across;
      }

      // Puis chaque extrémité ancrée reprend la position de son arête.
      for (const end of ['a', 'b']) {
        const attach = m.attach[end];
        if (!attach) continue;
        const value = boxes.get(attach.id)[attach.edge];
        if (axis === 'h') m[end].x = value;
        else m[end].y = value;
      }
    }
  }
}

/** Distance d'un point au segment d'une cote. */
function closestPointOnMeasure(p, m) {
  const dx = m.b.x - m.a.x;
  const dy = m.b.y - m.a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, m.a);
  const t = clamp(((p.x - m.a.x) * dx + (p.y - m.a.y) * dy) / len2, 0, 1);
  return Math.hypot(p.x - (m.a.x + t * dx), p.y - (m.a.y + t * dy));
}
