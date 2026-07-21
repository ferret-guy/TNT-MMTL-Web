export type CrossSectionProgressKind =
  | 'field'
  | 'return-current'
  | 'complex-return-current';

export interface CrossSectionProgressPresentation {
  label: string;
  indicator: 'progressbar' | 'spinner';
  widthPercent: number;
  ariaValueNow: number | null;
  ariaValueText: string | null;
}

const LABELS: Record<CrossSectionProgressKind, string> = {
  field: 'Computing potential field...',
  'return-current': 'Calculating return-current density from the solved mesh...',
  'complex-return-current': 'Calculating complex return-current mesh...',
};

/** Present determinate field work and indeterminate solver work consistently. */
export function crossSectionProgressPresentation(
  kind: CrossSectionProgressKind,
  fraction?: number,
): CrossSectionProgressPresentation {
  const label = LABELS[kind];
  if (fraction === undefined || !Number.isFinite(fraction)) {
    return {
      label,
      indicator: kind === 'complex-return-current' ? 'spinner' : 'progressbar',
      widthPercent: 100,
      ariaValueNow: null,
      ariaValueText: label,
    };
  }
  const widthPercent = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  return {
    label,
    indicator: kind === 'complex-return-current' ? 'spinner' : 'progressbar',
    widthPercent,
    ariaValueNow: widthPercent,
    ariaValueText: null,
  };
}
