/**
 * Extraction des tracés vectoriels d'une page PDF, pour l'accrochage (snap).
 *
 * On parcourt la liste d'opérateurs produite par PDF.js et on reconstruit les
 * chemins en espace utilisateur PDF (origine en bas à gauche, unité = point).
 * Les courbes de Bézier sont approximées par des polylignes : la précision
 * demandée ici (accrochage au doigt) ne justifie pas mieux.
 *
 * Si la page ne contient aucun tracé (PDF issu d'un scan), `count` vaut 0 et
 * l'interface bascule automatiquement en mesure manuelle (+ grille optionnelle).
 */

import { OPS } from 'pdfjs-dist';
import { axisLineSegmentIntersection, clamp, closestOnSegment } from '../core/geometry.js';

const CURVE_STEPS = 8;
const MAX_SEGMENTS = 300_000;
// Un export CAO produit des murs rigoureusement alignés : la tolérance ne sert
// qu'à absorber les erreurs d'arrondi de l'extraction.
const PARALLEL_EPS = 0.35;

/** Multiplication de matrices PDF [a,b,c,d,e,f] : `m` appliquée avant `base`. */
function mul(base, m) {
  return [
    m[0] * base[0] + m[1] * base[2],
    m[0] * base[1] + m[1] * base[3],
    m[2] * base[0] + m[3] * base[2],
    m[2] * base[1] + m[3] * base[3],
    m[4] * base[0] + m[5] * base[2] + base[4],
    m[4] * base[1] + m[5] * base[3] + base[5],
  ];
}

const applyX = (m, x, y) => m[0] * x + m[2] * y + m[4];
const applyY = (m, x, y) => m[1] * x + m[3] * y + m[5];

/**
 * Convertit un tableau plat « DrawOPS » (PDF.js ≥ 5) en segments.
 * Format : [op, ...args, op, ...args] avec
 * 0 moveTo(x,y) · 1 lineTo(x,y) · 2 curveTo(6) · 3 quadraticCurveTo(4) · 4 closePath
 */
function decodePath(data, ctm, out) {
  let sx = 0;
  let sy = 0; // début du sous-chemin
  let cx = 0;
  let cy = 0; // point courant
  let started = false;

  const push = (x0, y0, x1, y1) => {
    if (out.length >= MAX_SEGMENTS * 4) return;
    const ax = applyX(ctm, x0, y0);
    const ay = applyY(ctm, x0, y0);
    const bx = applyX(ctm, x1, y1);
    const by = applyY(ctm, x1, y1);
    if (Math.abs(ax - bx) < 1e-6 && Math.abs(ay - by) < 1e-6) return;
    out.push(ax, ay, bx, by);
  };

  for (let i = 0; i < data.length; ) {
    switch (data[i++]) {
      case 0: // moveTo
        cx = sx = data[i++];
        cy = sy = data[i++];
        started = true;
        break;
      case 1: {
        // lineTo
        const x = data[i++];
        const y = data[i++];
        if (started) push(cx, cy, x, y);
        cx = x;
        cy = y;
        started = true;
        break;
      }
      case 2: {
        // curveTo (cubique)
        const x1 = data[i++];
        const y1 = data[i++];
        const x2 = data[i++];
        const y2 = data[i++];
        const x3 = data[i++];
        const y3 = data[i++];
        let px = cx;
        let py = cy;
        for (let s = 1; s <= CURVE_STEPS; s++) {
          const t = s / CURVE_STEPS;
          const u = 1 - t;
          const qx = u * u * u * cx + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3;
          const qy = u * u * u * cy + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3;
          push(px, py, qx, qy);
          px = qx;
          py = qy;
        }
        cx = x3;
        cy = y3;
        break;
      }
      case 3: {
        // quadraticCurveTo
        const x1 = data[i++];
        const y1 = data[i++];
        const x2 = data[i++];
        const y2 = data[i++];
        let px = cx;
        let py = cy;
        for (let s = 1; s <= CURVE_STEPS; s++) {
          const t = s / CURVE_STEPS;
          const u = 1 - t;
          const qx = u * u * cx + 2 * u * t * x1 + t * t * x2;
          const qy = u * u * cy + 2 * u * t * y1 + t * t * y2;
          push(px, py, qx, qy);
          px = qx;
          py = qy;
        }
        cx = x2;
        cy = y2;
        break;
      }
      case 4: // closePath
        push(cx, cy, sx, sy);
        cx = sx;
        cy = sy;
        break;
      default:
        return; // opérateur inconnu : on abandonne ce chemin
    }
  }
}

/**
 * Parcourt la liste d'opérateurs d'une page et renvoie tous les segments.
 * @param {import('pdfjs-dist').PDFPageProxy} page
 * @returns {Promise<Float32Array>} segments à plat [x1,y1,x2,y2, …] en espace PDF
 */
