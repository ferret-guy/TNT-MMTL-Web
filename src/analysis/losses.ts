/**
 * Frequency-dependent loss estimation -- analytic post-processing on top of
 * the quasi-static solver outputs, mirroring TNT's HSPICE W-element
 * generator (bem/lib/bem_welement.itcl) for the scalar R/G estimates:
 *   Rs(f)  = sqrt(pi f mu0 / sigma) / perimeter        [ohm/m]
 *   R(f)   = sqrt(Rdc^2 + (K(f) * Rs(f))^2)            [smooth DC->skin]
 *   G(f)   = 2 pi f C tan(delta)                       [S/m]
 * Attenuation is then calculated from the exact scalar propagation constant
 *   gamma = sqrt((R + j omega L)(G + j omega C)),
 * rather than the usual low-loss approximation.
 *
 * K(f) is the surface-roughness multiplier:
 *   - Hammerstad-Jensen: K = 1 + (2/pi) atan(1.4 (Rq/delta)^2)   (K <= 2)
 *   - One-radius Hall-Huray: K = 1 + (3/2) * SR /
 *         (1 + delta/r + delta^2/(2 r^2))
 *     where r is effective nodule radius and SR is total spherical-nodule
 *     surface area divided by flat reference area.
 * where delta = skin depth = 1/sqrt(pi f mu0 sigma).
 *
 * The solver itself has no roughness or frequency dependence -- TNT never
 * had a roughness parameter; this panel is labeled as analytic estimation.
 */
import type { LossParams, SolveResult } from '../model/types.ts';
import type { ConductorItem } from '../model/types.ts';
import {
  COPPER_CONDUCTIVITY_S_PER_M,
  materialAtFrequency,
} from '../model/materials.ts';
import {
  referencePlaneThicknessOf,
  type PresetKind,
  type PresetParams,
  type PresetVariant,
} from '../model/presets.ts';
import { striplineGroundCurrentDensityPerAmp } from './groundCurrent.ts';
import { guidedReferencePlaneGeometry } from './referencePlaneGeometry.ts';
import {
  dielectricModeLossCapacitance,
  type DielectricLossMode,
  type DielectricLossModel,
} from './dielectricLoss.ts';

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
  roughnessSizeM: number,
  deltaM: number,
  hurayRatio: number,
): number {
  if (model === 'none' || roughnessSizeM <= 0) return 1;
  if (model === 'hammerstad') {
    return 1 + (2 / Math.PI) * Math.atan(1.4 * (roughnessSizeM / deltaM) ** 2);
  }
  // Original real-valued Huray power-loss correction. Its inputs are
  // independent: effective spherical-nodule radius r and Hall-Huray surface
  // ratio SR = total nodule surface area / flat reference area.
  const r = roughnessSizeM;
  const areaRatio = hurayRatio;
  return 1 + ((3 / 2) * areaRatio) / (1 + deltaM / r + (deltaM * deltaM) / (2 * r * r));
}

export interface ReferencePlaneLossTerm {
  /** Return-current overlap matrix Q [1/m] for this material region. */
  geometryPerM: number[][];
  conductivity: number;
  thicknessM: number;
  label?: string;
}

export interface ReferencePlaneLossModel {
  /**
   * Legacy single-material representation. These fields remain supported,
   * but a non-empty terms array is authoritative when both forms are present.
   */
  geometryPerM?: number[][];
  conductivity?: number;
  thicknessM?: number;
  /** Independently weighted material/geometry regions from a mesh extraction. */
  terms?: ReferencePlaneLossTerm[];
  /** Identifies the geometry extraction used for export documentation. */
  source?: 'analytic' | 'mesh';
}

export type ReferencePlaneMode = 'single' | 'odd' | 'even';

/**
 * Smooth finite-thickness copper-sheet resistance.
 *
 * This is the real part of the exact slab surface impedance. The explicit
 * thin/thick limits avoid cancellation and overflow.
 */
