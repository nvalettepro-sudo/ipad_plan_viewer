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
  drawMeasure,
  drawSnapMarker,
  FURNITURE_COLORS,
} from './overlay.js';
import { PageRenderer } from './renderer.js';
import { Viewport } from './viewport.js';

const HIT_TOLERANCE_PX = 16; // zone tactile généreuse : pas de précision au pixel
const SNAP_RADIUS_PX = 22;
const MIN_MEASURE_PX = 12;
const QUALITY_DEBOUNCE_MS = 220;
const GRID_STEPS_MM = [100, 250, 500, 1000, 2000, 5000];

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
    this.selection = null;
    this.draft = null;
    this.activeSnap = null;
    this.dragState = null;
    this.thumbnail = null;

    this.drawQueued = false;
    this.qualityTimer = null;

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
    if (tool !== 'select') this.select(null);
    this.opts.onHud?.(tool === 'calibrate' ? 'Tracez le segment de référence' : null);
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
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.dpr = dpr;
    this.vp.setContainer(rect.width, rect.height);
    this.vp.refreshFitScale();
    this.vp.clampPan();
    if (!silent) {
      this.#draw();
      this.#scheduleQuality();
    }
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

  // ── Annotations ─────────────────────────────────────────────────────────

  /** Ajoute un meuble au centre de la vue. */
  addFurniture({ label = '', lengthMm, widthMm, color = FURNITURE_COLORS[0] }) {
    if (!this.layers) return null;
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
    this.setTool('select');
    this.#changed();
    return item;
  }

  /** Applique des modifications à l'objet sélectionné. */
  updateSelected(patch) {
    const obj = this.getSelected();
    if (!obj) return;
    Object.assign(obj, patch);
    this.#changed();
  }

  rotateSelected(deltaDeg = 90) {
    const obj = this.getSelected();
    if (!obj || this.selection.type !== 'furniture') return;
    obj.rot = (((obj.rot + deltaDeg) % 360) + 360) % 360;
    this.#changed();
  }

  deleteSelected() {
    if (!this.selection || !this.layers) return;
    const key = this.selection.type === 'furniture' ? 'furniture' : 'measures';
    this.layer[key] = this.layer[key].filter((o) => o.id !== this.selection.id);
    this.select(null);
    this.#changed();
  }

  clearAnnotations() {
    if (!this.layers) return;
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

  /** Recalcule l'affichage après un changement d'échelle ou d'unité. */
  refresh() {
    this.#draw();
  }

  // ── Gestes ──────────────────────────────────────────────────────────────

  #onDragStart(p) {
    if (!this.page) return;
    const pdfPoint = this.vp.toPdf(p.x, p.y);

    if (this.tool === 'pan') {
      this.dragState = { kind: 'pan', last: p };
      return;
    }

    if (this.tool === 'measure' || this.tool === 'calibrate') {
      const snap = this.#snap(pdfPoint);
      this.activeSnap = snap;
      // On ne conserve que les coordonnées : `kind` ne sert qu'à l'affichage
      // du repère d'accrochage et n'a rien à faire dans les données stockées.
      const start = snap ? { x: snap.x, y: snap.y } : pdfPoint;
      this.draft = { a: start, b: start, axis: null, free: this.tool === 'calibrate' };
      this.dragState = { kind: 'draft', startScreen: p };
      this.#draw();
      return;
    }

    // Outil « sélection »
    const hit = this.#hitTest(p, pdfPoint);
    if (hit) {
      this.select({ type: hit.type, id: hit.id });
      this.dragState = { kind: 'move', hit, last: pdfPoint, origin: pdfPoint, snapshot: hit.snapshot };
    } else {
      this.select(null);
      this.dragState = { kind: 'pan', last: p };
    }
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

    if (state.kind === 'move') {
      this.activeSnap = null;
      this.opts.onHud?.(null);
      if (moved) this.#changed();
      else this.#draw();
    }
    if (state.kind === 'pan') {
      this.#persistView();
      this.#scheduleQuality();
    }
  }

  #onDragCancel() {
    this.dragState = null;
    this.draft = null;
    this.activeSnap = null;
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

    // Cotation contrainte : on choisit l'axe dominant, puis on ne bouge que
    // la coordonnée libre — comme une cote d'architecte.
    const a = this.vp.toScreen(draft.a.x, draft.a.y);
    const b = this.vp.toScreen(pdfPoint.x, pdfPoint.y);
    const screenAxis = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? 'h' : 'v';
    const axis = this.#pdfAxis(screenAxis);
    draft.axis = axis;

    const constrained =
      axis === 'h' ? { x: pdfPoint.x, y: draft.a.y } : { x: draft.a.x, y: pdfPoint.y };

    const snap = this.#snapOnAxis(draft.a, axis, pdfPoint) || this.#snapGrid(constrained, axis);
    this.activeSnap = snap;
    draft.b = snap ? { x: snap.x, y: snap.y } : constrained;

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

    const measure = {
      id: uid(),
      type: 'measure',
      a: draft.a,
      b: draft.b,
      axis: draft.axis || 'h',
    };
    this.layer.measures.push(measure);
    this.#changed();
  }

  // ── Accrochage ──────────────────────────────────────────────────────────

  get #snapRadiusPt() {
    return this.vp.lengthToPdf(SNAP_RADIUS_PX);
  }

  /** Pas de grille adapté au zoom courant, exprimé en points PDF. */
  #gridStepPt() {
    const perMm = 1 / mmPerPt(this.scale);
    for (const stepMm of GRID_STEPS_MM) {
      const stepPt = stepMm * perMm;
      if (this.vp.lengthToScreen(stepPt) >= 14) return stepPt;
    }
    return GRID_STEPS_MM[GRID_STEPS_MM.length - 1] * perMm;
  }

  #snapGrid(point, axis = null) {
    if (!this.gridEnabled) return null;
    const step = this.#gridStepPt();
    const round = (v) => Math.round(v / step) * step;
    if (axis === 'h') return { x: round(point.x), y: point.y, kind: 'grid' };
    if (axis === 'v') return { x: point.x, y: round(point.y), kind: 'grid' };
    return { x: round(point.x), y: round(point.y), kind: 'grid' };
  }

  /** Accrochage 2D : tracés du PDF, puis extrémités d'annotations, puis grille. */
  #snap(point) {
    const radius = this.#snapRadiusPt;
    if (this.snapEnabled && this.snapIndex) {
      const hit = this.snapIndex.nearest(point, radius);
      if (hit) return hit;
    }
    const own = this.#snapToAnnotations(point, radius);
    if (own) return own;
    return this.#snapGrid(point);
  }

  /** Accrochage contraint le long de l'axe de cote. */
  #snapOnAxis(anchor, axis, point) {
    const radius = this.#snapRadiusPt;
    if (this.snapEnabled && this.snapIndex) {
      const hit = this.snapIndex.nearestOnAxis(anchor, axis, point, radius);
      if (hit) return hit;
    }
    return null;
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

    // Priorité aux poignées de la cote déjà sélectionnée.
    const selected = this.getSelected();
    if (selected && this.selection.type === 'measure') {
      for (const end of ['a', 'b']) {
        if (dist(pdfPoint, selected[end]) <= tol) {
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
      hit.object.cx += dx;
      hit.object.cy += dy;
      const snapped = this.#snapGrid({ x: hit.object.cx, y: hit.object.cy });
      if (snapped) {
        hit.object.cx = snapped.x;
        hit.object.cy = snapped.y;
      }
      return;
    }

    const m = hit.object;
    if (hit.part === 'body') {
      m.a = { x: m.a.x + dx, y: m.a.y + dy };
      m.b = { x: m.b.x + dx, y: m.b.y + dy };
      return;
    }

    // Déplacement d'une extrémité : la contrainte d'axe est conservée.
    const anchor = hit.part === 'a' ? m.b : m.a;
    const axis = m.axis || 'h';
    const constrained = axis === 'h' ? { x: pdfPoint.x, y: anchor.y } : { x: anchor.x, y: pdfPoint.y };
    const snap = this.#snapOnAxis(anchor, axis, pdfPoint) || this.#snapGrid(constrained, axis);
    this.activeSnap = snap;
    m[hit.part] = snap ? { x: snap.x, y: snap.y } : constrained;

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

    if (this.gridEnabled) drawGrid(ctx, this.vp, this.#gridStepPt());

    const opts = { scale: this.scale, unit: this.unit };
    for (const f of this.layer?.furniture || []) {
      drawFurniture(ctx, this.vp, f, { ...opts, selected: this.selection?.id === f.id });
    }
    for (const m of this.layer?.measures || []) {
      drawMeasure(ctx, this.vp, m, { ...opts, selected: this.selection?.id === m.id });
    }

    if (this.draft) {
      if (this.draft.axis) drawAxisGuide(ctx, this.vp, this.draft.a, this.draft.axis);
      drawDraftMeasure(ctx, this.vp, this.draft, opts);
    }
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
    this.#draw();
    this.opts.onChange?.({});
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
