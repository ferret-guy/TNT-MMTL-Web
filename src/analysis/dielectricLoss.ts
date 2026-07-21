/**
 * Dielectric-loss participation extracted from the electrostatic BEM solve.
 *
 * For small loss, the shunt-conductance matrix is
 *
 *   G(f) = 2*pi*f*K,
 *   K = sum_k tan(delta_k) * epsilon_k * dC/d(epsilon_k).
 *
 * One central directional derivative obtains the weighted sum for every
 * static-loss dielectric region with two additional capacitance solves,
 * independent of the number of dielectric items.
 */
import type { Stackup, StackupItem } from '../model/types.ts';

export const DIELECTRIC_LOG_PERMITTIVITY_STEP = 0.02;

export interface DielectricLossModel {
  /** Loss-weighted electric-energy matrix K [F/m], including tan(delta). */
  lossCapacitancePerM: number[][];
  source: 'bem-participation';
}

export interface DielectricParticipationPerturbation {
  positiveStackup: Stackup;
  negativeStackup: Stackup;
  maxLossTangent: number;
  logPermittivityStep: number;
}

export type DielectricLossMode = 'single' | 'odd' | 'even';

function isDielectric(
  item: StackupItem,
): item is Extract<StackupItem, {
  kind: 'DielectricLayer' | 'RectangleDielectric' | 'TrapezoidDielectric' | 'CircleDielectric';
}> {
  return (
    item.kind === 'DielectricLayer' ||
    item.kind === 'RectangleDielectric' ||
    item.kind === 'TrapezoidDielectric' ||
    item.kind === 'CircleDielectric'
  );
}

function itemLossTangent(item: StackupItem): number | null {
  if (!isDielectric(item)) return null;
  const value = item.lossTangent;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `Dielectric ${item.id} loss tangent must be finite and nonnegative.`,
    );
  }
  if (!Number.isFinite(item.permittivity) || !(item.permittivity > 0)) {
    throw new Error(
      `Dielectric ${item.id} permittivity must be finite and positive.`,
    );
  }
  return value;
}

export function hasLossyDielectric(stackup: Stackup): boolean {
  return stackup.items.some((item) => (itemLossTangent(item) ?? 0) > 0);
}

/**
 * Build the +/- real-permittivity solves used for the loss derivative.
 * Normalizing by max(tan(delta)) makes the largest epsilon perturbation 2%,
 * large enough for the native result precision without sacrificing the
 * central derivative's accuracy.
 */
export function dielectricParticipationPerturbation(
  stackup: Stackup,
  logPermittivityStep = DIELECTRIC_LOG_PERMITTIVITY_STEP,
): DielectricParticipationPerturbation | null {
  if (!Number.isFinite(logPermittivityStep) || !(logPermittivityStep > 0)) {
    throw new Error('The dielectric participation perturbation must be positive.');
  }
  const tangents = stackup.items.map(itemLossTangent);
  const maxLossTangent = Math.max(
    0,
    ...tangents.map((value) => value ?? 0),
  );
  if (!(maxLossTangent > 0)) return null;

  const perturb = (direction: -1 | 1): Stackup => ({
    ...stackup,
    title: `${stackup.title}-dielectric-loss-${direction > 0 ? 'plus' : 'minus'}`,
    items: stackup.items.map((item, index) => {
      const tangent = tangents[index];
      if (tangent == null || !isDielectric(item)) return { ...item };
      const exponent =
        direction * logPermittivityStep * tangent / maxLossTangent;
      return {
        ...item,
        permittivity: item.permittivity * Math.exp(exponent),
      };
    }),
  });

  return {
    positiveStackup: perturb(1),
    negativeStackup: perturb(-1),
    maxLossTangent,
    logPermittivityStep,
  };
}

function finiteSquareMatrix(matrix: number[][], label: string): number[][] {
  const size = matrix.length;
  if (
    size === 0 ||
    matrix.some(
      (row) =>
        row.length !== size || row.some((value) => !Number.isFinite(value)),
    )
  ) {
    throw new Error(`${label} must be a finite, non-empty square matrix.`);
  }
  return matrix.map((row) => [...row]);
}

function matrixScale(matrix: number[][]): number {
  return Math.max(
    Number.MIN_VALUE,
    ...matrix.flat().map((value) => Math.abs(value)),
  );
}