export function referencePlaneSheetResistanceOhm(
  fHz: number,
  conductivity: number,
  thicknessM: number,
): number {
  if (!(fHz > 0) || !(conductivity > 0) || !(thicknessM > 0)) return 0;
  const delta = skinDepthM(fHz, conductivity);
  const x = thicknessM / delta;
  const dcSheet = 1 / (conductivity * thicknessM);
  if (x < 1e-3) return dcSheet * (1 + (4 * x ** 4) / 45);
  if (x > 20) return 1 / (conductivity * delta);
  return (
    (Math.sinh(2 * x) + Math.sin(2 * x)) /
    (conductivity * delta * (Math.cosh(2 * x) - Math.cos(2 * x)))
  );
}

function adaptiveSimpson(
  fn: (x: number) => number,
  low: number,
  high: number,
  tolerance: number,
  maxDepth = 20,
): number {
  const middle = (low + high) / 2;
  const lowValue = fn(low);
  const middleValue = fn(middle);
  const highValue = fn(high);
  const whole =
    ((high - low) * (lowValue + 4 * middleValue + highValue)) / 6;

  const recurse = (
    left: number,
    right: number,
    leftValue: number,
    centerValue: number,
    rightValue: number,
    estimate: number,
    localTolerance: number,
    depth: number,
  ): number => {
    const center = (left + right) / 2;
    const leftCenter = (left + center) / 2;
    const rightCenter = (center + right) / 2;
    const leftCenterValue = fn(leftCenter);
    const rightCenterValue = fn(rightCenter);
    const leftEstimate =
      ((center - left) *
        (leftValue + 4 * leftCenterValue + centerValue)) /
      6;
    const rightEstimate =
      ((right - center) *
        (centerValue + 4 * rightCenterValue + rightValue)) /
      6;
    const refined = leftEstimate + rightEstimate;
    const correction = refined - estimate;
    if (
      depth <= 0 ||
      Math.abs(correction) <= 15 * localTolerance
    ) {
      return refined + correction / 15;
    }
    return (
      recurse(
        left,
        center,
        leftValue,
        leftCenterValue,
        centerValue,
        leftEstimate,
        localTolerance / 2,
        depth - 1,
      ) +
      recurse(
        center,
        right,
        centerValue,
        rightCenterValue,
        rightValue,
        rightEstimate,
        localTolerance / 2,
        depth - 1,
      )
    );
  };

  return recurse(
    low,
    high,
    lowValue,
    middleValue,
    highValue,
    whole,
    tolerance,
    maxDepth,
  );
}

function sortedUnique(values: number[]): number[] {
  const sorted = values
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const scale = Math.max(
    1,
    ...sorted.map((value) => Math.abs(value)),
  );
  const tolerance = scale * Number.EPSILON * 16;
  return sorted.filter(
    (value, index) =>
      index === 0 || Math.abs(value - sorted[index - 1]) > tolerance,
  );
}

/**
 * Exact spatial overlap of uniform-strip current profiles between two
 * infinite parallel reference planes.
 *
 * Integrating the closed-form profiles avoids the oscillatory sinc integral
 * used previously. That Fourier-space quadrature could hit its sample cap
 * and understate loss for a trace thousands of plane spacings wide.
 */
