/**
 * Transformation entre l'espace PDF (points, origine en bas à gauche) et
 * l'écran (pixels CSS, origine en haut à gauche).
 *
 * On s'appuie sur un « viewport de référence » PDF.js à l'échelle 1, qui gère
 * déjà le retournement de l'axe Y, la rotation de page et le décalage de la
 * CropBox. Le zoom/déplacement de l'utilisateur est appliqué par-dessus :
 *
 *     écran = base(pdf) × zoom + translation
 */

import { clamp } from '../core/geometry.js';

export class Viewport {
  constructor() {
    /** @type {import('pdfjs-dist').PageViewport|null} */
    this.base = null;
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this.fitScale = 1;
    this.width = 0;
    this.height = 0;
  }

  /** Associe le viewport de référence (échelle 1) de la page courante. */
  setBase(base) {
    this.base = base;
  }

  /** Dimensions de la zone d'affichage, en pixels CSS. */
  setContainer(width, height) {
    this.width = width;
    this.height = height;
  }

  get minScale() {
    return this.fitScale * 0.4;
  }

  get maxScale() {
    return this.fitScale * 32;
  }

  /** Ajuste la page à l'écran et la centre. */
  fit(padding = 16) {
    if (!this.base) return;
    const sx = (this.width - padding * 2) / this.base.width;
    const sy = (this.height - padding * 2) / this.base.height;
    this.fitScale = Math.max(0.01, Math.min(sx, sy));
    this.scale = this.fitScale;
    this.tx = (this.width - this.base.width * this.scale) / 2;
    this.ty = (this.height - this.base.height * this.scale) / 2;
  }

  /** Recalcule uniquement `fitScale` (après rotation de l'iPad par exemple). */
  refreshFitScale(padding = 16) {
    if (!this.base) return;
    const sx = (this.width - padding * 2) / this.base.width;
    const sy = (this.height - padding * 2) / this.base.height;
    this.fitScale = Math.max(0.01, Math.min(sx, sy));
  }

  /** PDF → écran. */
  toScreen(x, y) {
    const [vx, vy] = this.base.convertToViewportPoint(x, y);
    return { x: vx * this.scale + this.tx, y: vy * this.scale + this.ty };
  }

  /** Écran → PDF. */
  toPdf(x, y) {
    const [px, py] = this.base.convertToPdfPoint((x - this.tx) / this.scale, (y - this.ty) / this.scale);
    return { x: px, y: py };
  }

  /** Longueur PDF (points) → longueur écran (px CSS). */
  lengthToScreen(lengthPt) {
    return lengthPt * this.scale;
  }

  /** Longueur écran (px CSS) → longueur PDF (points). */
  lengthToPdf(lengthPx) {
    return lengthPx / this.scale;
  }

  panBy(dx, dy) {
    this.tx += dx;
    this.ty += dy;
  }

  /** Zoome d'un facteur donné en gardant le point écran `(cx,cy)` fixe. */
  zoomAt(cx, cy, factor) {
    const next = clamp(this.scale * factor, this.minScale, this.maxScale);
    const applied = next / this.scale;
    this.tx = cx - (cx - this.tx) * applied;
    this.ty = cy - (cy - this.ty) * applied;
    this.scale = next;
  }

  /** Centre la vue sur un point PDF, sans changer le zoom. */
  centerOn(x, y) {
    const [vx, vy] = this.base.convertToViewportPoint(x, y);
    this.tx = this.width / 2 - vx * this.scale;
    this.ty = this.height / 2 - vy * this.scale;
  }

  /**
   * Empêche de « perdre » le plan hors de l'écran : on garde toujours une
   * marge visible, ou on recentre si la page est plus petite que la zone.
   */
  clampPan(margin = 80) {
    if (!this.base) return;
    const w = this.base.width * this.scale;
    const h = this.base.height * this.scale;

    if (w <= this.width) this.tx = (this.width - w) / 2;
    else this.tx = clamp(this.tx, this.width - w - margin, margin);

    if (h <= this.height) this.ty = (this.height - h) / 2;
    else this.ty = clamp(this.ty, this.height - h - margin, margin);
  }

  /** Rectangle visible, exprimé dans le viewport de référence (échelle 1). */
  visibleBaseRect() {
    return {
      x: -this.tx / this.scale,
      y: -this.ty / this.scale,
      width: this.width / this.scale,
      height: this.height / this.scale,
    };
  }

  toJSON() {
    return { scale: this.scale, tx: this.tx, ty: this.ty };
  }

  restore(state) {
    if (!state || !Number.isFinite(state.scale)) return false;
    this.scale = clamp(state.scale, this.minScale, this.maxScale);
    this.tx = state.tx;
    this.ty = state.ty;
    return true;
  }
}
