import type {
  PresetKind,
  PresetParams,
  PresetVariant,
} from '../model/presets.ts';

export interface GuidedReferencePlaneGeometry {
  traceWidthM: number;
  traceCentersM: number[];
  lowerDistanceM: number;
  upperDistanceM?: number;
}

/**
 * Shared effective geometry for analytic reference-plane loss and current.
 * CPW is omitted because its current splits between plane and side grounds.
 */
export function guidedReferencePlaneGeometry(
  kind: PresetKind,
  variant: PresetVariant,
  p: PresetParams,
  unitScaleM: number,
): GuidedReferencePlaneGeometry | null {
  if (kind === 'cpw') return null;
  const traceWidthM =
    Math.max(p.w - p.etch / 2, p.w * 0.2) * unitScaleM;
  const pitchM = (p.w + p.s) * unitScaleM;
  const traceCentersM =
    variant === 'diff' ? [-pitchM / 2, pitchM / 2] : [0];
  const lowerDistanceM = (p.h + p.t / 2) * unitScaleM;
  const upperDistanceM =
    kind === 'stripline'
      ? (
        Math.max(p.h2 + p.t, p.t * 1.05) -
        p.t / 2
      ) * unitScaleM
      : undefined;
  return {
    traceWidthM,
    traceCentersM,
    lowerDistanceM,
    upperDistanceM,
  };
}
