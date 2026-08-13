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
