/**
 * Guided-preset -> stackup builders for microstrip, stripline, and coplanar
 * waveguide, each in single-ended and differential variants.
 *
 * Conventions (verified against the solver parser and shipped fixtures):
 * - pitch is the x-distance between conductor set start points => pitch = w + s
 *   (coplanar.xsctn: width 4.5, pitch 12, signal xOffset 6 -> edge gap 1.5).
 * - etch is the total bottom-to-top width reduction: topWidth = w - etch
 *   (clamped),
 *   bottomWidth = w (trap_test.xsctn convention: top narrower than bottom).
 * - the solver sets the dielectric/ground lateral extent to
 *   [-totW, +2*totW] where totW = max(xOffset + (n-1)*pitch + w) over
 *   conductor sets, so we pad xOffset ("margin") to widen the domain.
 * - solder mask is emitted as adjacent dielectric blocks rooted at the
 *   laminate surface. This preserves the requested base, copper and gap
 *   heights even when the copper is thicker than the mask on bare laminate.
 * - CPW: flanking ground strips are a 'gr'-named RectangleConductors set;
 *   without bottom ground we insert a thick air layer below the substrate to
 *   push the (required) bottom ground plane far away.
 */
import type {
  LengthUnits,
  Stackup,
  StackupItem,
  TrapezoidConductorsItem,
  TrapezoidDielectricItem,
} from './types.ts';
import { materialAtFrequency } from './materials.ts';

export type PresetKind = 'microstrip' | 'stripline' | 'cpw';
export type PresetVariant = 'se' | 'diff';

export interface CoverParams {
  /** mask thickness on top of the copper surface */
  tCopper: number;
  /** mask thickness on the bare laminate away from all conductors */
  tBase: number;
  /** mask thickness in the gaps between conductors */
  tBetween: number;
  er: number;
  tanD: number;
}

/** typical fab LPI solder mask: 1.2 mil base, 0.6 mil over the copper */
export const DEFAULT_COVER: CoverParams = {
  tCopper: 0.6,
  tBase: 1.2,
  tBetween: 1.2,
  er: 3.8,
  tanD: 0.02,
};

/** Normalize the current 3-thickness cover model. */
export function normalizeCover(c: unknown): CoverParams | null {
  if (!c || typeof c !== 'object') return null;
  const o = c as Record<string, unknown>;
  const numOr = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    tCopper: numOr(o.tCopper, DEFAULT_COVER.tCopper),
    tBase: numOr(o.tBase, DEFAULT_COVER.tBase),
    tBetween: numOr(o.tBetween, DEFAULT_COVER.tBetween),
    er: numOr(o.er, DEFAULT_COVER.er),
    tanD: numOr(o.tanD, DEFAULT_COVER.tanD),
  };
}

export interface PresetParams {
  units: LengthUnits;
  /** trace width (bottom of trapezoid) */
  w: number;
  /** trace thickness */
  t: number;
  /** total bottom-to-top trace-width reduction, in the selected length units */
  etch: number;
  /** dielectric height below the trace layer */
  h: number;
  /** stripline only: allow the upper dielectric to use a different material */
  striplineSeparateMaterials: boolean;
  /** Selected laminate; null means the manual er/tanD fallback is active. */
  laminateId: string | null;
  er: number;
  tanD: number;
  /** stripline upper-dielectric material (used when striplineSeparateMaterials is true) */
  laminateId2: string | null;
  er2: number;
  tanD2: number;
  /** conductor conductivity S/m */
  sigma: number;
  /** diff pair edge-to-edge gap (variant 'diff') */
  s: number;
  /** stripline only: dielectric height above the trace layer (top of lower
   *  dielectric to the top ground plane) */
  h2: number;
  /** microstrip/cpw: optional cover (solder mask) */
  cover: CoverParams | null;
  /** cpw only */
  cpwGap: number; // trace-to-flank gap g
  cpwGroundWidth: number; // flank strip width wg
  cpwBottomGround: boolean; // grounded CPW vs plain CPW (ground pushed far)
  /** solver discretization + line params */
  cseg: number;
  dseg: number;
  couplingLengthM: number;
  riseTimePs: number;
}

