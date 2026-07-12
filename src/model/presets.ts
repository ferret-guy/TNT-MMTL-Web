/**
 * Guided-preset -> stackup builders for microstrip, stripline, and coplanar
 * waveguide, each in single-ended and differential variants.
 *
 * Conventions (verified against the solver parser and shipped fixtures):
 * - pitch is the x-distance between conductor set start points => pitch = w + s
 *   (coplanar.xsctn: width 4.5, pitch 12, signal xOffset 6 -> edge gap 1.5).
 * - trapezoid etch factor EF in [0..1]: topWidth = w - 2*EF*t (clamped),
 *   bottomWidth = w (trap_test.xsctn convention: top narrower than bottom).
 * - the solver sets the dielectric/ground lateral extent to
 *   [-totW, +2*totW] where totW = max(xOffset + (n-1)*pitch + w) over
 *   conductor sets, so we pad xOffset ("margin") to widen the domain.
 * - a "cover" dielectric layer after the conductors embeds them (solder mask).
 * - CPW: flanking ground strips are a 'gr'-named RectangleConductors set;
 *   without bottom ground we insert a thick air layer below the substrate to
 *   push the (required) bottom ground plane far away.
 */
import type { LengthUnits, Stackup, StackupItem, TrapezoidConductorsItem } from './types.ts';

export type PresetKind = 'microstrip' | 'stripline' | 'cpw';
export type PresetVariant = 'se' | 'diff';

export interface CoverParams {
  thickness: number;
  er: number;
  tanD: number;
}

export interface PresetParams {
  units: LengthUnits;
  /** trace width (bottom of trapezoid) */
  w: number;
  /** trace thickness */
  t: number;
  /** etch factor 0..1: topWidth = w - 2*EF*t */
  etch: number;
  /** dielectric height below the trace layer */
  h: number;
  er: number;
  tanD: number;
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
    etch: 0,
    h: 6,
    er: 4.27, // FR402
    tanD: 0.016,
    sigma: 5.0e7, // copper
    s: 8,
    h2: 6,
    cover: null,
    cpwGap: 8,
    cpwGroundWidth: 50,
    cpwBottomGround: true,
    cseg: 20,
    dseg: 20,
    couplingLengthM: 0.0254, // 1 inch
    riseTimePs: 100,
  };
  if (kind === 'stripline') {
    p.h = 8;
    p.h2 = 8;
    p.w = 7;
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

/** topWidth from etch factor, clamped so the top keeps >= 20% of w */
export function topWidthOf(w: number, t: number, etch: number): number {
  return Math.max(w - 2 * etch * t, 0.2 * w);
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
    topWidth: topWidthOf(p.w, p.t, p.etch),
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
): Stackup {
  const n = variant === 'diff' ? 2 : 1;
  const items: StackupItem[] = [];

  /**
   * Conformal cover (solder mask): constant z-thickness tm over the copper.
   *
   * The solver supports dielectric LAYERS clipped around conductors, but not
   * dielectric BLOCKS overlapping conductors -- so the model must never let
   * the lump intersect the trace. Split by regime:
   *   - layer thickness = max(t, tm): embeds the traces completely (their
   *     sidewalls are always mask-covered),
   *   - lump height = min(t, tm) over each conductor footprint (+tm each
   *     side), sitting on the layer top.
   * Over the trace the mask is exactly tm thick in both regimes; between
   * traces it is tm when tm >= t, and slightly over-thick (t) when tm < t.
   * Overlapping lumps merge (tight diff pairs); the parser places only one
   * rectangle per object, so each lump is its own item.
   */
  const coverItems = (conductorSpans: Array<[number, number]>): StackupItem[] => {
    if (!p.cover) return [];
    const tm = p.cover.thickness;
    const expanded = conductorSpans
      .map(([a, b]): [number, number] => [a - tm, b + tm])
      .sort((s1, s2) => s1[0] - s2[0]);
    const merged: Array<[number, number]> = [];
    for (const s of expanded) {
      const last = merged[merged.length - 1];
      if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
      else merged.push([...s] as [number, number]);
    }
    return [
      {
        kind: 'DielectricLayer',
        id: 'coverLayer',
        thickness: Math.max(p.t, tm),
        permittivity: p.cover.er,
        lossTangent: p.cover.tanD,
      } as StackupItem,
      ...merged.map(
        ([a, b], i): StackupItem => ({
          kind: 'RectangleDielectric',
          id: `coverLump${i}`,
          width: b - a,
          height: Math.min(p.t, tm),
          permittivity: p.cover!.er,
          xOffset: a,
          yOffset: 0,
        }),
      ),
    ];
  };

  /** conductor footprints (x spans) for the cover lumps */
  const traceSpans = (xStart: number): Array<[number, number]> => {
    const wmax = Math.max(p.w, topWidthOf(p.w, p.t, p.etch));
    return Array.from({ length: n }, (_, k): [number, number] => {
      const cx = xStart + k * (p.w + p.s);
      return [cx, cx + wmax];
    });
  };

  if (kind === 'microstrip') {
    const margin = marginFor(p, kind, variant);
    items.push(
      { kind: 'GroundPlane', id: 'gnd' },
      { kind: 'DielectricLayer', id: 'sub', thickness: p.h, permittivity: p.er, lossTangent: p.tanD },
      trace(p, 'trace', n, margin),
      ...coverItems(traceSpans(margin)),
    );
  } else if (kind === 'stripline') {
    const margin = marginFor(p, kind, variant);
    items.push(
      { kind: 'GroundPlane', id: 'gnd1', },
      { kind: 'DielectricLayer', id: 'sub1', thickness: p.h, permittivity: p.er, lossTangent: p.tanD },
      trace(p, 'trace', n, margin),
      {
        kind: 'DielectricLayer',
        id: 'sub2',
        thickness: Math.max(p.h2 + p.t, p.t * 1.05),
        permittivity: p.er,
        lossTangent: p.tanD,
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
        [margin, margin + wg],
        [margin + flankPitch, margin + flankPitch + wg],
        ...traceSpans(margin + wg + g),
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
