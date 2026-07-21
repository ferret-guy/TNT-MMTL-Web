/**
 * Per-line figures for a given physical length and design frequency,
 * derived from the solve result + the analytic loss model.
 */
import type { SolveResult } from '../model/types.ts';
import type { LossCurve } from './losses.ts';

export interface LineStats {
  lengthM: number;
  fHz: number;
  rdcOhm: number; // series DC resistance of the line (one conductor)
  lossDb: number; // total insertion loss at f (negative = loss)
  lossCondDb: number;
  lossDielDb: number;
  delayPs: number; // propagation delay for the length
  phaseDeg: number; // total phase at f (unwrapped)
  wavelengths: number; // electrical length in wavelengths at f
}

/** interpolate a curve (log-x linear) at f */
function at(curve: LossCurve, key: 'alphaC' | 'alphaD' | 'alphaTotal', fHz: number): number {
  const xs = curve.fHz;
  if (fHz <= xs[0]) return curve[key][0];
  if (fHz >= xs[xs.length - 1]) return curve[key][xs.length - 1];
  let i = 1;
  while (xs[i] < fHz) i++;
  const t = (Math.log(fHz) - Math.log(xs[i - 1])) / (Math.log(xs[i]) - Math.log(xs[i - 1]));
  return curve[key][i - 1] * (1 - t) + curve[key][i] * t;
}

export function computeLineStats(
  result: SolveResult,
  curve: LossCurve,
  lengthM: number,
  fHz: number,
  diffMode: boolean,
): LineStats | null {
  const firstCurveHz = curve.fHz[0];
  const lastCurveHz = curve.fHz[curve.fHz.length - 1];
  // Never silently label a clamped endpoint as a different design frequency.
  // The caller must supply a curve that actually covers the requested point.
  if (
    !Number.isFinite(fHz) ||
    !Number.isFinite(firstCurveHz) ||
    !Number.isFinite(lastCurveHz) ||
    fHz < firstCurveHz ||
    fHz > lastCurveHz
  ) return null;
  const v = diffMode && result.velocityOdd != null ? result.velocityOdd : result.velocity[0];
  const delayPerM = diffMode && result.delayOdd != null ? result.delayOdd : result.delay[0];
  const rdc = result.Rdc[0]?.[0];
  const modeledRdc =
    Number.isFinite(curve.rdcSignalOhmPerM) &&
    Number.isFinite(curve.rdcReferenceOhmPerM)
      ? curve.rdcSignalOhmPerM + curve.rdcReferenceOhmPerM
      : rdc;
  if (!Number.isFinite(v) || !Number.isFinite(delayPerM)) return null;
  const phaseRad = (2 * Math.PI * fHz * lengthM) / v;
  return {
    lengthM,
    fHz,
    rdcOhm: Number.isFinite(modeledRdc) ? modeledRdc * lengthM : NaN,
    lossDb: -at(curve, 'alphaTotal', fHz) * lengthM,
    lossCondDb: -at(curve, 'alphaC', fHz) * lengthM,
    lossDielDb: -at(curve, 'alphaD', fHz) * lengthM,
    delayPs: delayPerM * lengthM * 1e12,
    phaseDeg: (phaseRad * 180) / Math.PI,
    wavelengths: (fHz * lengthM) / v,
  };
}