export function defaultParams(kind: PresetKind, variant: PresetVariant): PresetParams {
  const p: PresetParams = {
    units: 'mils',
    w: 10,
    t: 1.4, // 1 oz copper
    etch: 0.5, // JLC outer-layer default: W1 - W2 = 0.5 mil total
    h: 6,
    striplineSeparateMaterials: false,
    laminateId: 'fr402',
    er: 4.27, // FR402
    tanD: 0.016,
    laminateId2: 'fr402',
    er2: 4.27,
    tanD2: 0.016,
    sigma: 5.0e7, // copper
    s: 8,
    h2: 6,
    // conformal solder mask on by default for surface traces
    cover: { ...DEFAULT_COVER },
    cpwGap: 8,
    cpwGroundWidth: 50,
    cpwBottomGround: true,
    cseg: 45,
    dseg: 45,
    couplingLengthM: 0.0254, // 1 inch
    riseTimePs: 100,
  };
  if (kind === 'stripline') {
    p.h = 8;
    p.h2 = 8;
    p.w = 7;
    p.cover = null; // buried trace: no mask
  }
  if (kind === 'cpw') {
    p.w = 12;
    p.cpwGap = 8;
  }
  if (variant === 'diff') {
    p.w = kind === 'stripline' ? 6 : 8;
    p.s = kind === 'stripline' ? 8 : 7;
  }
  return p;
}

/** Realizable total etch reduction, limited so the top keeps >= 20% of w. */
export function etchReductionOf(w: number, etch: number): number {
  return Math.min(Math.max(etch, 0), 0.8 * Math.max(w, 0));
}

/** Return a copy with selected laminate properties resolved at the solve frequency. */
export function resolvePresetMaterials(p: PresetParams, designFreqHz: number): PresetParams {
  const resolved = { ...p };
  const lower = materialAtFrequency(p.laminateId, designFreqHz);
  if (lower) {
    resolved.er = lower.er;
    resolved.tanD = lower.tanD;
  }
  const upper = materialAtFrequency(p.laminateId2, designFreqHz);
  if (upper) {
    resolved.er2 = upper.er;
    resolved.tanD2 = upper.tanD;
  }
  return resolved;
}

/** Top width from the canonical total etch reduction. */
export function topWidthOf(w: number, etch: number): number {
  return w - etchReductionOf(w, etch);
}

function trace(
  p: PresetParams,
  idBase: string,
  number: number,
  xOffset: number,
): TrapezoidConductorsItem {
  return {
    kind: 'TrapezoidConductors',
    id: idBase,
    isGround: false,
    conductivity: p.sigma,
    number,
    pitch: number > 1 ? p.w + p.s : 0,
    xOffset,
    yOffset: 0,
    bottomWidth: p.w,
    topWidth: topWidthOf(p.w, p.etch),
    height: p.t,
  };
}

/**
 * Lateral margin so the solver's auto domain [-totW, 2*totW] comfortably
 * contains the fields: at least 3x the total dielectric height or 3x the
 * trace span, whichever is larger.
 */
function marginFor(p: PresetParams, kind: PresetKind, variant: PresetVariant): number {
  const span = variant === 'diff' ? 2 * p.w + p.s : p.w;
  const hTotal = kind === 'stripline' ? p.h + p.t + p.h2 : p.h + p.t;
  return Math.max(3 * hTotal, 3 * span);
}

