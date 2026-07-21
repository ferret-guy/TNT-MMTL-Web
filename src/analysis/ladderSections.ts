import type { SolveResult } from '../model/types.ts';

export type LadderSectionFlow = 'preset-se' | 'preset-diff' | 'arbitrary';

function positiveFinite(value: number | undefined): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}

export function ladderDelayPerM(
  result: SolveResult,
  flow: LadderSectionFlow,
): number | null {
  const reported = result.delay.filter(positiveFinite);
  if (flow === 'preset-diff' && positiveFinite(result.delayOdd)) {
    return result.delayOdd;
  }
  if (flow === 'preset-se' && positiveFinite(result.delay[0])) {
    return result.delay[0];
  }
  return reported.length > 0 ? Math.max(...reported) : null;
}

export function requiredLadderSections(
  bandwidthHz: number,
  delayPerM: number,
  lineLengthM: number,
): number | null {
  if (
    !positiveFinite(bandwidthHz) ||
    !positiveFinite(delayPerM) ||
    !positiveFinite(lineLengthM)
  ) {
    return null;
  }
  const required = Math.ceil(13 * bandwidthHz * delayPerM * lineLengthM);
  if (!Number.isSafeInteger(required)) return null;
  return Math.max(1, required);
}

export function recommendedLadderSections(
  result: SolveResult,
  flow: LadderSectionFlow,
  lineLengthM: number,
  bandwidthHz: number,
): number | null {
  const delayPerM = ladderDelayPerM(result, flow);
  return delayPerM == null
    ? null
    : requiredLadderSections(bandwidthHz, delayPerM, lineLengthM);
}

export function formatLadderBandwidth(bandwidthHz: number): string {
  const [scale, unit] = bandwidthHz >= 1e9
    ? [1e9, 'GHz'] as const
    : [1e6, 'MHz'] as const;
  const value = Number((bandwidthHz / scale).toPrecision(3));
  return `${value} ${unit}`;
}

export function ladderSectionRequirementText(
  sections: number,
  bandwidthHz: number,
): string {
  return (
    `${sections} sections required to simulate with 1% phase error up to ` +
    `${formatLadderBandwidth(bandwidthHz)} for this line length`
  );
}
