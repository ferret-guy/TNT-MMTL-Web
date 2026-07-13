/**
 * Generate calcRL input files (vendor/mmtl/calcRL/src/data.cpp is the
 * parser: one value per line, counts first, then per-conductor geometry in
 * METERS with lower-left corner convention, then wavelet parameters).
 *
 * calcRL models one finite rectangular ground bar plus rectangle/circle/
 * trapezoid signal conductors. CPW side grounds are not representable and
 * are omitted (documented approximation).
 */
import type { Stackup } from '../model/types.ts';
import { computeGeometry } from '../ui/crossSection.ts';
import { UNIT_SCALE } from './losses.ts';

export interface CalcRLGeometry {
  /** number of signal conductors in matrix order */
  nSignals: number;
  /** input file text for a given frequency */
  inputFor: (freqHz: number, sigma: number) => string;
}

/** wavelet parameters mirrored from the shipped jc fixture */
const WAVELET_PARAMS = [
  1024, // Nh
  40, // Nit
  6, // J  (2^J wavelets per contour)
  8, // Nwx
  10, // Nwy
  5, // Nws
  0, // Np
  1e-5, // EPS
  1, // matr (full matrix mode)
];

export function buildCalcRLGeometry(stackup: Stackup): CalcRLGeometry | null {
  const geo = computeGeometry(stackup);
  const scale = UNIT_SCALE.mils; // stackup canonical mils -> meters

  const signals = geo.polys.filter((p) => p.kind === 'conductor' && !p.isGroundConductor);
  if (!signals.length) return null;

  // ground: one wide bar just below y=0 (the BEM's ground plane surface).
  // width = the solver's dielectric domain, thickness = a typical 1.4 mil.
  const gndT = 1.4 * scale;
  const gndX = geo.domainX0 * scale;
  const gndW = (geo.domainX1 - geo.domainX0) * scale;

  const rects: number[][] = [];
  const circles: number[][] = [];
  const traps: number[][] = [];
  for (const p of signals) {
    if (p.item?.kind === 'TrapezoidConductors') {
      // placement order from computeGeometry: bl, br, tr, tl (ccw chain)
      const [bl, br, tr, tl] = p.pts;
      traps.push([
        bl[0] * scale, bl[1] * scale,
        tl[0] * scale, tl[1] * scale,
        tr[0] * scale, tr[1] * scale,
        br[0] * scale, br[1] * scale,
      ]);
    } else if (p.item?.kind === 'CircleConductors') {
      const r = ((p.x1 - p.x0) / 2) * scale;
      circles.push([(p.x0 + p.x1) / 2 * scale, (p.y0 + p.y1) / 2 * scale, r]);
    } else {
      rects.push([p.x0 * scale, p.y0 * scale, (p.x1 - p.x0) * scale, (p.y1 - p.y0) * scale]);
    }
  }

  const inputFor = (freqHz: number, sigma: number): string => {
    const lines: Array<number | string> = [];
    lines.push(1, rects.length, circles.length, traps.length);
    // ground: x, y, width, height, Iq
    lines.push(gndX, -gndT, gndW, gndT, 0);
    for (const r of rects) lines.push(r[0], r[1], r[2], r[3], 0);
    for (const c of circles) lines.push(c[0], c[1], c[2], 0);
    for (const t of traps) lines.push(...t, 0);
    lines.push(...WAVELET_PARAMS);
    lines.push(freqHz, sigma);
    return lines.map((v) => (typeof v === 'number' ? v.toExponential(9) : v)).join('\n') + '\n';
  };

  return { nSignals: signals.length, inputFor };
}

/** parse calcRL's .out: labeled R (ohm/m) and L (H/m) matrices */
export function parseCalcRLOut(text: string, n: number): { R: number[][]; L: number[][] } | null {
  const num = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
  const rIdx = text.indexOf('Resistance Matrix');
  const lIdx = text.indexOf('Inductance Matrix');
  if (rIdx < 0 || lIdx < 0) return null;
  const rVals = (text.slice(rIdx, lIdx).match(num) ?? []).map(Number).slice(0); // skip none: header nums?
  const lVals = (text.slice(lIdx).match(num) ?? []).map(Number);
  // headers contain no numerals after the "NxN" prefix which sits BEFORE the
  // keyword, so the slices above start clean
  if (rVals.length < n * n || lVals.length < n * n) return null;
  const mk = (vals: number[]): number[][] =>
    Array.from({ length: n }, (_, i) => vals.slice(i * n, i * n + n));
  return { R: mk(rVals.slice(0, n * n)), L: mk(lVals.slice(0, n * n)) };
}