/** Jacobi eigensolver plus a conservative projection of roundoff-only negatives. */
function positiveSemidefiniteProjection(
  matrix: number[][],
  negativeTolerance: number,
): number[][] {
  const size = matrix.length;
  const a = matrix.map((row) => [...row]);
  const vectors: number[][] = Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => row === column ? 1 : 0));
  const scale = matrixScale(a);
  const convergence = scale * 1e-13;
  const maxIterations = Math.max(32, 80 * size * size);

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let p = 0;
    let q = 0;
    let largest = 0;
    for (let row = 0; row < size; row++) {
      for (let column = row + 1; column < size; column++) {
        const magnitude = Math.abs(a[row][column]);
        if (magnitude > largest) {
          largest = magnitude;
          p = row;
          q = column;
        }
      }
    }
    if (largest <= convergence) break;

    const app = a[p][p];
    const aqq = a[q][q];
    const apq = a[p][q];
    const angle = 0.5 * Math.atan2(2 * apq, aqq - app);
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);

    for (let index = 0; index < size; index++) {
      if (index === p || index === q) continue;
      const aip = a[index][p];
      const aiq = a[index][q];
      const nextP = cosine * aip - sine * aiq;
      const nextQ = sine * aip + cosine * aiq;
      a[index][p] = nextP;
      a[p][index] = nextP;
      a[index][q] = nextQ;
      a[q][index] = nextQ;
    }
    a[p][p] =
      cosine * cosine * app -
      2 * sine * cosine * apq +
      sine * sine * aqq;
    a[q][q] =
      sine * sine * app +
      2 * sine * cosine * apq +
      cosine * cosine * aqq;
    a[p][q] = 0;
    a[q][p] = 0;

    for (let row = 0; row < size; row++) {
      const vip = vectors[row][p];
      const viq = vectors[row][q];
      vectors[row][p] = cosine * vip - sine * viq;
      vectors[row][q] = sine * vip + cosine * viq;
    }
  }

  const eigenvalues = a.map((row, index) => row[index]);
  const minimum = Math.min(...eigenvalues);
  if (minimum < -negativeTolerance) {
    throw new Error(
      'The dielectric participation matrix is not positive semidefinite.',
    );
  }
  const clipped = eigenvalues.map((value) => Math.max(0, value));
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) =>
      clipped.reduce(
        (sum, value, index) =>
          sum + vectors[row][index] * value * vectors[column][index],
        0,
      )),
  );
}

/** Convert the two final physical capacitance matrices into K [F/m]. */
export function dielectricLossModelFromPerturbation(
  positiveCapacitance: number[][],
  negativeCapacitance: number[][],
  maxLossTangent: number,
  logPermittivityStep = DIELECTRIC_LOG_PERMITTIVITY_STEP,
  referenceCapacitance?: number[][],
): DielectricLossModel {
  const positive = finiteSquareMatrix(
    positiveCapacitance,
    'Positive dielectric perturbation capacitance',
  );
  const negative = finiteSquareMatrix(
    negativeCapacitance,
    'Negative dielectric perturbation capacitance',
  );
  if (negative.length !== positive.length) {
    throw new Error('Dielectric perturbation matrix dimensions do not match.');
  }
  if (!Number.isFinite(maxLossTangent) || !(maxLossTangent > 0)) {
    throw new Error('The maximum dielectric loss tangent must be positive.');
  }
  if (!Number.isFinite(logPermittivityStep) || !(logPermittivityStep > 0)) {
    throw new Error('The dielectric perturbation step must be positive.');
  }
  const differenceScale = maxLossTangent / (2 * logPermittivityStep);
  const raw = positive.map((row, rowIndex) => row.map((value, columnIndex) =>
    (value - negative[rowIndex][columnIndex]) * differenceScale));
  const symmetric = raw.map((row, rowIndex) => row.map(
    (_, columnIndex) =>
      (raw[rowIndex][columnIndex] + raw[columnIndex][rowIndex]) / 2,
  ));
  const reference = referenceCapacitance
    ? finiteSquareMatrix(referenceCapacitance, 'Reference capacitance')
    : positive;
  if (reference.length !== positive.length) {
    throw new Error('Reference capacitance dimensions do not match.');
  }
  const negativeTolerance = 1e-5 * Math.max(
    matrixScale(symmetric),
    maxLossTangent * matrixScale(reference),
  );
  return {
    lossCapacitancePerM: positiveSemidefiniteProjection(
      symmetric,
      negativeTolerance,
    ),
    source: 'bem-participation',
  };
}

export function dielectricConductanceMatrix(
  model: DielectricLossModel,
  frequencyHz: number,
): number[][] {
  if (!Number.isFinite(frequencyHz) || frequencyHz < 0) {
    throw new Error('Dielectric-loss frequency must be finite and nonnegative.');
  }
  const matrix = finiteSquareMatrix(
    model.lossCapacitancePerM,
    'Dielectric loss-capacitance matrix',
  );
  const omega = 2 * Math.PI * frequencyHz;
  return matrix.map((row) => row.map((value) => omega * value));
}

export function dielectricModeLossCapacitance(
  model: DielectricLossModel,
  mode: DielectricLossMode,
): number {
  const matrix = finiteSquareMatrix(
    model.lossCapacitancePerM,
    'Dielectric loss-capacitance matrix',
  );
  if (mode === 'single' || matrix.length < 2) {
    return Math.max(0, matrix[0][0]);
  }
  const sign = mode === 'odd' ? -1 : 1;
  return Math.max(
    0,
    (
      matrix[0][0] +
      matrix[1][1] +
      sign * (matrix[0][1] + matrix[1][0])
    ) / 2,
  );
}
