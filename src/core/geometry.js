/** Petites primitives géométriques 2D partagées par les outils. */

export const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

export const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

/** Point le plus proche de `p` sur le segment [a,b], et distance associée. */
export function closestOnSegment(p, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) t = clamp(((p.x - ax) * dx + (p.y - ay) * dy) / len2, 0, 1);
  const x = ax + t * dx;
  const y = ay + t * dy;
  return { x, y, t, d: Math.hypot(p.x - x, p.y - y) };
}

/**
 * Intersection entre une droite alignée sur un axe et un segment.
 * @param {'h'|'v'} axis 'h' = droite horizontale y = value, 'v' = verticale x = value
 * @returns {number|null} coordonnée libre de l'intersection (x si 'h', y si 'v')
 */
export function axisLineSegmentIntersection(axis, value, ax, ay, bx, by) {
  const [c0, c1, f0, f1] = axis === 'h' ? [ay, by, ax, bx] : [ax, bx, ay, by];
  const span = c1 - c0;
  if (Math.abs(span) < 1e-9) return null; // segment parallèle à la droite
  const t = (value - c0) / span;
  if (t < 0 || t > 1) return null;
  return f0 + t * (f1 - f0);
}

/**
 * Intersection de deux segments, avec une marge de tolérance.
 *
 * `pad` (en unités PDF) prolonge virtuellement chaque segment : dans un export
 * CAO, deux murs formant un angle ne se croisent pas toujours exactement — ils
 * s'arrêtent parfois à une fraction de point l'un de l'autre.
 *
 * @returns {{x:number, y:number}|null} null si parallèles ou hors portée
 */
export function segmentIntersection(ax, ay, bx, by, cx, cy, dx, dy, pad = 0) {
  const r = { x: bx - ax, y: by - ay };
  const s = { x: dx - cx, y: dy - cy };
  const denom = r.x * s.y - r.y * s.x;
  if (Math.abs(denom) < 1e-9) return null; // parallèles

  const t = ((cx - ax) * s.y - (cy - ay) * s.x) / denom;
  const u = ((cx - ax) * r.y - (cy - ay) * r.x) / denom;

  const padT = pad / (Math.hypot(r.x, r.y) || 1);
  const padU = pad / (Math.hypot(s.x, s.y) || 1);
  if (t < -padT || t > 1 + padT || u < -padU || u > 1 + padU) return null;

  return { x: ax + t * r.x, y: ay + t * r.y };
}

/** Rotation d'un vecteur (dx,dy) de `deg` degrés (sens trigonométrique, repère PDF y↑). */
export function rotateVec(dx, dy, deg) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

/** Les 4 coins d'un rectangle centré, en coordonnées PDF. */
export function rectCorners(cx, cy, w, h, rotDeg) {
  const hw = w / 2;
  const hh = h / 2;
  return [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([dx, dy]) => {
    const v = rotateVec(dx, dy, rotDeg);
    return { x: cx + v.x, y: cy + v.y };
  });
}

/** Teste si `p` est dans le rectangle orienté (avec une marge `pad` en unités PDF). */
export function pointInRect(p, cx, cy, w, h, rotDeg, pad = 0) {
  const v = rotateVec(p.x - cx, p.y - cy, -rotDeg);
  return Math.abs(v.x) <= w / 2 + pad && Math.abs(v.y) <= h / 2 + pad;
}

/** Identifiant court, suffisant pour un usage mono-appareil. */
export function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/**
 * Bandes de hachures d'un rectangle orienté, en coordonnées PDF.
 *
 * Sert à figurer une ossature — des tasseaux de 3 cm espacés de 3 cm, par
 * exemple. Les bandes courent le long de la **largeur** du rectangle et se
 * répètent sur sa **longueur** : elles suivent donc sa rotation, comme le
 * feraient de vraies pièces de bois.
 *
 * Chaque bande est décrite par son coin d'origine et les deux vecteurs
 * unitaires du repère local, ce qui laisse l'appelant la tracer comme il veut :
 * un quadrilatère sur le canevas, un rectangle pivoté dans le PDF exporté.
 *
 * @param {number} solidPt largeur d'un tasseau
 * @param {number} gapPt   vide entre deux tasseaux
 * @param {number} maxBands garde-fou : au-delà, le motif serait illisible et
 *   coûteux à tracer, on renonce plutôt que de figer l'affichage.
 */
export function hatchBands(cx, cy, w, h, rotDeg, solidPt, gapPt, maxBands = 400) {
  const period = solidPt + gapPt;
  if (!(solidPt > 0) || !(period > 0) || !(w > 0) || !(h > 0)) return [];
  if (w / period > maxBands) return [];

  const [origin, right, , top] = rectCorners(cx, cy, w, h, rotDeg);
  const ux = { x: (right.x - origin.x) / w, y: (right.y - origin.y) / w };
  const uy = { x: (top.x - origin.x) / h, y: (top.y - origin.y) / h };

  const bands = [];
  for (let start = 0; start < w - 1e-9; start += period) {
    // Le dernier tasseau est coupé net par le bord : une pièce de bois ne
    // dépasse pas du meuble.
    const width = Math.min(start + solidPt, w) - start;
    if (width <= 1e-9) continue;
    bands.push({
      x: origin.x + ux.x * start,
      y: origin.y + ux.y * start,
      width,
      height: h,
      ux,
      uy,
    });
  }
  return bands;
}