export function striplineReferencePlaneOverlapPerM(
  widthM: number,
  separationM: number,
  lowerDistanceM: number,
  upperDistanceM: number,
): number {
  if (
    !(widthM > 0) ||
    !(lowerDistanceM > 0) ||
    !(upperDistanceM > 0)
  ) {
    return 0;
  }
  const heightM = lowerDistanceM + upperDistanceM;
  const width = widthM / heightM;
  const separation = Math.abs(separationM) / heightM;
  const lowerDistance = lowerDistanceM / heightM;
  const upperDistance = upperDistanceM / heightM;
  const centers = [-separation / 2, separation / 2];
  const profile = (
    x: number,
    center: number,
    distance: number,
  ) =>
    striplineGroundCurrentDensityPerAmp(
      x,
      center,
      width,
      distance,
      1,
    );
  const integrand = (x: number) =>
    profile(x, centers[0], lowerDistance) *
      profile(x, centers[1], lowerDistance) +
    profile(x, centers[0], upperDistance) *
      profile(x, centers[1], upperDistance);

  // Stripline tails outside a trace edge decay exponentially on the plate
  // spacing. Explicit edge neighborhoods also make the adaptive integral
  // reliable when width/height is many thousands.
  const edges = centers.flatMap((center) => [
    center - width / 2,
    center + width / 2,
  ]);
  const outerLow = Math.min(...edges);
  const outerHigh = Math.max(...edges);
  const feature = Math.min(lowerDistance, upperDistance);
  const offsets = sortedUnique([
    0,
    feature / 8,
    feature / 4,
    feature / 2,
    feature,
    2 * feature,
    4 * feature,
    8 * feature,
    1 / 4,
    1 / 2,
    1,
    2,
    4,
    8,
  ]);
  const limits = sortedUnique([
    outerLow - 16,
    outerHigh + 16,
    ...centers,
    ...edges,
    ...edges.flatMap((edge) =>
      offsets.flatMap((offset) => [edge - offset, edge + offset])),
  ]).filter(
    (value) => value >= outerLow - 16 && value <= outerHigh + 16,
  );
  const scaleEstimate = 1 / Math.max(width, feature);
  const totalTolerance =
    Math.max(1e-14, 1e-9 * scaleEstimate);
  const intervalTolerance =
    totalTolerance / Math.max(1, limits.length - 1);
  let dimensionlessOverlap = 0;
  for (let index = 1; index < limits.length; index++) {
    dimensionlessOverlap += adaptiveSimpson(
      integrand,
      limits[index - 1],
      limits[index],
      intervalTolerance,
    );
  }
  return Math.max(0, dimensionlessOverlap / heightM);
}

/**
 * Analytic self-overlap for a uniform strip above one infinite plane.
 * Its inverse is the effective return-current width.
 */
export function microstripReferencePlaneSelfOverlapPerM(
  widthM: number,
  distanceM: number,
): number {
  return microstripReferencePlaneOverlapPerM(widthM, distanceM, 0);
}

/**
 * Closed-form overlap of two equal uniform-strip return-current profiles.
 * This avoids oscillatory quadrature for extreme microstrip aspect ratios.
 */
export function microstripReferencePlaneOverlapPerM(
  widthM: number,
  distanceM: number,
  separationM: number,
): number {
  if (!(widthM > 0) || !(distanceM > 0)) return 0;
  const primitive = (offsetM: number) => {
    const offset = Math.abs(offsetM);
    if (offset === 0) return 0;
    const ratio = offset / (2 * distanceM);
    return (
      offset * Math.atan(ratio) -
      distanceM * Math.log1p(ratio * ratio)
    );
  };
  const separation = Math.abs(separationM);
  return Math.max(
    0,
    (
      primitive(separation + widthM) +
      primitive(separation - widthM) -
      2 * primitive(separation)
    ) /
    (Math.PI * widthM * widthM),
  );
}

/**
 * Reference-plane geometry for guided presets. CPW is deliberately omitted:
 * its return current splits between the coplanar flanks and bottom plane.
 */
export function presetReferencePlaneLossModel(
  kind: PresetKind,
  variant: PresetVariant,
  p: PresetParams,
  unitScaleM: number,
): ReferencePlaneLossModel | null {
  const geometry = guidedReferencePlaneGeometry(
    kind,
    variant,
    p,
    unitScaleM,
  );
  if (!geometry) return null;
  const {
    traceWidthM: widthM,
    traceCentersM,
    lowerDistanceM,
    upperDistanceM,
  } = geometry;
  const count = traceCentersM.length;
  const geometryPerM = Array.from({ length: count }, (_, row) =>
    Array.from({ length: count }, (_, column) => {
      if (upperDistanceM == null) {
        return microstripReferencePlaneOverlapPerM(
          widthM,
          lowerDistanceM,
          Math.abs(traceCentersM[row] - traceCentersM[column]),
        );
      }
      return striplineReferencePlaneOverlapPerM(
        widthM,
        Math.abs(traceCentersM[row] - traceCentersM[column]),
        lowerDistanceM,
        upperDistanceM,
      );
    }));
  for (let row = 0; row < count; row++) {
    geometryPerM[row][row] = Math.max(0, geometryPerM[row][row]);
    for (let column = 0; column < row; column++) {
      const limit = Math.sqrt(
        geometryPerM[row][row] * geometryPerM[column][column],
      );
      const mutual = Math.max(
        0,
        Math.min(
          limit,
          (geometryPerM[row][column] + geometryPerM[column][row]) / 2,
        ),
      );
      geometryPerM[row][column] = mutual;
      geometryPerM[column][row] = mutual;
    }
  }
  return {
    geometryPerM,
    conductivity: COPPER_CONDUCTIVITY_S_PER_M,
    thicknessM: referencePlaneThicknessOf(p) * unitScaleM,
    source: 'analytic',
  };
}