export async function extractSegments(page) {
  const opList = await page.getOperatorList();
  const { fnArray, argsArray } = opList;

  const out = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    if (fn === OPS.save) {
      stack.push(ctm);
    } else if (fn === OPS.restore) {
      ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    } else if (fn === OPS.transform) {
      ctm = mul(ctm, argsArray[i]);
    } else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      const matrix = argsArray[i]?.[0];
      if (matrix) ctm = mul(ctm, matrix);
    } else if (fn === OPS.paintFormXObjectEnd) {
      ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    } else if (fn === OPS.constructPath) {
      // args = [sousOpérateur, data, minMax] ; data[0] = tableau plat DrawOPS
      const data = argsArray[i]?.[1];
      const path = Array.isArray(data) ? data[0] : null;
      if (Array.isArray(path) || ArrayBuffer.isView(path)) decodePath(path, ctm, out);
      if (out.length >= MAX_SEGMENTS * 4) break;
    }
  }

  return Float32Array.from(out);
}

/**
 * Index spatial sur les segments d'une page, pour un accrochage instantané.
 *
 * Grille uniforme : chaque segment est inscrit dans les cellules qu'il traverse
 * (échantillonnage au demi-pas), la recherche ne balaie que les cellules
 * proches du doigt.
 */
export class SnapIndex {
  /**
   * @param {Float32Array} segments segments à plat, espace PDF
   * @param {{x:number, y:number, width:number, height:number}} pageBox
   */
  constructor(segments, pageBox) {
    this.segments = segments;
    this.count = segments.length / 4;
    this.x0 = pageBox.x;
    this.y0 = pageBox.y;

    const maxDim = Math.max(pageBox.width, pageBox.height, 1);
    this.cell = Math.max(4, maxDim / 256);
    this.cols = Math.max(1, Math.ceil(pageBox.width / this.cell) + 1);
    this.rows = Math.max(1, Math.ceil(pageBox.height / this.cell) + 1);
    /** @type {Map<number, number[]>} */
    this.grid = new Map();
    /** Portée maximale d'une recherche élargie. */
    this.maxReach = Math.hypot(pageBox.width, pageBox.height);

    for (let s = 0; s < this.count; s++) this.#insert(s);
  }

  get isEmpty() {
    return this.count === 0;
  }

