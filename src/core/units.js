/**
 * Conversion entre l'espace PDF et les dimensions réelles.
 *
 * L'unité native d'un PDF est le point typographique : 1 pt = 1/72 pouce.
 * Sur un plan tracé à l'échelle 1/N, 1 pt de papier représente donc
 * (25,4 / 72) × N millimètres réels.
 */

export const MM_PER_PT = 25.4 / 72; // ≈ 0,352778

/** @typedef {{mode:'ratio', ratio:number}|{mode:'calibration', mmPerPt:number, ratio:number|null}} PlanScale */

/** Échelle par défaut d'un plan fraîchement importé. */
export function defaultScale() {
  return { mode: 'ratio', ratio: 50 };
}

/** Millimètres réels représentés par 1 point PDF. */
export function mmPerPt(scale) {
  if (!scale) return MM_PER_PT * 50;
  if (scale.mode === 'calibration' && Number.isFinite(scale.mmPerPt)) return scale.mmPerPt;
  return MM_PER_PT * (scale.ratio || 50);
}

/** Points PDF correspondant à une longueur réelle en millimètres. */
export function ptPerMm(scale) {
  return 1 / mmPerPt(scale);
}

/** Ratio équivalent (1/N) d'une échelle, y compris après calibration. */
export function effectiveRatio(scale) {
  return mmPerPt(scale) / MM_PER_PT;
}

/** Construit une échelle à partir d'une calibration : `lengthPt` mesure `realMm`. */
export function calibrationScale(lengthPt, realMm) {
  const value = realMm / lengthPt;
  return { mode: 'calibration', mmPerPt: value, ratio: value / MM_PER_PT };
}

const UNIT_TO_MM = { mm: 1, cm: 10, m: 1000 };

/** Convertit une valeur saisie (`unit` ∈ mm|cm|m) en millimètres. */
export function toMm(value, unit) {
  return value * (UNIT_TO_MM[unit] ?? 10);
}

/** Convertit des millimètres vers l'unité demandée. */
export function fromMm(mm, unit) {
  return mm / (UNIT_TO_MM[unit] ?? 10);
}

const nf = (digits) =>
  new Intl.NumberFormat('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits });

const NF = { 0: nf(0), 1: nf(1), 2: nf(2), 3: nf(3) };

/**
 * Formate une longueur réelle pour affichage.
 * @param {number} mm longueur en millimètres
 * @param {'auto'|'mm'|'cm'|'m'} unit
 */
export function formatLength(mm, unit = 'auto') {
  if (!Number.isFinite(mm)) return '—';
  const abs = Math.abs(mm);
  let u = unit;
  if (u === 'auto') u = abs >= 1000 ? 'm' : abs >= 10 ? 'cm' : 'mm';

  if (u === 'm') return `${NF[2].format(mm / 1000)} m`;
  if (u === 'cm') return `${NF[abs < 100 ? 1 : 0].format(mm / 10)} cm`;
  return `${NF[0].format(mm)} mm`;
}

/** Libellé court d'une échelle, pour la barre d'outils. */
export function formatScale(scale) {
  const ratio = effectiveRatio(scale);
  if (!Number.isFinite(ratio)) return '—';
  const rounded = Math.round(ratio);
  const isRound = Math.abs(ratio - rounded) < 0.5;
  return `1/${isRound ? rounded : ratio.toFixed(1)}`;
}
