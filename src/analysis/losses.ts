/**
 * Frequency-dependent loss estimation -- analytic post-processing on top of
 * the quasi-static solver outputs, mirroring TNT's HSPICE W-element
 * generator (bem/lib/bem_welement.itcl):
 *   Rs(f)  = sqrt(pi f mu0 / sigma) / perimeter        [ohm/m]
 *   R(f)   = sqrt(Rdc^2 + (K(f) * Rs(f))^2)            [smooth DC->skin]
 *   G(f)   = 2 pi f C tan(delta)                       [S/m]
 *   alpha_c = R / (2 Z0);  alpha_d = G Z0 / 2          [Np/m]
 *
 * K(f) is the surface-roughness multiplier:
 *   - Hammerstad-Jensen: K = 1 + (2/pi) atan(1.4 (Rq/delta)^2)   (K <= 2)
 *   - Huray (cannonball, 14-sphere): K = 1 + (84/11) * A_ratio /
 *         (1 + delta/r + delta^2/(2 r^2)),  r = Rq/2
 * where delta = skin depth = 1/sqrt(pi f mu0 sigma).
 *
 * The solver itself has no roughness or frequency dependence -- TNT never
 * had a roughness parameter; this panel is labeled as analytic estimation.
 */
import type { LossParams, SolveResult } from '../model/types.ts';
import type { ConductorItem } from '../model/types.ts';

const MU0 = 4e-7 * Math.PI;

/** wetted perimeter of one conductor cross-section, in meters */
export function perimeterM(item: ConductorItem, unitScale: number): number {
  switch (item.kind) {
    case 'RectangleConductors':
      return 2 * (item.width + item.height) * unitScale;
    case 'TrapezoidConductors': {
      const wb = item.bottomWidth * unitScale;
      const wt = item.topWidth * unitScale;
      const h = item.height * unitScale;
      const slant = Math.hypot(h, (wb - wt) / 2);
      return wb + wt + 2 * slant;
    }
    case 'CircleConductors':
      return Math.PI * item.diameter * unitScale;
  }
}

export function skinDepthM(fHz: number, sigma: number): number {
  return 1 / Math.sqrt(Math.PI * fHz * MU0 * sigma);
}

export function roughnessK(
  model: LossParams['roughnessModel'],
  rqM: number,
  deltaM: number,
  hurayRatio: number,
): number {
  if (model === 'none' || rqM <= 0) return 1;
  if (model === 'hammerstad') {
    return 1 + (2 / Math.PI) * Math.atan(1.4 * (rqM / deltaM) ** 2);
  }
  // Huray cannonball: 14 spheres of radius r = Rq/2 on a 9r x 9r tile
  const r = rqM / 2;
  const areaRatio = hurayRatio; // (N * 4 pi r^2) / A_tile, default 14*4pi/81 ~ 2.17... user-visible knob
  return 1 + ((3 / 2) * areaRatio) / (1 + deltaM / r + (deltaM * deltaM) / (2 * r * r));
}

export interface LossCurve {
  fHz: number[];
  alphaC: number[]; // dB/m conductor
  alphaD: number[]; // dB/m dielectric
  alphaTotal: number[];
  rOhmPerM: number[];
  gSPerM: number[];
  skinDepthUm: number[];
  kRough: number[];
}

export interface LossInputs {
  z0: number; // ohms (mode impedance: single-ended z0 or zOdd for diff)
  cPerM: number; // F/m (mode capacitance)
  rdcPerM: number; // ohm/m
  sigma: number; // S/m
  tanD: number;
  perimeterM: number;
}

/**
 * Effective stripline dielectric loss for unlike upper/lower laminates.
 * The εr / clearance weighting is the electric-energy participation of the
 * parallel-path limit and closely tracks the BEM result for typical traces.
 */
export function striplineEffectiveLossTangent(
  lowerEr: number,
  lowerHeight: number,
  lowerTanD: number,
  upperEr: number,
  upperHeight: number,
  upperTanD: number,
): number {
  const lowerWeight = lowerEr > 0 && lowerHeight > 0 ? lowerEr / lowerHeight : 0;
  const upperWeight = upperEr > 0 && upperHeight > 0 ? upperEr / upperHeight : 0;
  const totalWeight = lowerWeight + upperWeight;
  return totalWeight > 0
    ? (lowerWeight * lowerTanD + upperWeight * upperTanD) / totalWeight
    : 0;
}

const NP_TO_DB = 8.685889638;

export function lossCurve(inp: LossInputs, p: LossParams): LossCurve {
  const out: LossCurve = {
    fHz: [],
    alphaC: [],
    alphaD: [],
    alphaTotal: [],
    rOhmPerM: [],
    gSPerM: [],
    skinDepthUm: [],
    kRough: [],
  };
  const logMin = Math.log10(p.fMinHz);
  const logMax = Math.log10(p.fMaxHz);
  const n = Math.max(2, p.nPoints);
  const rqM = p.roughnessRqUm * 1e-6;
  for (let i = 0; i < n; i++) {
    const f = 10 ** (logMin + ((logMax - logMin) * i) / (n - 1));
    const delta = skinDepthM(f, inp.sigma);
    const k = roughnessK(p.roughnessModel, rqM, delta, p.hurayRatio);
    const rSkin = Math.sqrt(Math.PI * f * MU0 / inp.sigma) / inp.perimeterM;
    const r = Math.sqrt(inp.rdcPerM ** 2 + (k * rSkin) ** 2);
    const g = 2 * Math.PI * f * inp.cPerM * inp.tanD;
    const aC = (r / (2 * inp.z0)) * NP_TO_DB;
    const aD = ((g * inp.z0) / 2) * NP_TO_DB;
    out.fHz.push(f);
    out.alphaC.push(aC);
    out.alphaD.push(aD);
    out.alphaTotal.push(aC + aD);
    out.rOhmPerM.push(r);
    out.gSPerM.push(g);
    out.skinDepthUm.push(delta * 1e6);
    out.kRough.push(k);
  }
  return out;
}

/**
 * Assemble loss inputs from a solve result + the driving conductor geometry.
 * For diff pairs uses the odd mode: Zodd and C_odd = C11 - |C12|.
 */
export function lossInputsFrom(
  result: SolveResult,
  conductor: ConductorItem,
  unitScale: number,
  tanD: number,
  diffMode: boolean,
): LossInputs | null {
  if (!result.nSignals) return null;
  const c11 = result.B[0]?.[0];
  if (!Number.isFinite(c11)) return null;
  let z0 = result.z0[0];
  let c = c11;
  if (diffMode) {
    if (result.zOdd == null || result.nSignals < 2) return null;
    z0 = result.zOdd;
    // Maxwell capacitance matrix has negative off-diagonals, so the odd-mode
    // capacitance C_odd = C11 - C12 comes out as C11 + |C12|.
    const c12 = result.B[0]?.[1] ?? 0;
    c = c11 - c12;
  }
  const rdc = result.Rdc[0]?.[0];
  return {
    z0,
    cPerM: c,
    rdcPerM: Number.isFinite(rdc) ? rdc : 0,
    sigma: conductor.conductivity,
    tanD,
    perimeterM: perimeterM(conductor, unitScale),
  };
}

export const UNIT_SCALE: Record<string, number> = {
  mils: 2.54e-5,
  microns: 1e-6,
  inches: 2.54e-2,
  meters: 1,
};
