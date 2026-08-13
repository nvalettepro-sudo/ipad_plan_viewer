/**
 * Export du plan annoté avec pdf-lib.
 *
 * On repart du PDF d'origine et on ajoute les annotations dans son espace
 * utilisateur : la géométrie vectorielle et l'échelle du document sont donc
 * conservées à l'identique (aucun ré-encodage, aucune rastérisation).
 */

import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { rectCorners } from '../core/geometry.js';
import { formatLength, formatScale, mmPerPt } from '../core/units.js';

const MEASURE_RGB = [0.84, 0.16, 0.16];
const TICK_LENGTH = 4; // points PDF
const TEXT_SIZE = 8;

function toRgb([r, g, b]) {
  return rgb(r, g, b);
}

function hexToRgbTriplet(hex) {
  const value = (hex || '#4da3ff').replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  const n = parseInt(full, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function rotateVec(x, y, deg) {
  const r = (deg * Math.PI) / 180;
  return { x: x * Math.cos(r) - y * Math.sin(r), y: x * Math.sin(r) + y * Math.cos(r) };
}

/**
 * Texte centré sur (cx, cy) avec un fond blanc semi-opaque pour rester lisible
 * par-dessus le plan. `pageRotation` compense un éventuel /Rotate de la page :
 * sans ça le texte apparaîtrait couché à l'écran.
 */
function drawCenteredText(page, font, text, cx, cy, { color, pageRotation }) {
  const width = font.widthOfTextAtSize(text, TEXT_SIZE);
  const height = font.heightAtSize(TEXT_SIZE);
  const padX = 1.5;
  const padY = 1;

  // Coin inférieur gauche du fond, exprimé depuis le centre puis tourné.
  const bgOffset = rotateVec(-width / 2 - padX, -height / 2 - padY, pageRotation);
  page.drawRectangle({
    x: cx + bgOffset.x,
    y: cy + bgOffset.y,
    width: width + padX * 2,
    height: height + padY * 2,
    rotate: degrees(pageRotation),
    color: rgb(1, 1, 1),
    opacity: 0.82,
  });

  const textOffset = rotateVec(-width / 2, -height / 2 + height * 0.16, pageRotation);
  page.drawText(text, {
    x: cx + textOffset.x,
    y: cy + textOffset.y,
    size: TEXT_SIZE,
    font,
    color: toRgb(color),
    rotate: degrees(pageRotation),
  });
}

/**
 * Superpose les annotations sur le PDF d'origine.
 *
 * @param {{bytes: ArrayBuffer, layers: object, name?: string}} input
 * @returns {Promise<Blob>}
 */
export async function buildAnnotatedPdf({ bytes, layers, name = 'plan' }) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const pageIndex = Math.min(layers.pageIndex ?? 0, doc.getPageCount() - 1);
  const page = doc.getPage(pageIndex);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pageRotation = page.getRotation().angle % 360;

  const scale = layers.scale;
  const unit = layers.unit || 'auto';
  const perMm = 1 / mmPerPt(scale);

  // ── Meubles ───────────────────────────────────────────────────────────
  for (const item of layers.furniture || []) {
    const w = item.lengthMm * perMm;
    const h = item.widthMm * perMm;
    const color = hexToRgbTriplet(item.color);
    const corners = rectCorners(item.cx, item.cy, w, h, item.rot);

    page.drawRectangle({
      x: corners[0].x,
      y: corners[0].y,
      width: w,
      height: h,
      rotate: degrees(item.rot),
      color: toRgb(color),
      opacity: 0.22,
      borderColor: toRgb(color),
      borderWidth: 1,
      borderOpacity: 1,
    });

    const dims = `${formatLength(item.lengthMm, unit)} x ${formatLength(item.widthMm, unit)}`;
    if (item.label) {
      const up = rotateVec(0, TEXT_SIZE * 0.75, pageRotation);
      drawCenteredText(page, font, item.label, item.cx + up.x, item.cy + up.y, {
        color: [0.1, 0.1, 0.1],
        pageRotation,
      });
      const down = rotateVec(0, -TEXT_SIZE * 0.75, pageRotation);
      drawCenteredText(page, font, dims, item.cx + down.x, item.cy + down.y, {
        color: [0.25, 0.25, 0.25],
        pageRotation,
      });
    } else {
      drawCenteredText(page, font, dims, item.cx, item.cy, {
        color: [0.25, 0.25, 0.25],
        pageRotation,
      });
    }
  }

  // ── Cotes ─────────────────────────────────────────────────────────────
  for (const m of layers.measures || []) {
    const color = toRgb(MEASURE_RGB);
    page.drawLine({
      start: { x: m.a.x, y: m.a.y },
      end: { x: m.b.x, y: m.b.y },
      thickness: 0.9,
      color,
    });

    const dx = m.b.x - m.a.x;
    const dy = m.b.y - m.a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * TICK_LENGTH;
    const ny = (dx / len) * TICK_LENGTH;
    for (const p of [m.a, m.b]) {
      page.drawLine({
        start: { x: p.x - nx, y: p.y - ny },
        end: { x: p.x + nx, y: p.y + ny },
        thickness: 0.9,
        color,
      });
    }

    const lengthMm = len * mmPerPt(scale);
    // Décalage de l'étiquette du côté « au-dessus » du trait de cote.
    const offset = rotateVec(0, TEXT_SIZE, pageRotation);
    drawCenteredText(
      page,
      font,
      formatLength(lengthMm, unit),
      (m.a.x + m.b.x) / 2 + offset.x,
      (m.a.y + m.b.y) / 2 + offset.y,
      { color: MEASURE_RGB, pageRotation },
    );
  }

  doc.setTitle(`${name} — annoté (${formatScale(scale)})`);
  doc.setProducer('Plan Viewer');
  doc.setModificationDate(new Date());

  const output = await doc.save({ useObjectStreams: false });
  return new Blob([output], { type: 'application/pdf' });
}

/** Nom de fichier proposé à l'export. */
export function exportFileName(name) {
  const base = (name || 'plan').replace(/\.pdf$/i, '').replace(/[/\\:*?"<>|]/g, '-');
  const stamp = new Date().toISOString().slice(0, 10);
  return `${base}-annote-${stamp}.pdf`;
}
