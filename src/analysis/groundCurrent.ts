/**
 * Quasi-static longitudinal current density on ideal reference planes.
 *
 * The signal strip is represented by a uniform current sheet using the same
 * average etched width as the analytic reference-plane loss model. Densities
 * are normalized to 1 A single-ended current or 1 A differential current.
 * The displayed return-current convention is positive beneath a +1 A signal;
 * it is the negative of physical Kz when +z follows the signal current.
 */
import type {
  PresetKind,
  PresetParams,
  PresetVariant,
} from '../model/presets.ts';
import { guidedReferencePlaneGeometry } from './referencePlaneGeometry.ts';

const MIN_POSITIVE = 1e-30;

export interface GroundCurrentPlaneTrace {
  id: 'bottom' | 'top';
  label: string;
  /** Exact integral in the displayed return-current convention, in amperes. */
  netCurrentA: number;
  /** Return-current density, positive beneath a positive signal current. */
  densityAPerM: number[];
}

export interface GroundCurrentSignalBand {
  centerM: number;
  widthM: number;
  currentA: number;
  label: string;
}

export interface GroundCurrentSurfaceSample {
  xM: number;
  yM: number;
  /** Unit normal pointing away from the conductor surface. */
  nx: number;
  ny: number;
  /** Signed return-current convention; the renderer displays its magnitude. */
  densityAPerM: number;
}

export interface GroundCurrentSurfaceElementTrace {
  samples: GroundCurrentSurfaceSample[];
}

export interface GroundCurrentSurfaceTrace {
  id: string;
  label: string;
  /** Exact signed return current from mesh quadrature. */
  netCurrentA: number;
  elements: GroundCurrentSurfaceElementTrace[];
}

export interface GroundCurrentDistribution {
  mode: string;
  normalizationLabel: string;
  xM: number[];
  planes: GroundCurrentPlaneTrace[];
  signals: GroundCurrentSignalBand[];
  /** Explicit reference conductors sampled directly on their BEM surfaces. */
  surfaces?: GroundCurrentSurfaceTrace[];
}

/**
 * Guided microstrip and stripline presets have closed-form reference-plane
 * profiles on their ideal, continuous planes. Keep those exact profiles after
 * a solve instead of replacing one stripline plane with elementwise mesh
 * samples. CPW and arbitrary free-form grounds still require the solved mesh.
 */
export function groundCurrentUsesSolvedMesh(
  mode: 'preset' | 'freeform',
  kind: PresetKind,
): boolean {
  return mode === 'freeform' || kind === 'cpw';
}

/**
 * Return-current magnitude profile beneath a uniform microstrip current sheet.
 * Its integral over all x is exactly one.
 */
export function microstripGroundCurrentDensityPerAmp(
  xM: number,
  centerM: number,
  widthM: number,
  distanceM: number,
): number {
  if (!(widthM > 0) || !(distanceM > 0)) return 0;
  const offset = xM - centerM;
  return (
    Math.atan((offset + widthM / 2) / distanceM) -
    Math.atan((offset - widthM / 2) / distanceM)
  ) / (Math.PI * widthM);
}

/**
 * Return-current magnitude on one wall of a parallel-plane stripline.
 * distanceM is the trace-center distance from the selected plane. Its
 * integral is (heightM - distanceM) / heightM.
 */
export function striplineGroundCurrentDensityPerAmp(
  xM: number,
  centerM: number,
  widthM: number,
  distanceM: number,
  heightM: number,
): number {
  if (!(widthM > 0) || !(heightM > 0)) return 0;
  const distance = Math.min(
    heightM * (1 - 1e-12),
    Math.max(heightM * 1e-12, distanceM),
  );
  const cotHalfAngle =
    1 / Math.tan((Math.PI * distance) / (2 * heightM));
  const primitive = (offsetM: number) =>
    Math.atan(
      Math.tanh((Math.PI * offsetM) / (2 * heightM)) *
      cotHalfAngle,
    ) / Math.PI;
  const offset = xM - centerM;
  return Math.max(
    0,
    (
      primitive(offset + widthM / 2) -
      primitive(offset - widthM / 2)
    ) / widthM,
  );
}

