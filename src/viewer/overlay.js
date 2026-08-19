/**
 * Dessin des annotations (cotes et meubles) par-dessus le rendu du PDF.
 *
 * Toutes les fonctions travaillent en pixels CSS : les coordonnées PDF sont
 * converties via le `Viewport`. Les épaisseurs de trait et les textes restent
 * donc constants à l'écran quel que soit le zoom, ce qui est le comportement
 * attendu d'une annotation.
 */

import { hatchBands, rectCorners } from '../core/geometry.js';
import { formatLength, mmPerPt } from '../core/units.js';

export const MEASURE_COLOR = '#d62828';
export const SELECT_COLOR = '#4da3ff';
export const SNAP_COLOR = '#00b894';

export const FURNITURE_COLORS = [
  '#4da3ff',
  '#22c55e',
  '#f59e0b',
  '#ec4899',
  '#a855f7',
  '#14b8a6',
  '#64748b',
];

const FONT = "600 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const SMALL_FONT = "500 11px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

/** Hauteur fixe d'une pastille d'étiquette, en pixels écran. */
const LABEL_H = 20;
const LABEL_PAD_X = 6;

/**
 * En deçà de ce pas à l'écran, les tasseaux se confondent en un aplat gris :
 * on rend alors le rectangle nu. Même principe que pour les étiquettes — ne
 * pas dessiner ce qui ne se lit plus.
 */
const MIN_HATCH_PITCH_PX = 2.5;

/**
 * Encombrement horizontal d'une étiquette, sans la dessiner.
 *
 * Les étiquettes gardent une taille constante à l'écran : en dézoomant, elles
 * finissent par être plus grandes que l'objet qu'elles décrivent et masquent le
 * plan. On mesure donc avant de dessiner, pour pouvoir renoncer.
 */
function labelWidth(ctx, text, font = FONT) {
  ctx.font = font;
  return ctx.measureText(text).width + LABEL_PAD_X * 2;
}

/** Étiquette lisible sur n'importe quel fond : pastille claire + texte sombre. */
function label(ctx, text, x, y, { color = '#111', bg = 'rgba(255,255,255,0.94)', font = FONT } = {}) {
  ctx.font = font;
  const padX = LABEL_PAD_X;
  const padY = 4;
  const w = ctx.measureText(text).width + padX * 2;
  const h = LABEL_H;
  const rx = x - w / 2;
  const ry = y - h / 2;

  ctx.beginPath();
  ctx.roundRect(rx, ry, w, h, 6);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 0.5);
  return { x: rx, y: ry, w, h, padY };
}

/**
 * L'étiquette d'une cote ne s'affiche que si elle tient dans la longueur de
 * cette cote à l'écran. On projette l'encombrement de la pastille sur la
 * direction de la cote : pour une cote horizontale c'est sa largeur qui
 * compte, pour une verticale sa hauteur.
 */
function measureLabelFits(ctx, text, a, b, font = FONT) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return false;
  const need = (Math.abs(dx) * labelWidth(ctx, text, font) + Math.abs(dy) * LABEL_H) / len;
  return need <= len;
}