  #key(col, row) {
    return row * this.cols + col;
  }

  #cellOf(x, y) {
    return [
      clamp(Math.floor((x - this.x0) / this.cell), 0, this.cols - 1),
      clamp(Math.floor((y - this.y0) / this.cell), 0, this.rows - 1),
    ];
  }

  #add(col, row, index) {
    const key = this.#key(col, row);
    const bucket = this.grid.get(key);
    if (bucket) {
      if (bucket[bucket.length - 1] !== index) bucket.push(index);
    } else {
      this.grid.set(key, [index]);
    }
  }

  #insert(s) {
    const seg = this.segments;
    const ax = seg[s * 4];
    const ay = seg[s * 4 + 1];
    const bx = seg[s * 4 + 2];
    const by = seg[s * 4 + 3];
    const length = Math.hypot(bx - ax, by - ay);
    const steps = Math.min(2048, Math.max(1, Math.ceil((length / this.cell) * 2)));
    let lastKey = -1;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const [col, row] = this.#cellOf(ax + (bx - ax) * t, ay + (by - ay) * t);
      const key = this.#key(col, row);
      if (key !== lastKey) {
        this.#add(col, row, s);
        lastKey = key;
      }
    }
  }

  /** Itère les index de segments présents dans le voisinage carré de `p`. */
  *#near(p, radius) {
    yield* this.#nearBox(p.x - radius, p.y - radius, p.x + radius, p.y + radius);
  }

  /** Itère les index de segments qui touchent la boîte donnée. */
  *#nearBox(minX, minY, maxX, maxY) {
    const [c0, r0] = this.#cellOf(minX, minY);
    const [c1, r1] = this.#cellOf(maxX, maxY);
    const seen = new Set();
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const bucket = this.grid.get(this.#key(col, row));
        if (!bucket) continue;
        for (const s of bucket) {
          if (seen.has(s)) continue;
          seen.add(s);
          yield s;
        }
      }
    }
  }

  /**
   * Point d'accrochage le plus proche : extrémité de segment en priorité,
   * sinon point le plus proche sur un segment.
   * @returns {{x:number,y:number,kind:'endpoint'|'edge'}|null}
   */
  nearest(p, radius, maxRadius = radius) {
    if (this.isEmpty) return null;
    // Recherche élargie : on double le rayon jusqu'à trouver, ce qui garantit
    // qu'une cote démarre toujours sur un trait, même loin de tout.
    for (let r = radius; ; r *= 2) {
      const hit = this.#nearestWithin(p, r);
      if (hit) return hit;
      if (r >= Math.min(maxRadius, this.maxReach)) return null;
    }
  }

  #nearestWithin(p, radius) {
    const seg = this.segments;
    let best = null;
    let bestD = radius;
    let bestEdge = null;
    let bestEdgeD = radius;

    for (const s of this.#near(p, radius)) {
      const ax = seg[s * 4];
      const ay = seg[s * 4 + 1];
      const bx = seg[s * 4 + 2];
      const by = seg[s * 4 + 3];

      const da = Math.hypot(p.x - ax, p.y - ay);
      if (da < bestD) {
        bestD = da;
        best = { x: ax, y: ay, kind: 'endpoint' };
      }
      const db = Math.hypot(p.x - bx, p.y - by);
      if (db < bestD) {
        bestD = db;
        best = { x: bx, y: by, kind: 'endpoint' };
      }

      const near = closestOnSegment(p, ax, ay, bx, by);
      if (near.d < bestEdgeD) {
        bestEdgeD = near.d;
        bestEdge = { x: near.x, y: near.y, kind: 'edge' };
      }
    }

    // Une extrémité l'emporte tant qu'elle reste dans un rayon raisonnable.
    if (best) return best;
    return bestEdge;
  }

  /**
   * Cherche un tracé parallèle à une arête, pour poser un meuble contre un mur.
   *
   * @param {'h'|'v'} axis 'v' = on cherche un tracé vertical près de `value`
   * @param {number} value abscisse (ou ordonnée) de l'arête du meuble
   * @param {number} from début de l'arête sur l'autre axe
   * @param {number} to fin de l'arête sur l'autre axe
   * @param {number} radius distance maximale d'attraction, en unités PDF
   * @returns {number|null} coordonnée du tracé trouvé
   */
  nearestParallel(axis, value, from, to, radius) {
    if (this.isEmpty) return null;
    const seg = this.segments;
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    const box =
      axis === 'v'
        ? [value - radius, lo, value + radius, hi]
        : [lo, value - radius, hi, value + radius];

    let best = null;
    let bestD = radius;
    for (const s of this.#nearBox(...box)) {
      const ax = seg[s * 4];
      const ay = seg[s * 4 + 1];
      const bx = seg[s * 4 + 2];
      const by = seg[s * 4 + 3];

      // Le tracé doit être parallèle à l'arête…
      const along = axis === 'v' ? Math.abs(ax - bx) : Math.abs(ay - by);
      if (along > PARALLEL_EPS) continue;

      const coord = axis === 'v' ? ax : ay;
      const d = Math.abs(coord - value);
      if (d >= bestD) continue;

      // …et se trouver en regard d'elle, pas juste dans son prolongement.
      const spanLo = axis === 'v' ? Math.min(ay, by) : Math.min(ax, bx);
      const spanHi = axis === 'v' ? Math.max(ay, by) : Math.max(ax, bx);
      if (spanHi < lo || spanLo > hi) continue;

      bestD = d;
      best = coord;
    }
    return best;
  }

  /**
   * Accrochage contraint : intersections entre la droite passant par `anchor`
   * le long de `axis` et les tracés du plan, proche de `p`.
   *
   * C'est le comportement attendu pour coter d'un mur à l'autre : on suit la
   * ligne de cote et on s'arrête pile sur le tracé rencontré.
   *
   * @param {{x:number,y:number}} anchor origine de la cote
   * @param {'h'|'v'} axis direction de la cote
   * @param {{x:number,y:number}} p position du doigt
   * @param {number} radius rayon d'accrochage en unités PDF
   */
  nearestOnAxis(anchor, axis, p, radius, maxRadius = radius) {
    if (this.isEmpty) return null;
    for (let r = radius; ; r *= 2) {
      const hit = this.#nearestOnAxisWithin(anchor, axis, p, r);
      if (hit) return hit;
      if (r >= Math.min(maxRadius, this.maxReach)) return null;
    }
  }

  #nearestOnAxisWithin(anchor, axis, p, radius) {
    const seg = this.segments;
    const value = axis === 'h' ? anchor.y : anchor.x;
    const target = axis === 'h' ? p.x : p.y;
    let best = null;
    let bestD = radius;

    for (const s of this.#near(p, radius)) {
      const hit = axisLineSegmentIntersection(
        axis,
        value,
        seg[s * 4],
        seg[s * 4 + 1],
        seg[s * 4 + 2],
        seg[s * 4 + 3],
      );
      if (hit === null) continue;
      const d = Math.abs(hit - target);
      if (d < bestD) {
        bestD = d;
        best = hit;
      }
    }

    if (best === null) return null;
    return axis === 'h' ? { x: best, y: anchor.y, kind: 'edge' } : { x: anchor.x, y: best, kind: 'edge' };
  }
}
