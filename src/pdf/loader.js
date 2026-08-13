/** Initialisation de PDF.js et chargement d'un document. */

import * as pdfjsLib from 'pdfjs-dist';
import PdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?worker';

// Vite empaquette le worker : pas de CDN, l'app reste utilisable hors ligne.
pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker();

const ASSET_BASE = `${__APP_BASE__}pdfjs/`;

/**
 * Ouvre un PDF.
 *
 * ⚠️ PDF.js prend possession du buffer transmis (il est détaché). On travaille
 * donc systématiquement sur une copie : les octets d'origine restent
 * disponibles pour l'export pdf-lib et pour IndexedDB.
 *
 * `destroy()` libère le document *et* la mémoire retenue par le worker : sur
 * iPad, ne pas le faire en changeant de plan finit par saturer la mémoire.
 *
 * @param {ArrayBuffer} bytes
 * @returns {Promise<{pdf: import('pdfjs-dist').PDFDocumentProxy, destroy: () => Promise<void>}>}
 */
export async function loadPdfDocument(bytes) {
  const task = pdfjsLib.getDocument({
    data: bytes.slice(0),
    cMapUrl: `${ASSET_BASE}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${ASSET_BASE}standard_fonts/`,
    isEvalSupported: false,
  });
  const pdf = await task.promise;
  return { pdf, destroy: () => task.destroy() };
}

export { pdfjsLib };