/** Trace une cote : ligne + pattes d'extrémité + valeur réelle. */
export function drawMeasure(ctx, vp, m, { scale, unit, selected = false }) {
  const a = vp.toScreen(m.a.x, m.a.y);
  const b = vp.toScreen(m.b.x, m.b.y);
  const color = selected ? SELECT_COLOR : m.color || MEASURE_COLOR;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = color;
  ctx.lineWidth = selected ? 3 : 2;

  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();

  // Pattes perpendiculaires aux extrémités
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * 7;
  const ny = (dx / len) * 7;
  ctx.beginPath();
  ctx.moveTo(a.x - nx, a.y - ny);
  ctx.lineTo(a.x + nx, a.y + ny);
  ctx.moveTo(b.x - nx, b.y - ny);
  ctx.lineTo(b.x + nx, b.y + ny);
  ctx.stroke();

  const lengthMm = Math.hypot(m.b.x - m.a.x, m.b.y - m.a.y) * mmPerPt(scale);
  const text = formatLength(lengthMm, unit);
  if (measureLabelFits(ctx, text, a, b)) {
    label(ctx, text, (a.x + b.x) / 2, (a.y + b.y) / 2 - 14, { color });
  }

  // Poignées d'extrémité : dimensionnées pour le doigt, pas pour le curseur.
  if (selected) {
    ctx.fillStyle = SELECT_COLOR;
    for (const p of [a, b]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 13, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Cote en cours de tracé (pointillés). */
export function drawDraftMeasure(ctx, vp, draft, { scale, unit }) {
  const a = vp.toScreen(draft.a.x, draft.a.y);
  const b = vp.toScreen(draft.b.x, draft.b.y);
  ctx.save();
  ctx.setLineDash([7, 5]);
  ctx.strokeStyle = MEASURE_COLOR;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.setLineDash([]);

  // Pendant le tracé, la valeur est de toute façon affichée en clair dans le
  // bandeau : masquer l'étiquette trop grande ne fait rien perdre.
  const lengthMm = Math.hypot(draft.b.x - draft.a.x, draft.b.y - draft.a.y) * mmPerPt(scale);
  const text = formatLength(lengthMm, unit);
  if (measureLabelFits(ctx, text, a, b)) {
    label(ctx, text, (a.x + b.x) / 2, (a.y + b.y) / 2 - 14, { color: MEASURE_COLOR });
  }
  ctx.restore();
}

/**
 * Meuble : rectangle orienté, nom et dimensions réelles.
 * `showDimensions` à faux ne laisse que le nom — un plan chargé en mobilier
 * devient vite illisible si chaque rectangle porte ses cotes.
 */
export function drawFurniture(ctx, vp, item, { scale, unit, selected = false, showDimensions = true }) {
  const ptPerMm = 1 / mmPerPt(scale);
  const w = item.lengthMm * ptPerMm;
  const h = item.widthMm * ptPerMm;
  const corners = rectCorners(item.cx, item.cy, w, h, item.rot).map((p) => vp.toScreen(p.x, p.y));

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i].x, corners[i].y);
  ctx.closePath();

  ctx.fillStyle = hexToRgba(item.color, 0.28);
  ctx.fill();

  // Tasseaux : tracés sous la bordure, pour que celle-ci reste franche.
  if (item.hatch) drawHatch(ctx, vp, item, w, h);

  ctx.strokeStyle = selected ? SELECT_COLOR : item.color;
  ctx.lineWidth = selected ? 3 : 2;
  ctx.stroke();

  const center = vp.toScreen(item.cx, item.cy);
  const dims = `${formatLength(item.lengthMm, unit)} × ${formatLength(item.widthMm, unit)}`;

  // Place disponible à l'intérieur du rectangle, à l'écran. Les rotations
  // étant des multiples de 90°, la boîte englobante des quatre coins projetés
  // est exactement le rectangle ; pour un angle quelconque elle majorerait
  // légèrement la place, ce qui reste sans conséquence visible.
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const availW = Math.max(...xs) - Math.min(...xs) - 8;
  const availH = Math.max(...ys) - Math.min(...ys) - 6;

  // Deux étiquettes empilées occupent 42 px de haut (±11 px depuis le centre).
  const nameFits = Boolean(item.label) && labelWidth(ctx, item.label) <= availW && availH >= LABEL_H;
  const dimsFit = labelWidth(ctx, dims, SMALL_FONT) <= availW && availH >= LABEL_H;

  if (nameFits && showDimensions && dimsFit && availH >= LABEL_H * 2 + 2) {
    label(ctx, item.label, center.x, center.y - 11, { color: '#111' });
    label(ctx, dims, center.x, center.y + 11, { color: '#333', font: SMALL_FONT });
  } else if (nameFits) {
    // Le nom prime sur les dimensions : c'est lui qui identifie le meuble.
    label(ctx, item.label, center.x, center.y, { color: '#111' });
  } else if (!item.label && showDimensions && dimsFit) {
    label(ctx, dims, center.x, center.y, { color: '#333', font: SMALL_FONT });
  }

  if (selected) {
    ctx.fillStyle = SELECT_COLOR;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    for (const c of corners) {
      ctx.beginPath();
      ctx.arc(c.x, c.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
}

/**
 * Tasseaux : bandes pleines réparties sur la longueur du rectangle.
 * Les quatre coins de chaque bande sont projetés séparément, si bien que la
 * rotation du meuble comme celle de la page sont prises en compte sans cas
 * particulier.
 */
function drawHatch(ctx, vp, item, w, h) {
  const ptPerMm = w / item.lengthMm;
  const solid = item.hatch.solidMm * ptPerMm;
  const gap = item.hatch.gapMm * ptPerMm;
  if (vp.lengthToScreen(solid + gap) < MIN_HATCH_PITCH_PX) return;

  const bands = hatchBands(item.cx, item.cy, w, h, item.rot, solid, gap);
  if (!bands.length) return;

  ctx.save();
  ctx.clip(); // le chemin courant est encore celui du rectangle
  ctx.fillStyle = hexToRgba(item.color, 0.55);
  for (const b of bands) {
    const pts = [
      [0, 0],
      [b.width, 0],
      [b.width, b.height],
      [0, b.height],
    ].map(([u, v]) => vp.toScreen(b.x + b.ux.x * u + b.uy.x * v, b.y + b.ux.y * u + b.uy.y * v));
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** Repère vert indiquant le point d'accrochage actif. */
export function drawSnapMarker(ctx, vp, snap) {
  const p = vp.toScreen(snap.x, snap.y);
  ctx.save();
  ctx.strokeStyle = SNAP_COLOR;
  ctx.lineWidth = 2;
  if (snap.kind === 'corner') {
    // Une croix, pour distinguer un angle d'une simple extrémité.
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(p.x - 9, p.y - 9);
    ctx.lineTo(p.x + 9, p.y + 9);
    ctx.moveTo(p.x + 9, p.y - 9);
    ctx.lineTo(p.x - 9, p.y + 9);
    ctx.stroke();
  } else if (snap.kind === 'endpoint') {
    ctx.strokeRect(p.x - 7, p.y - 7, 14, 14);
  } else {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Traits verts marquant les arêtes actuellement collées à un tracé du plan.
 * Sans ce retour, rien ne distingue un meuble « posé contre le mur » d'un
 * meuble simplement lâché à peu près au bon endroit.
 */
export function drawSnapGuides(ctx, vp, guides) {
  ctx.save();
  ctx.strokeStyle = SNAP_COLOR;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  for (const g of guides) {
    const a = g.axis === 'v' ? vp.toScreen(g.value, g.from) : vp.toScreen(g.from, g.value);
    const b = g.axis === 'v' ? vp.toScreen(g.value, g.to) : vp.toScreen(g.to, g.value);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Grille magnétique, comptée depuis `origin` (coordonnées PDF).
 *
 * Le tracé se fait dans l'espace du viewport de référence, aligné sur l'écran :
 * pour une grille carrée, une page pivotée donne le même quadrillage, aux axes
 * près, ce qui évite d'avoir à traiter la rotation.
 */
export function drawGrid(ctx, vp, stepPt, origin) {
  const stepPx = vp.lengthToScreen(stepPt);
  if (stepPx < 8) return; // trop dense pour être lisible

  const [ox, oy] = vp.base.convertToViewportPoint(origin.x, origin.y);
  const rect = vp.visibleBaseRect();
  ctx.save();
  ctx.strokeStyle = 'rgba(0, 90, 160, 0.18)';
  ctx.lineWidth = 1;
  ctx.beginPath();

  const first = (min, o) => o + Math.ceil((min - o) / stepPt) * stepPt;

  for (let x = first(rect.x, ox); x <= rect.x + rect.width; x += stepPt) {
    const sx = x * vp.scale + vp.tx;
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, vp.height);
  }
  for (let y = first(rect.y, oy); y <= rect.y + rect.height; y += stepPt) {
    const sy = y * vp.scale + vp.ty;
    ctx.moveTo(0, sy);
    ctx.lineTo(vp.width, sy);
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * Origine de la grille : point bleu cerclé de blanc, comme les poignées d'angle
 * des meubles — c'est une poignée, elle doit se lire comme telle.
 */
export function drawGridOrigin(ctx, vp, origin) {
  const p = vp.toScreen(origin.x, origin.y);
  ctx.save();

  // Deux amorces d'axes : elles disent que ce point commande le quadrillage.
  ctx.strokeStyle = SELECT_COLOR;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(p.x - 26, p.y);
  ctx.lineTo(p.x + 26, p.y);
  ctx.moveTo(p.x, p.y - 26);
  ctx.lineTo(p.x, p.y + 26);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.beginPath();
  ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
  ctx.fillStyle = SELECT_COLOR;
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.restore();
}

/** Guide affiché pendant un tracé contraint (prolonge la ligne de cote). */
export function drawAxisGuide(ctx, vp, anchor, axis) {
  const p = vp.toScreen(anchor.x, anchor.y);
  ctx.save();
  ctx.strokeStyle = 'rgba(214, 40, 40, 0.35)';
  ctx.setLineDash([3, 6]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (axis === 'h') {
    ctx.moveTo(0, p.y);
    ctx.lineTo(vp.width, p.y);
  } else {
    ctx.moveTo(p.x, 0);
    ctx.lineTo(p.x, vp.height);
  }
  ctx.stroke();
  ctx.restore();
}

export function hexToRgba(hex, alpha) {
  const value = hex?.replace('#', '') || '4da3ff';
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