export function buildPreset(
  kind: PresetKind,
  variant: PresetVariant,
  p: PresetParams,
  designFreqHz = 1e9,
): Stackup {
  p = resolvePresetMaterials(p, designFreqHz);
  const n = variant === 'diff' ? 2 : 1;
  const items: StackupItem[] = [];

  interface CoverConductor {
    center: number;
    bottomWidth: number;
    topWidth: number;
  }

  /**
   * SI9000-style conformal mask. C1 and C3 are tied by the guided UI, so the
   * common bare-board height can be one full-width layer with no overlapping
   * same-permittivity contours. Old saved cases may have C1 != C3; using the
   * larger value is a deliberate conservative fallback (never less mask than
   * requested) until they are re-saved by the tied control.
   *
   * Above that layer, every copper shape gets a true mitered, parallel-offset
   * shoulder. For conductor half-taper d=(Wb-Wt)/2 and side length l, an
   * offset C2 has bottom extension C2*l/t and top extension C2*(l-d)/t.
   * Sampling that same offset line at the base-layer height gives a shoulder
   * whose sloped faces remain exactly C2 normal to the etched copper sides,
   * while its horizontal top is exactly C2 above the copper top.
   */
  const coverItems = (conductors: CoverConductor[]): StackupItem[] => {
    if (!p.cover || conductors.length === 0) return [];
    const { tCopper, tBase, tBetween, er, tanD } = p.cover;
    const c2 = Math.max(0, tCopper);
    const base = Math.max(0, tBase, tBetween);
    const topY = p.t + c2;
    const out: StackupItem[] = [];

    if (base > 0) {
      out.push({
        kind: 'DielectricLayer',
        id: 'coverBaseLayer',
        thickness: base,
        permittivity: er,
        lossTangent: tanD,
      });
    }
    if (c2 <= 0 || topY <= base + 1e-9) return out;

    type Shoulder = {
      bottomLeft: number;
      bottomRight: number;
      topLeft: number;
      topRight: number;
    };
    const shoulders: Shoulder[] = conductors.map(({ center, bottomWidth, topWidth }) => {
      const d = (bottomWidth - topWidth) / 2;
      const sideLength = Math.hypot(p.t, d);
      const outerBottomWidth = bottomWidth + (2 * c2 * sideLength) / p.t;
      const outerTopWidth = topWidth + (2 * c2 * (sideLength - d)) / p.t;
      // The outer side has half-width slope d/t. Sample it where the common
      // C1/C3 base layer ends, rather than overlapping that layer.
      const shoulderBottomWidth = outerBottomWidth - (2 * d * base) / p.t;
      return {
        bottomLeft: center - shoulderBottomWidth / 2,
        bottomRight: center + shoulderBottomWidth / 2,
        topLeft: center - outerTopWidth / 2,
        topRight: center + outerTopWidth / 2,
      };
    }).sort((a, b) => a.bottomLeft - b.bottomLeft);

    // Tight identical shoulders are unioned into one contour. If dissimilar
    // CPW shapes overlap, use one conservative bounding rectangle rather than
    // leaving duplicate dielectric interfaces for the BEM.
    const clusters: Shoulder[][] = [];
    for (const shoulder of shoulders) {
      const cluster = clusters[clusters.length - 1];
      const right = cluster ? Math.max(...cluster.map((s) => s.bottomRight)) : -Infinity;
      if (cluster && shoulder.bottomLeft <= right + 1e-9) cluster.push(shoulder);
      else clusters.push([shoulder]);
    }

    for (const [shoulderN, cluster] of clusters.entries()) {
      let bottomLeft = Math.min(...cluster.map((s) => s.bottomLeft));
      let bottomRight = Math.max(...cluster.map((s) => s.bottomRight));
      let topLeft = Math.min(...cluster.map((s) => s.topLeft));
      let topRight = Math.max(...cluster.map((s) => s.topRight));
      const bottomCenter = (bottomLeft + bottomRight) / 2;
      const topCenter = (topLeft + topRight) / 2;
      if (Math.abs(bottomCenter - topCenter) > 1e-9) {
        bottomLeft = topLeft = Math.min(bottomLeft, topLeft);
        bottomRight = topRight = Math.max(bottomRight, topRight);
      }
      const item: TrapezoidDielectricItem = {
        kind: 'TrapezoidDielectric',
        id: `coverShoulder${shoulderN}`,
        bottomWidth: bottomRight - bottomLeft,
        topWidth: topRight - topLeft,
        height: topY - base,
        permittivity: er,
        xOffset: Math.min(bottomLeft, topLeft),
        yOffset: 0,
      };
      out.push(item);
    }
    return out;
  };

  const traceSurfaces = (xStart: number): CoverConductor[] =>
    Array.from({ length: n }, (_, k) => ({
      center: xStart + k * (p.w + p.s) + p.w / 2,
      bottomWidth: p.w,
      topWidth: topWidthOf(p.w, p.etch),
    }));

  if (kind === 'microstrip') {
    const margin = marginFor(p, kind, variant);
    items.push(
      { kind: 'GroundPlane', id: 'gnd' },
      { kind: 'DielectricLayer', id: 'sub', thickness: p.h, permittivity: p.er, lossTangent: p.tanD },
      trace(p, 'trace', n, margin),
      ...coverItems(traceSurfaces(margin)),
    );
  } else if (kind === 'stripline') {
    const margin = marginFor(p, kind, variant);
    const upperEr = p.striplineSeparateMaterials ? p.er2 : p.er;
    const upperTanD = p.striplineSeparateMaterials ? p.tanD2 : p.tanD;
    items.push(
      { kind: 'GroundPlane', id: 'gnd1', },
      { kind: 'DielectricLayer', id: 'sub1', thickness: p.h, permittivity: p.er, lossTangent: p.tanD },
      trace(p, 'trace', n, margin),
      {
        kind: 'DielectricLayer',
        id: 'sub2',
        thickness: Math.max(p.h2 + p.t, p.t * 1.05),
        permittivity: upperEr,
        lossTangent: upperTanD,
      },
      { kind: 'GroundPlane', id: 'gnd2' },
    );
  } else {
    // cpw
    const margin = marginFor(p, kind, variant);
    const wg = p.cpwGroundWidth;
    const g = p.cpwGap;
    const span = n === 1 ? p.w : 2 * p.w + p.s; // signal(s) span
    const flankPitch = wg + g + span + g;
    if (!p.cpwBottomGround) {
      // plain CPW: push the required bottom plane far away with a thick air gap
      items.push(
        { kind: 'GroundPlane', id: 'gnd' },
        {
          kind: 'DielectricLayer',
          id: 'air',
          thickness: 20 * (span + 2 * g + 2 * wg),
          permittivity: 1.0,
          lossTangent: 0,
        },
      );
    } else {
      items.push({ kind: 'GroundPlane', id: 'gnd' });
    }
    items.push(
      { kind: 'DielectricLayer', id: 'sub', thickness: p.h, permittivity: p.er, lossTangent: p.tanD },
      // flanking ground strips (name gets 'gr' prefix => ground wires)
      {
        kind: 'RectangleConductors',
        id: 'flank',
        isGround: true,
        conductivity: p.sigma,
        number: 2,
        pitch: flankPitch,
        xOffset: margin,
        yOffset: 0,
        width: wg,
        height: p.t,
      },
      { ...trace(p, 'trace', n, margin + wg + g) },
      ...coverItems([
        { center: margin + wg / 2, bottomWidth: wg, topWidth: wg },
        { center: margin + flankPitch + wg / 2, bottomWidth: wg, topWidth: wg },
        ...traceSurfaces(margin + wg + g),
      ]),
    );
  }

  return {
    title: `${kind}-${variant}`,
    units: p.units,
    items,
    couplingLengthM: p.couplingLengthM,
    riseTimePs: p.riseTimePs,
    cseg: p.cseg,
    dseg: p.dseg,
  };
}
