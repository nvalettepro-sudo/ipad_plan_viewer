/**
 * Rendu de la page PDF dans un bitmap réutilisable.
 *
 * Stratégie : on rend la page une fois dans un canvas hors écran, puis chaque
 * image de l'animation ne fait qu'un `drawImage` — le pan/zoom reste fluide au
 * doigt. Quand le zoom s'écarte trop de la résolution du bitmap, on relance un
 * rendu (différé) à la bonne définition.
 *
 * Contrainte iPad n°5 : le nombre de pixels du bitmap est plafonné. Pour du A3
 * à A4 le plafond n'est jamais atteint, mais il protège d'un plantage mémoire
 * si un grand format est importé un jour.
 */

const MAX_PIXELS = 14_000_000; // ≈ 56 Mo en RGBA

export class PageRenderer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    /** @type {import('pdfjs-dist').PDFPageProxy|null} */
    this.page = null;
    this.base = null;
    this.renderScale = 0;
    this.ready = false;
    this.task = null;
    this.pending = null;
  }

  setPage(page, base) {
    this.cancel();
    this.page = page;
    this.base = base;
    this.renderScale = 0;
    this.ready = false;
  }

  cancel() {
    if (this.task) {
      try {
        this.task.cancel();
      } catch {
        /* déjà terminé */
      }
      this.task = null;
    }
  }

  /** Échelle de rendu réellement applicable, plafond mémoire compris. */
  clampScale(scale) {
    if (!this.base) return 1;
    const maxByPixels = Math.sqrt(MAX_PIXELS / (this.base.width * this.base.height));
    return Math.max(0.1, Math.min(scale, maxByPixels));
  }

  /**
   * Rend la page à l'échelle demandée (pixels du bitmap par point PDF).
   * Les appels successifs annulent le rendu précédent.
   */
  async render(scale) {
    if (!this.page || !this.base) return;
    const target = this.clampScale(scale);
    this.cancel();

    const viewport = this.page.getViewport({ scale: target });
    const width = Math.max(1, Math.floor(viewport.width));
    const height = Math.max(1, Math.floor(viewport.height));

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(0, 0, width, height);

    const task = this.page.render({
      canvas: this.canvas,
      canvasContext: this.ctx,
      viewport,
      background: '#ffffff',
    });
    this.task = task;

    try {
      await task.promise;
      this.renderScale = target;
      this.ready = true;
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException') throw err;
    } finally {
      if (this.task === task) this.task = null;
    }
  }

  /**
   * Vérifie si le bitmap est assez (ou trop) défini pour le zoom courant.
   * @param {number} deviceScale zoom écran × devicePixelRatio
   */
  needsRerender(deviceScale) {
    if (!this.ready) return true;
    const wanted = this.clampScale(deviceScale);
    const ratio = wanted / this.renderScale;
    return ratio > 1.35 || ratio < 0.5;
  }

  /** Dessine le bitmap dans le canvas visible, à la position du viewport. */
  drawInto(ctx, viewport) {
    if (!this.ready || !this.base) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      this.canvas,
      viewport.tx,
      viewport.ty,
      this.base.width * viewport.scale,
      this.base.height * viewport.scale,
    );
  }

  /** Petite image de la page entière, pour la mini-carte. */
  async thumbnail(maxWidth = 320) {
    if (!this.page || !this.base) return null;
    const scale = Math.min(maxWidth / this.base.width, 1);
    const viewport = this.page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await this.page.render({ canvas, canvasContext: ctx, viewport, background: '#ffffff' }).promise;
    return canvas;
  }

  destroy() {
    this.cancel();
    this.canvas.width = 0;
    this.canvas.height = 0;
    this.page = null;
    this.ready = false;
  }
}
