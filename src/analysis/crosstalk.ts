import type { Crosstalk } from '../model/types.ts';

type Matrix = readonly (readonly number[])[];

export interface CrosstalkCalculation {
  fxt: Crosstalk[];
  bxt: Crosstalk[];
}

function positiveFinite(value: number, label: string): number {
  if (!(value > 0) || !Number.isFinite(value)) {
    throw new Error(`${label} must be positive and finite.`);
  }
  return value;
}

function finiteSquareMatrix(
  matrix: Matrix,
  size: number,
  label: string,
): void {
  if (matrix.length !== size || matrix.some((row) => row.length !== size)) {
    throw new Error(`${label} must be a ${size} by ${size} matrix.`);
  }
  if (matrix.some((row) => row.some((value) => !Number.isFinite(value)))) {
    throw new Error(`${label} contains a non-finite value.`);
  }
}

function resultEntry(
  active: string,
  passive: string,
  value: number,
): Crosstalk {
  if (!Number.isFinite(value)) {
    throw new Error(`Crosstalk for ${active} and ${passive} is non-finite.`);
  }
  return {
    active,
    passive,
    value,
    dB: value === 0 ? null : 20 * Math.log10(Math.abs(value)),
  };
}

/**
 * Reproduce MMTL's pairwise forward- and backward-crosstalk calculation from
 * physical per-metre matrices. As in the native solver, each unique i < j
 * pair is reported once and the first name is the active conductor.
 */
export function calculateMmtlCrosstalk(
  names: readonly string[],
  capacitance: Matrix,
  inductance: Matrix,
  velocityMPerS: readonly number[],
  couplingLengthM: number,
  riseTimePs: number,
): CrosstalkCalculation {
  const size = names.length;
  if (new Set(names).size !== size || names.some((name) => name.length === 0)) {
    throw new Error('Crosstalk conductor names must be non-empty and unique.');
  }
  finiteSquareMatrix(capacitance, size, 'Crosstalk capacitance');
  finiteSquareMatrix(inductance, size, 'Crosstalk inductance');
  if (velocityMPerS.length !== size) {
    throw new Error(`Crosstalk velocity must contain ${size} values.`);
  }
  const lengthM = positiveFinite(couplingLengthM, 'Crosstalk coupling length');
  const riseTimeS = positiveFinite(riseTimePs, 'Crosstalk rise time') * 1e-12;

  const fxt: Crosstalk[] = [];
  const bxt: Crosstalk[] = [];
  for (let activeIndex = 0; activeIndex < size; activeIndex++) {
    const activeVelocity = positiveFinite(
      velocityMPerS[activeIndex],
      `Crosstalk velocity ${activeIndex + 1}`,
    );
    const activeCapacitance = positiveFinite(
      capacitance[activeIndex][activeIndex],
      `Crosstalk capacitance diagonal ${activeIndex + 1}`,
    );
    const activeInductance = positiveFinite(
      inductance[activeIndex][activeIndex],
      `Crosstalk inductance diagonal ${activeIndex + 1}`,
    );
    for (let passiveIndex = activeIndex + 1; passiveIndex < size; passiveIndex++) {
      const passiveCapacitance = positiveFinite(
        capacitance[passiveIndex][passiveIndex],
        `Crosstalk capacitance diagonal ${passiveIndex + 1}`,
      );
      const passiveInductance = positiveFinite(
        inductance[passiveIndex][passiveIndex],
        `Crosstalk inductance diagonal ${passiveIndex + 1}`,
      );

      // The native MMTL implementation intentionally reads the lower
      // triangle rather than averaging the two mutual entries.
      const capacitiveCoupling =
        -capacitance[passiveIndex][activeIndex] /
        Math.sqrt(activeCapacitance * passiveCapacitance);
      const inductiveCoupling =
        inductance[passiveIndex][activeIndex] /
        Math.sqrt(activeInductance * passiveInductance);
      const active = names[activeIndex];
      const passive = names[passiveIndex];

      const backwardWindow = 2 * lengthM / activeVelocity;
      const backwardValue =
        0.25 * (capacitiveCoupling + inductiveCoupling) *
        Math.min(1, backwardWindow / riseTimeS);
      bxt.push(resultEntry(active, passive, backwardValue));

      const forwardScale = Math.pow(
        activeCapacitance * passiveCapacitance *
          activeInductance * passiveInductance,
        0.25,
      );
      const forwardValue =
        0.5 * lengthM * forwardScale *
        (capacitiveCoupling - inductiveCoupling) / riseTimeS;
      fxt.push(resultEntry(active, passive, forwardValue));
    }
  }
  return { fxt, bxt };
}
