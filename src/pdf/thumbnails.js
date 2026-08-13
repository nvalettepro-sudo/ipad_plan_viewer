/**
 * Vignettes de pages, pour le sélecteur de page.
 *
 * Sur un carnet, les pages ne se distinguent pas par leur numéro : il faut les
 * voir. Le rendu est séquentiel et interruptible — inutile de continuer à
 * calculer des vignettes après la fermeture du dialogue.
 */

/**
 * Rend une page dans un canvas de largeur `maxWidth` (pixels CSS).
 * @param {import('pdfjs-dist').PDFDocumentProxy} pdf
 * @param {number} index index de page à partir de 0
 */
export async function renderThumbnail(pdf, index, maxWidth = 160) {
  const page = await pdf.getPage(index + 1);
  const base = page.getViewport({ scale: 1 });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport({ scale: (maxWidth / base.width) * dpr });

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  canvas.style.width = `${maxWidth}px`;
  canvas.style.height = `${Math.round(viewport.height / dpr)}px`;

  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport, background: '#ffffff' }).promise;
  return canvas;
}

/**
 * Rend les vignettes une par une et les livre au fur et à mesure.
 * @param {() => boolean} shouldStop appelé avant chaque page
 */
export async function renderThumbnails(pdf, onReady, { maxWidth = 160, shouldStop } = {}) {
  for (let i = 0; i < pdf.numPages; i++) {
    if (shouldStop?.()) return;
    try {
      onReady(i, await renderThumbnail(pdf, i, maxWidth));
    } catch (err) {
      console.warn(`Vignette de la page ${i + 1} impossible`, err);
    }
  }
}