function sampleAxis(
  centersM: number[],
  widthM: number,
  marginM: number,
  featureScaleM: number,
): number[] {
  const outerCenter = Math.max(...centersM.map(Math.abs), 0);
  const halfSpan = outerCenter + widthM / 2 + marginM;
  const points = Array.from(
    { length: 501 },
    (_, index) => -halfSpan + (2 * halfSpan * index) / 500,
  );
  const offsets = [
    0,
    0.1,
    0.25,
    0.5,
    1,
    2,
    4,
    8,
  ].map((multiple) => multiple * featureScaleM);
  for (const center of centersM) {
    for (const edge of [center - widthM / 2, center + widthM / 2]) {
      for (const offset of offsets) {
        points.push(edge - offset, edge + offset);
      }
    }
    points.push(center);
  }
  points.sort((a, b) => a - b);
  const tolerance = Math.max(MIN_POSITIVE, halfSpan * 1e-12);
  return points.filter(
    (value, index) =>
      index === 0 || Math.abs(value - points[index - 1]) > tolerance,
  );
}

/**
 * Build the plotted reference-plane distribution for supported guided presets.
 * CPW is deliberately unavailable because current splits between the bottom
 * plane and coplanar grounds. Free-form geometry has no preset model here.
 */
export function presetGroundCurrentDistribution(
  kind: PresetKind,
  variant: PresetVariant,
  p: PresetParams,
  unitScaleM: number,
): GroundCurrentDistribution | null {
  const geometry = guidedReferencePlaneGeometry(
    kind,
    variant,
    p,
    unitScaleM,
  );
  if (!geometry) return null;
  const {
    traceWidthM: widthM,
    traceCentersM: centersM,
    lowerDistanceM,
    upperDistanceM = null,
  } = geometry;
  const currentsA = variant === 'diff' ? [1, -1] : [1];
  const signals = centersM.map((centerM, index) => ({
    centerM,
    widthM,
    currentA: currentsA[index],
    label:
      variant === 'diff'
        ? index === 0
          ? 'IN+ equivalent: +1 A'
          : 'IN- equivalent: -1 A'
        : 'Signal: +1 A',
  }));
  const heightM =
    upperDistanceM == null ? null : lowerDistanceM + upperDistanceM;
  const featureScaleM = Math.max(
    MIN_POSITIVE,
    Math.min(lowerDistanceM, upperDistanceM ?? lowerDistanceM),
  );
  const marginM =
    kind === 'microstrip'
      ? Math.max(widthM, 10 * lowerDistanceM)
      : Math.max(widthM, 3 * heightM!);
  const xM = sampleAxis(centersM, widthM, marginM, featureScaleM);
  const totalSignalCurrentA = currentsA.reduce(
    (sum, current) => sum + current,
    0,
  );
  const planeNetCurrent = (share: number) =>
    totalSignalCurrentA === 0 ? 0 : totalSignalCurrentA * share;

  const densityFor = (
    profile: (xM: number, centerM: number) => number,
  ) =>
    xM.map((x) =>
      centersM.reduce(
        (sum, center, index) =>
          sum + currentsA[index] * profile(x, center),
        0,
      ));

  const planes: GroundCurrentPlaneTrace[] = [];
  if (heightM == null || upperDistanceM == null) {
    planes.push({
      id: 'bottom',
      label: 'Bottom reference plane',
      netCurrentA: planeNetCurrent(1),
      densityAPerM: densityFor((x, center) =>
        microstripGroundCurrentDensityPerAmp(
          x,
          center,
          widthM,
          lowerDistanceM,
        )),
    });
  } else {
    planes.push(
      {
        id: 'bottom',
        label: 'Bottom reference plane',
        netCurrentA: planeNetCurrent(upperDistanceM / heightM),
        densityAPerM: densityFor((x, center) =>
          striplineGroundCurrentDensityPerAmp(
            x,
            center,
            widthM,
            lowerDistanceM,
            heightM,
          )),
      },
      {
        id: 'top',
        label: 'Top reference plane',
        netCurrentA: planeNetCurrent(lowerDistanceM / heightM),
        densityAPerM: densityFor((x, center) =>
          striplineGroundCurrentDensityPerAmp(
            x,
            center,
            widthM,
            upperDistanceM,
            heightM,
          )),
      },
    );
  }

  return {
    mode:
      variant === 'diff'
        ? 'differential odd mode'
        : 'single-ended',
    normalizationLabel:
      variant === 'diff'
        ? '1 A differential current (I+ = +1 A, I- = -1 A)'
        : '1 A signal current',
    xM,
    planes,
    signals,
  };
}
