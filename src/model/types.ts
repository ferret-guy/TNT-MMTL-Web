/**
 * Data model mirroring the solver's .xsctn objects and attributes exactly
 * (vendor/mmtl/bem/src/nmmtl_parse_xsctn.cpp is the authoritative contract).
 *
 * All geometry values are in the stackup's `units`. Conductivity is always
 * S/m. couplingLength is in METERS (the parser treats a unitless value as
 * meters, matching csdl's file convention); riseTime is in picoseconds.
 */

export type LengthUnits = 'mils' | 'microns' | 'inches' | 'meters';

export interface GroundPlaneItem {
  kind: 'GroundPlane';
  id: string;
}

export interface DielectricLayerItem {
  kind: 'DielectricLayer';
  id: string;
  thickness: number;
  permittivity: number;
  lossTangent: number; // parsed-but-unused by the solver; used by the JS loss engine
}

export interface RectangleDielectricItem {
  kind: 'RectangleDielectric';
  id: string;
  width: number;
  height: number;
  permittivity: number;
  xOffset: number;
  yOffset: number;
}

/**
 * A dielectric trapezoid whose top and bottom edges are horizontal.
 * `xOffset` is the left edge of the wider of the two edges; the narrower
 * edge is centered in that bounding width. `yOffset` is measured from the
 * current dielectric-layer stack top.
 */
export interface TrapezoidDielectricItem {
  kind: 'TrapezoidDielectric';
  id: string;
  topWidth: number;
  bottomWidth: number;
  height: number;
  permittivity: number;
  xOffset: number;
  yOffset: number;
}

interface ConductorCommon {
  id: string;
  /** emitted with a 'gr' name prefix => solver treats as ground wires */
  isGround: boolean;
  conductivity: number; // S/m
  number: number;
  pitch: number;
  xOffset: number;
  yOffset: number;
}

export interface RectangleConductorsItem extends ConductorCommon {
  kind: 'RectangleConductors';
  width: number;
  height: number;
}

export interface TrapezoidConductorsItem extends ConductorCommon {
  kind: 'TrapezoidConductors';
  topWidth: number;
  bottomWidth: number;
  height: number;
}

export interface CircleConductorsItem extends ConductorCommon {
  kind: 'CircleConductors';
  diameter: number;
}

export type ConductorItem =
  | RectangleConductorsItem
  | TrapezoidConductorsItem
  | CircleConductorsItem;

export type StackupItem =
  | GroundPlaneItem
  | DielectricLayerItem
  | RectangleDielectricItem
  | TrapezoidDielectricItem
  | ConductorItem;

export interface Stackup {
  title: string;
  units: LengthUnits;
  items: StackupItem[]; // file order = bottom -> top
  couplingLengthM: number; // meters
  riseTimePs: number;
  cseg: number;
  dseg: number;
}

export const isConductor = (i: StackupItem): i is ConductorItem =>
  i.kind === 'RectangleConductors' ||
  i.kind === 'TrapezoidConductors' ||
  i.kind === 'CircleConductors';

export const isSignal = (i: StackupItem): i is ConductorItem =>
  isConductor(i) && !i.isGround;

/** number of signal conductors the solver will see (sets expand by `number`) */
export function signalCount(s: Stackup): number {
  return s.items.filter(isSignal).reduce((n, c) => n + c.number, 0);
}

/* ---------------- results ---------------- */

export interface SolveResult {
  nSignals: number;
  names: string[];
  /** electrostatic induction matrix [F/m], row-major nSignals x nSignals */
  B: number[][];
  /** inductance matrix [H/m] */
  L: number[][];
  /** DC resistance matrix [ohm/m] */
  Rdc: number[][];
  z0: number[]; // per signal line [ohm]
  zOdd?: number;
  zEven?: number;
  epsEff: number[];
  velocity: number[]; // m/s
  velocityOdd?: number;
  velocityEven?: number;
  delay: number[]; // s/m
  delayOdd?: number;
  delayEven?: number;
  /** crosstalk: list of {active, passive, value, dB} */
  fxt: Crosstalk[];
  bxt: Crosstalk[];
  couplingLengthM?: number;
  riseTimePs?: number;
  minFreqMHz?: number;
  warnings: string[];
}

export interface Crosstalk {
  active: string;
  passive: string;
  value: number;
  dB: number | null; // null when "infinite dB" (zero coupling)
}

export interface SolveOutput {
  ok: boolean;
  exitCode: number;
  stdout: string;
  resultText: string | null;
  fieldText: string | null;
  elapsedMs: number;
  result: SolveResult | null;
  error?: string;
}

/* ---------------- loss model ---------------- */

export type RoughnessModel = 'none' | 'hammerstad' | 'huray';

export interface LossParams {
  roughnessModel: RoughnessModel;
  /** RMS roughness Rq in micrometers */
  roughnessRqUm: number;
  /** Huray: surface ratio (typ. area covered by snowballs), default 14 spheres model */
  hurayRatio: number;
  fMinHz: number;
  fMaxHz: number;
  nPoints: number;
}