function referencePlaneLossTerms(
  model: ReferencePlaneLossModel,
): ReferencePlaneLossTerm[] {
  if (model.terms?.length) return model.terms;
  if (
    model.geometryPerM != null &&
    model.conductivity != null &&
    model.thicknessM != null
  ) {
    return [{
      geometryPerM: model.geometryPerM,
      conductivity: model.conductivity,
      thicknessM: model.thicknessM,
    }];
  }
  return [];
}

function sumReferencePlaneTerms(
  model: ReferencePlaneLossModel,
  sheetValue: (term: ReferencePlaneLossTerm) => number,
): number[][] {
  const terms = referencePlaneLossTerms(model);
  const firstGeometry = terms[0]?.geometryPerM;
  if (!firstGeometry) return [];
  const result = firstGeometry.map((row) => row.map(() => 0));
  for (const term of terms) {
    const sheet = sheetValue(term);
    for (let row = 0; row < result.length; row++) {
      for (let column = 0; column < result[row].length; column++) {
        result[row][column] +=
          (term.geometryPerM[row]?.[column] ?? 0) * sheet;
      }
    }
  }
  return result;
}

export function referencePlaneDcResistanceMatrix(
  model: ReferencePlaneLossModel,
): number[][] {
  return sumReferencePlaneTerms(
    model,
    (term) => 1 / (term.conductivity * term.thicknessM),
  );
}

export function referencePlaneSkinCoefficientMatrix(
  model: ReferencePlaneLossModel,
): number[][] {
  return sumReferencePlaneTerms(
    model,
    (term) => Math.sqrt(Math.PI * MU0 / term.conductivity),
  );
}

export function referencePlaneResistanceMatrix(
  model: ReferencePlaneLossModel,
  p: LossParams,
  fHz: number,
): number[][] {
  const roughnessSizeM = (
    p.roughnessModel === 'huray' ? p.hurayRadiusUm : p.roughnessRqUm
  ) * 1e-6;
  return sumReferencePlaneTerms(
    model,
    (term) => {
      const dcSheet = 1 / (term.conductivity * term.thicknessM);
      const smoothSheet = referencePlaneSheetResistanceOhm(
        fHz,
        term.conductivity,
        term.thicknessM,
      );
      const k = roughnessK(
        p.roughnessModel,
        roughnessSizeM,
        skinDepthM(fHz, term.conductivity),
        p.hurayRatio,
      );
      return dcSheet + k * Math.max(0, smoothSheet - dcSheet);
    },
  );
}

export function referencePlaneModeValue(
  matrix: number[][],
  mode: ReferencePlaneMode,
): number {
  if (mode === 'single' || matrix.length < 2) return matrix[0]?.[0] ?? 0;
  const sign = mode === 'odd' ? -1 : 1;
  return Math.max(
    0,
    (
      (matrix[0]?.[0] ?? 0) +
      (matrix[1]?.[1] ?? 0) +
      sign * (matrix[0]?.[1] ?? 0) +
      sign * (matrix[1]?.[0] ?? 0)
    ) / 2,
  );
}

export interface LossCurve {
  fHz: number[];
  alphaC: number[]; // dB/m conductor
  alphaD: number[]; // dB/m dielectric
  alphaTotal: number[];
  rOhmPerM: number[];
  rSignalOhmPerM: number[];
  rReferenceOhmPerM: number[];
  rdcSignalOhmPerM: number;
  rdcReferenceOhmPerM: number;
  gSPerM: number[];
  skinDepthUm: number[];
  kRough: number[];
}

export interface LossInputs {
  z0: number; // ohms (mode impedance: single-ended z0 or zOdd for diff)
  cPerM: number; // F/m (mode capacitance)
  lPerM: number; // H/m (mode inductance, consistent with z0 and C)
  rdcPerM: number; // ohm/m
  sigma: number; // S/m
  /** Design-frequency/custom fallback. */
  tanD: number;
  /** Optional dispersive material lookup, evaluated at every plot point. */
  tanDAtHz?: (fHz: number) => number;
  /** Solved heterogeneous dielectric participation; authoritative when set. */
  dielectricLoss?: DielectricLossModel;
  dielectricLossMode?: DielectricLossMode;
  perimeterM: number;
  referencePlane?: ReferencePlaneLossModel;
  referencePlaneMode?: ReferencePlaneMode;
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

/** Material-model tan δ used by the plotted IL curve at each frequency. */
export function presetLossTangentAtFrequency(
  kind: PresetKind,
  p: PresetParams,
  fHz: number,
): number {
  const at = (id: string | null, er: number, tanD: number) => {
    const material = materialAtFrequency(id, fHz);
    return material ? { er: material.er, tanD: material.tanD } : { er, tanD };
  };
  const lower = at(p.laminateId, p.er, p.tanD);
  if (kind !== 'stripline' || !p.striplineSeparateMaterials) return lower.tanD;
  const upper = at(p.laminateId2, p.er2, p.tanD2);
  return striplineEffectiveLossTangent(
    lower.er, p.h, lower.tanD,
    upper.er, p.h2, upper.tanD,
  );
}

const NP_TO_DB = 8.685889638;

/**
 * Exact scalar RLGC attenuation, avoiding the low-loss alpha approximation.
 *
 * The negative-real-axis branch uses 2uv = Im(gamma^2), which avoids the
 * catastrophic cancellation in hypot(re, im) + re for a low-loss line.
 */
export function attenuationDbPerM(
  rOhmPerM: number,
  lHPerM: number,
  gSPerM: number,
  cFPerM: number,
  fHz: number,
): number {
  const omega = 2 * Math.PI * fHz;
  // gamma² = (R + jωL)(G + jωC)
  const re = rOhmPerM * gSPerM - omega * omega * lHPerM * cFPerM;
  const im = omega * (rOhmPerM * cFPerM + lHPerM * gSPerM);
  const magnitude = Math.hypot(re, im);
  let alphaNpPerM: number;
  if (re >= 0) {
    alphaNpPerM = Math.sqrt(Math.max(0, (magnitude + re) / 2));
  } else {
    const betaMagnitude = Math.sqrt(Math.max(0, (magnitude - re) / 2));
    alphaNpPerM = betaMagnitude > 0 ? Math.abs(im) / (2 * betaMagnitude) : 0;
  }
  return alphaNpPerM * NP_TO_DB;
}

export function lossCurve(inp: LossInputs, p: LossParams): LossCurve {
  const out: LossCurve = {
    fHz: [],
    alphaC: [],
    alphaD: [],
    alphaTotal: [],
    rOhmPerM: [],
    rSignalOhmPerM: [],
    rReferenceOhmPerM: [],
    rdcSignalOhmPerM: inp.rdcPerM,
    rdcReferenceOhmPerM:
      p.includeReferencePlaneLoss && inp.referencePlane
        ? referencePlaneModeValue(
          referencePlaneDcResistanceMatrix(inp.referencePlane),
          inp.referencePlaneMode ?? 'single',
        )
        : 0,
    gSPerM: [],
    skinDepthUm: [],
    kRough: [],
  };
  const logMin = Math.log10(p.fMinHz);
  const logMax = Math.log10(p.fMaxHz);
  const n = Math.max(2, p.nPoints);
  const roughnessSizeM = (
    p.roughnessModel === 'huray' ? p.hurayRadiusUm : p.roughnessRqUm
  ) * 1e-6;
  for (let i = 0; i < n; i++) {
    const f = 10 ** (logMin + ((logMax - logMin) * i) / (n - 1));
    const delta = skinDepthM(f, inp.sigma);
    const k = roughnessK(p.roughnessModel, roughnessSizeM, delta, p.hurayRatio);
    const rSkin = Math.sqrt(Math.PI * f * MU0 / inp.sigma) / inp.perimeterM;
    // TNT's smooth engineering blend gives the correct DC and skin-effect
    // asymptotes, but is not a proximity/current-crowding field solution.
    const rSignal = Math.hypot(inp.rdcPerM, k * rSkin);
    const rReference =
      p.includeReferencePlaneLoss && inp.referencePlane
        ? referencePlaneModeValue(
          referencePlaneResistanceMatrix(inp.referencePlane, p, f),
          inp.referencePlaneMode ?? 'single',
        )
        : 0;
    const r = rSignal + rReference;
    const lookedUpTanD = inp.tanDAtHz?.(f);
    const tanD = Number.isFinite(lookedUpTanD) && lookedUpTanD! >= 0
      ? lookedUpTanD!
      : inp.tanD;
    const lossCapacitance = inp.dielectricLoss
      ? dielectricModeLossCapacitance(
        inp.dielectricLoss,
        inp.dielectricLossMode ?? 'single',
      )
      : inp.cPerM * tanD;
    const g = 2 * Math.PI * f * lossCapacitance;
    const aC = attenuationDbPerM(r, inp.lPerM, 0, inp.cPerM, f);
    const aD = attenuationDbPerM(0, inp.lPerM, g, inp.cPerM, f);
    const aTotal = attenuationDbPerM(r, inp.lPerM, g, inp.cPerM, f);
    out.fHz.push(f);
    out.alphaC.push(aC);
    out.alphaD.push(aD);
    out.alphaTotal.push(aTotal);
    out.rOhmPerM.push(r);
    out.rSignalOhmPerM.push(rSignal);
    out.rReferenceOhmPerM.push(rReference);
    out.gSPerM.push(g);
    out.skinDepthUm.push(delta * 1e6);
    out.kRough.push(k);
  }
  return out;
}

/**
 * Derive the UI/export sweep from the selected design frequency.
 *
 * Keep an explicitly lower starting frequency, while guaranteeing that the
 * sweep includes the design point and extends exactly one decade above it.
 * Returning a copy keeps callers from mutating persisted loss settings.
 */
export function lossSweepParamsForDesign(
  params: LossParams,
  designFreqHz: number,
): LossParams {
  if (!Number.isFinite(designFreqHz) || designFreqHz <= 0) return { ...params };
  const fMaxHz = designFreqHz > Number.MAX_VALUE / 10
    ? Number.MAX_VALUE
    : designFreqHz * 10;
  return {
    ...params,
    fMinHz: Math.min(params.fMinHz, designFreqHz),
    fMaxHz,
  };
}

/**
 * Assemble loss inputs from a solve result + the driving conductor geometry.
 * For diff pairs uses the odd mode: Zodd and C_odd = C11 - C12.
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
  let l = result.L?.[0]?.[0];
  if (diffMode) {
    if (result.zOdd == null || result.nSignals < 2) return null;
    z0 = result.zOdd;
    // Maxwell capacitance matrix has negative off-diagonals, so the odd-mode
    // capacitance C_odd = C11 - C12 comes out as C11 + |C12|.
    const c12 = result.B[0]?.[1] ?? 0;
    c = c11 - c12;
    const l11 = result.L?.[0]?.[0];
    const l12 = result.L?.[0]?.[1] ?? 0;
    l = Number.isFinite(l11) ? l11 - l12 : Number.NaN;
  }
  if (!Number.isFinite(l) || l <= 0) l = z0 * z0 * c;
  const rdc = result.Rdc[0]?.[0];
  return {
    z0,
    cPerM: c,
    lPerM: l,
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
