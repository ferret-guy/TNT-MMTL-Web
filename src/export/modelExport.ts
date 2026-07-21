import {
  perimeterM,
  referencePlaneDcResistanceMatrix,
  referencePlaneModeValue,
  referencePlaneResistanceMatrix,
  referencePlaneSkinCoefficientMatrix,
  roughnessK,
  skinDepthM,
  type ReferencePlaneLossModel,
  type ReferencePlaneMode,
} from '../analysis/losses.ts';
import {
  dielectricConductanceMatrix,
  dielectricModeLossCapacitance,
  type DielectricLossMode,
  type DielectricLossModel,
} from '../analysis/dielectricLoss.ts';
import type {
  ConductorItem,
  LossParams,
  SolveResult,
} from '../model/types.ts';

const MU0 = 4e-7 * Math.PI;
const DEFAULT_REFERENCE_OHM = 50;
const MIN_POSITIVE = 1e-30;

interface Complex {
  re: number;
  im: number;
}

export interface ModelExportInput {
  title: string;
  /** Guided presets retain their conventional pin names; free-form models use solver names. */
  flow: 'preset-se' | 'preset-diff' | 'arbitrary';
  result: SolveResult;
  /** Signal conductors in the exact order used by result.names. */
  conductors: ConductorItem[];
  unitScaleM: number;
  lengthM: number;
  designFreqHz: number;
  lossParams: LossParams;
  /** Optional analytic or mesh-derived return-current loss model. */
  referencePlane?: ReferencePlaneLossModel;
  /** Solved heterogeneous dielectric participation; authoritative when set. */
  dielectricLoss?: DielectricLossModel;
  tanD: number;
  tanDAtHz?: (frequencyHz: number) => number;
}

export interface ExportedModelFile {
  filename: string;
  mimeType: 'text/plain;charset=utf-8';
  text: string;
}

const complex = (re = 0, im = 0): Complex => ({ re, im });
const cAdd = (a: Complex, b: Complex): Complex => complex(a.re + b.re, a.im + b.im);
const cSub = (a: Complex, b: Complex): Complex => complex(a.re - b.re, a.im - b.im);
const cScale = (a: Complex, scale: number): Complex => complex(a.re * scale, a.im * scale);
const cMul = (a: Complex, b: Complex): Complex =>
  complex(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
const cDiv = (a: Complex, b: Complex): Complex => {
  const denominator = b.re * b.re + b.im * b.im;
  if (!(denominator > 0)) throw new Error('The transmission-line calculation became singular.');
  return complex(
    (a.re * b.re + a.im * b.im) / denominator,
    (a.im * b.re - a.re * b.im) / denominator,
  );
};
const cSqrt = (value: Complex): Complex => {
  const magnitude = Math.hypot(value.re, value.im);
  const re = Math.sqrt(Math.max(0, (magnitude + value.re) / 2));
  const imMagnitude = Math.sqrt(Math.max(0, (magnitude - value.re) / 2));
  return complex(re, value.im < 0 ? -imMagnitude : imMagnitude);
};
const cSinh = (value: Complex): Complex =>
  complex(
    Math.sinh(value.re) * Math.cos(value.im),
    Math.cosh(value.re) * Math.sin(value.im),
  );
const cCosh = (value: Complex): Complex =>
  complex(
    Math.cosh(value.re) * Math.cos(value.im),
    Math.sinh(value.re) * Math.sin(value.im),
  );

const zeroComplexMatrix = (size: number): Complex[][] =>
  Array.from({ length: size }, () =>
    Array.from({ length: size }, () => complex()));

const identityComplexMatrix = (size: number): Complex[][] => {
  const matrix = zeroComplexMatrix(size);
  for (let index = 0; index < size; index++) matrix[index][index] = complex(1);
  return matrix;
};

const complexMatrixNormOne = (matrix: Complex[][]): number => {
  let norm = 0;
  for (let column = 0; column < matrix.length; column++) {
    let sum = 0;
    for (let row = 0; row < matrix.length; row++) {
      sum += Math.hypot(matrix[row][column].re, matrix[row][column].im);
    }
    norm = Math.max(norm, sum);
  }
  return norm;
};

const scaleComplexMatrix = (matrix: Complex[][], scale: number): Complex[][] =>
  matrix.map((row) => row.map((value) => cScale(value, scale)));

const addComplexMatrices = (a: Complex[][], b: Complex[][]): Complex[][] =>
  a.map((row, rowIndex) =>
    row.map((value, columnIndex) => cAdd(value, b[rowIndex][columnIndex])));

const multiplyComplexMatrices = (a: Complex[][], b: Complex[][]): Complex[][] => {
  const size = a.length;
  const product = zeroComplexMatrix(size);
  for (let row = 0; row < size; row++) {
    for (let inner = 0; inner < size; inner++) {
      const left = a[row][inner];
      if (left.re === 0 && left.im === 0) continue;
      for (let column = 0; column < size; column++) {
        product[row][column] = cAdd(
          product[row][column],
          cMul(left, b[inner][column]),
        );
      }
    }
  }
  return product;
};

function invertComplexMatrix(matrix: Complex[][]): Complex[][] {
  const size = matrix.length;
  const identity = identityComplexMatrix(size);
  const augmented = matrix.map((row, rowIndex) => [
    ...row.map((value) => complex(value.re, value.im)),
    ...identity[rowIndex],
  ]);
  const pivotFloor = Math.max(1, complexMatrixNormOne(matrix)) * 1e-14;
  for (let column = 0; column < size; column++) {
    let pivotRow = column;
    let pivotMagnitude = 0;
    for (let row = column; row < size; row++) {
      const value = augmented[row][column];
      const magnitude = Math.hypot(value.re, value.im);
      if (magnitude > pivotMagnitude) {
        pivotMagnitude = magnitude;
        pivotRow = row;
      }
    }
    if (!(pivotMagnitude > pivotFloor)) {
      throw new Error('The multiconductor transmission-line calculation became singular.');
    }
    if (pivotRow !== column) {
      [augmented[column], augmented[pivotRow]] = [augmented[pivotRow], augmented[column]];
    }
    const pivot = augmented[column][column];
    for (let index = 0; index < 2 * size; index++) {
      augmented[column][index] = cDiv(augmented[column][index], pivot);
    }
    for (let row = 0; row < size; row++) {
      if (row === column) continue;
      const factor = augmented[row][column];
      if (factor.re === 0 && factor.im === 0) continue;
      for (let index = 0; index < 2 * size; index++) {
        augmented[row][index] = cSub(
          augmented[row][index],
          cMul(factor, augmented[column][index]),
        );
      }
    }
  }
  return augmented.map((row) => row.slice(size));
}

/**
 * Scaling-and-squaring complex matrix exponential. Scaling below a 0.5
 * one-norm keeps the Taylor series short for the small MTL state matrices.
 */
function expComplexMatrix(matrix: Complex[][]): Complex[][] {
  const size = matrix.length;
  const norm = complexMatrixNormOne(matrix);
  if (norm === 0) return identityComplexMatrix(size);
  const squarings = Math.max(0, Math.ceil(Math.log2(norm / 0.5)));
  const scaled = scaleComplexMatrix(matrix, 2 ** -squarings);
  let sum = identityComplexMatrix(size);
  let term = identityComplexMatrix(size);
  let converged = false;
  for (let order = 1; order <= 96; order++) {
    term = scaleComplexMatrix(
      multiplyComplexMatrices(term, scaled),
      1 / order,
    );
    sum = addComplexMatrices(sum, term);
    if (
      complexMatrixNormOne(term) <=
      Number.EPSILON * Math.max(1, complexMatrixNormOne(sum))
    ) {
      converged = true;
      break;
    }
  }
  if (!converged) {
    throw new Error('The multiconductor transmission-line calculation did not converge.');
  }
  for (let index = 0; index < squarings; index++) {
    sum = multiplyComplexMatrices(sum, sum);
  }
  return sum;
}

export function modelExportBasename(title: string): string {
  const cleaned = title
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  return cleaned || 'web-mmtl-line';
}

function safeSubcktName(title: string): string {
  const cleaned = title
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const prefixed = /^[A-Z]/.test(cleaned) ? cleaned : `LINE_${cleaned}`;
  return (prefixed || 'WEB_MMTL_LINE').slice(0, 48);
}

function finiteScientific(value: number): string {
  if (!Number.isFinite(value)) throw new Error('The model contains a non-finite value.');
  const normalized = Math.abs(value) < 5e-300 ? 0 : value;
  return normalized.toExponential(12);
}

function riPair(value: Complex): string {
  return `${finiteScientific(value.re)} ${finiteScientific(value.im)}`;
}

function validateCommon(input: ModelExportInput): void {
  const { result } = input;
  if (
    result.nSignals < 1 ||
    result.names.length !== result.nSignals ||
    input.conductors.length !== result.nSignals
  ) {
    throw new Error('The solved conductor order is incomplete.');
  }
  validateRealSquareMatrix(result.B, result.nSignals, 'C');
  validateRealSquareMatrix(result.L, result.nSignals, 'L');
  validateRealSquareMatrix(result.Rdc, result.nSignals, 'Rdc');
  if (result.floatingDifferential) {
    const { positiveName, negativeName } = result.floatingDifferential;
    if (
      result.nSignals !== 1 ||
      result.names[0] !== positiveName ||
      !positiveName.trim() ||
      !negativeName.trim() ||
      positiveName === negativeName
    ) {
      throw new Error('The floating differential conductor mapping is incomplete.');
    }
  }
  if (input.dielectricLoss) {
    validateRealSquareMatrix(
      input.dielectricLoss.lossCapacitancePerM,
      result.nSignals,
      'Dielectric loss-capacitance',
    );
  }
  if (!(input.lengthM > 0) || !Number.isFinite(input.lengthM)) {
    throw new Error('Line length must be greater than zero.');
  }
  if (!(input.unitScaleM > 0) || !(input.designFreqHz > 0)) {
    throw new Error('The solved model has invalid units or design frequency.');
  }
  if (
    input.lossParams.includeReferencePlaneLoss &&
    input.referencePlane
  ) {
    const model = input.referencePlane;
    const terms = model.terms?.length
      ? model.terms
      : model.geometryPerM != null &&
          model.conductivity != null &&
          model.thicknessM != null
        ? [{
            geometryPerM: model.geometryPerM,
            conductivity: model.conductivity,
            thicknessM: model.thicknessM,
          }]
        : [];
    if (terms.length === 0) {
      throw new Error('The reference-plane loss model has no material terms.');
    }
    for (const [index, term] of terms.entries()) {
      const suffix = terms.length > 1 ? ` term ${index + 1}` : '';
      validateRealSquareMatrix(
        term.geometryPerM,
        result.nSignals,
        `Reference-plane overlap${suffix}`,
      );
      if (
        !(term.conductivity > 0) ||
        !Number.isFinite(term.conductivity) ||
        !(term.thicknessM > 0) ||
        !Number.isFinite(term.thicknessM)
      ) {
        throw new Error(
          `The reference-plane material properties${suffix} are invalid.`,
        );
      }
    }
  }
}

function lossTangentAt(input: ModelExportInput, frequencyHz: number): number {
  const lookedUp = input.tanDAtHz?.(frequencyHz);
  const value = Number.isFinite(lookedUp) && lookedUp! >= 0 ? lookedUp! : input.tanD;
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/** K [F/m], including tan(delta), before multiplication by omega. */
function dielectricLossFactorMatrixAt(
  input: ModelExportInput,
  frequencyHz: number,
): number[][] {
  if (input.dielectricLoss) {
    return input.dielectricLoss.lossCapacitancePerM.map((row) => [...row]);
  }
  const tanD = lossTangentAt(input, frequencyHz);
  return input.result.B.map((row) => row.map((value) => value * tanD));
}

function dielectricConductanceMatrixAt(
  input: ModelExportInput,
  frequencyHz: number,
): number[][] {
  if (input.dielectricLoss) {
    return dielectricConductanceMatrix(input.dielectricLoss, frequencyHz);
  }
  const omega = 2 * Math.PI * frequencyHz;
  return dielectricLossFactorMatrixAt(input, frequencyHz).map((row) =>
    row.map((value) => omega * value));
}

function dielectricModeLossFactorAt(
  input: ModelExportInput,
  frequencyHz: number,
  mode: DielectricLossMode,
  fallbackCapacitance: number,
): number {
  return input.dielectricLoss
    ? dielectricModeLossCapacitance(input.dielectricLoss, mode)
    : fallbackCapacitance * lossTangentAt(input, frequencyHz);
}

function sweepFrequencies(params: LossParams): number[] {
  if (!(params.fMinHz > 0) || !(params.fMaxHz > 0)) {
    throw new Error('Touchstone frequencies must be greater than zero.');
  }
  const low = Math.min(params.fMinHz, params.fMaxHz);
  const high = Math.max(params.fMinHz, params.fMaxHz);
  if (low === high) return [low];
  const count = Math.max(2, Math.min(2001, Math.round(params.nPoints)));
  const logLow = Math.log10(low);
  const logHigh = Math.log10(high);
  return Array.from(
    { length: count },
    (_, index) => 10 ** (logLow + ((logHigh - logLow) * index) / (count - 1)),
  );
}

function conductorAreaM2(conductor: ConductorItem, unitScaleM: number): number {
  const scaleSquared = unitScaleM * unitScaleM;
  switch (conductor.kind) {
    case 'RectangleConductors':
      return conductor.width * conductor.height * scaleSquared;
    case 'TrapezoidConductors':
      return (
        ((conductor.topWidth + conductor.bottomWidth) * conductor.height) /
        2
      ) * scaleSquared;
    case 'CircleConductors':
      return Math.PI * (conductor.diameter * unitScaleM) ** 2 / 4;
  }
}

function geometricDcResistance(
  conductor: ConductorItem,
  unitScaleM: number,
): number {
  return 1 / (conductorAreaM2(conductor, unitScaleM) * conductor.conductivity);
}

function smoothSkinCoefficient(
  conductor: ConductorItem,
  unitScaleM: number,
): number {
  return (
    Math.sqrt(Math.PI * MU0 / conductor.conductivity) /
    perimeterM(conductor, unitScaleM)
  );
}

function resistanceAt(
  input: ModelExportInput,
  conductorIndex: number,
  frequencyHz: number,
): number {
  const conductor = input.conductors[conductorIndex];
  const solvedRdc = input.result.Rdc[conductorIndex]?.[conductorIndex];
  const rdc = Number.isFinite(solvedRdc) && solvedRdc >= 0
    ? solvedRdc
    : geometricDcResistance(conductor, input.unitScaleM);
  const skinCoefficient = smoothSkinCoefficient(conductor, input.unitScaleM);
  const skinDepth = skinDepthM(frequencyHz, conductor.conductivity);
  const roughnessSizeM = (
    input.lossParams.roughnessModel === 'huray'
      ? input.lossParams.hurayRadiusUm
      : input.lossParams.roughnessRqUm
  ) * 1e-6;
  const roughnessMultiplier = roughnessK(
    input.lossParams.roughnessModel,
    roughnessSizeM,
    skinDepth,
    input.lossParams.hurayRatio,
  );
  return Math.hypot(
    rdc,
    roughnessMultiplier * skinCoefficient * Math.sqrt(frequencyHz),
  );
}

function referencePlaneIsIncluded(input: ModelExportInput): boolean {
  return (
    input.lossParams.includeReferencePlaneLoss &&
    input.referencePlane != null
  );
}

function referenceResistanceMatrixAt(
  input: ModelExportInput,
  frequencyHz: number,
): number[][] {
  return referencePlaneIsIncluded(input)
    ? referencePlaneResistanceMatrix(
      input.referencePlane!,
      input.lossParams,
      frequencyHz,
    )
    : zeroMatrix(input.result.nSignals);
}

function seriesResistanceMatrixAt(
  input: ModelExportInput,
  frequencyHz: number,
): number[][] {
  const reference = referenceResistanceMatrixAt(input, frequencyHz);
  return reference.map((row, rowIndex) =>
    row.map(
      (value, columnIndex) =>
        value +
        (rowIndex === columnIndex
          ? resistanceAt(input, rowIndex, frequencyHz)
          : 0),
    ));
}

function referenceModeResistanceAt(
  input: ModelExportInput,
  frequencyHz: number,
  mode: ReferencePlaneMode,
): number {
  return referencePlaneIsIncluded(input)
    ? referencePlaneModeValue(
      referencePlaneResistanceMatrix(
        input.referencePlane!,
        input.lossParams,
        frequencyHz,
      ),
      mode,
    )
    : 0;
}

function referenceLossComment(input: ModelExportInput): string {
  if (!input.lossParams.includeReferencePlaneLoss) {
    return 'Reference-plane loss is excluded by the selected setting.';
  }
  if (!input.referencePlane) {
    return 'Reference-plane loss is unavailable for this geometry.';
  }
  const derivation = input.referencePlane.source === 'mesh'
    ? 'mesh-derived'
    : 'analytic';
  return (
    `Includes ${derivation} finite-thickness reference-plane loss and selected ` +
    'surface roughness.'
  );
}

/**
 * Equal-reference two-port S matrix for a uniform scalar RLGC line.
 * Matrix order is conventional row/column order: S[response][stimulus].
 */
export function uniformLineSParameters(
  resistanceOhmPerM: number,
  inductanceHPerM: number,
  conductanceSPerM: number,
  capacitanceFPerM: number,
  frequencyHz: number,
  lengthM: number,
  referenceOhm = DEFAULT_REFERENCE_OHM,
): Complex[][] {
  if (
    resistanceOhmPerM < 0 ||
    !(inductanceHPerM > 0) ||
    conductanceSPerM < 0 ||
    !(capacitanceFPerM > 0) ||
    !(frequencyHz > 0) ||
    !(lengthM > 0) ||
    !(referenceOhm > 0)
  ) {
    throw new Error('Uniform-line RLGC values must be positive and finite.');
  }
  const omega = 2 * Math.PI * frequencyHz;
  const seriesImpedance = complex(resistanceOhmPerM, omega * inductanceHPerM);
  const shuntAdmittance = complex(conductanceSPerM, omega * capacitanceFPerM);
  const gamma = cSqrt(cMul(seriesImpedance, shuntAdmittance));
  const characteristicImpedance = cSqrt(cDiv(seriesImpedance, shuntAdmittance));
  const electricalLength = cScale(gamma, lengthM);
  const sinh = cSinh(electricalLength);
  const a = cCosh(electricalLength);
  const b = cMul(characteristicImpedance, sinh);
  const c = cDiv(sinh, characteristicImpedance);
  const d = a;
  const denominator = cAdd(
    cAdd(a, cScale(b, 1 / referenceOhm)),
    cAdd(cScale(c, referenceOhm), d),
  );
  const determinant = cSub(cMul(a, d), cMul(b, c));
  const s11 = cDiv(
    cSub(
      cAdd(a, cScale(b, 1 / referenceOhm)),
      cAdd(cScale(c, referenceOhm), d),
    ),
    denominator,
  );
  const s21 = cDiv(complex(2), denominator);
  const s12 = cDiv(cScale(determinant, 2), denominator);
  const s22 = cDiv(
    cAdd(
      cSub(cScale(b, 1 / referenceOhm), a),
      cSub(d, cScale(c, referenceOhm)),
    ),
    denominator,
  );
  return [
    [s11, s12],
    [s21, s22],
  ];
}

function validateRealSquareMatrix(
  matrix: number[][],
  size: number,
  label: string,
): void {
  if (
    matrix.length !== size ||
    matrix.some(
      (row) =>
        row.length !== size ||
        row.some((value) => !Number.isFinite(value)),
    )
  ) {
    throw new Error(`${label} must be a complete ${size} by ${size} matrix.`);
  }
}

/**
 * Equal-reference 2N-port S matrix for a uniform multiconductor RLGC line.
 * Returned port order is conductor-major:
 * [line 1 near, line 1 far, line 2 near, line 2 far, ...].
 */
export function multiconductorLineSParameters(
  resistanceOhmPerM: number[][],
  inductanceHPerM: number[][],
  conductanceSPerM: number[][],
  capacitanceFPerM: number[][],
  frequencyHz: number,
  lengthM: number,
  referenceOhm = DEFAULT_REFERENCE_OHM,
): Complex[][] {
  const count = inductanceHPerM.length;
  if (
    count < 1 ||
    !(frequencyHz > 0) ||
    !(lengthM > 0) ||
    !(referenceOhm > 0) ||
    !Number.isFinite(frequencyHz) ||
    !Number.isFinite(lengthM) ||
    !Number.isFinite(referenceOhm)
  ) {
    throw new Error('Multiconductor RLGC dimensions and operating values must be positive.');
  }
  validateRealSquareMatrix(resistanceOhmPerM, count, 'R');
  validateRealSquareMatrix(inductanceHPerM, count, 'L');
  validateRealSquareMatrix(conductanceSPerM, count, 'G');
  validateRealSquareMatrix(capacitanceFPerM, count, 'C');
  const omega = 2 * Math.PI * frequencyHz;
  const state = zeroComplexMatrix(2 * count);
  for (let row = 0; row < count; row++) {
    for (let column = 0; column < count; column++) {
      state[row][count + column] = complex(
        -resistanceOhmPerM[row][column] * lengthM,
        -omega * inductanceHPerM[row][column] * lengthM,
      );
      state[count + row][column] = complex(
        -conductanceSPerM[row][column] * lengthM,
        -omega * capacitanceFPerM[row][column] * lengthM,
      );
    }
  }
  const chain = expComplexMatrix(state);
  const solveLeft = zeroComplexMatrix(2 * count);
  const solveRight = zeroComplexMatrix(2 * count);
  for (let row = 0; row < count; row++) {
    for (let column = 0; column < count; column++) {
      const identity = row === column ? complex(1) : complex();
      const a = chain[row][column];
      const b = chain[row][count + column];
      const c = chain[count + row][column];
      const d = chain[count + row][count + column];
      // Solve directly for outgoing near/far power waves. This avoids the
      // singular T12 inversion that occurs at integer half-wave lengths.
      solveLeft[row][column] = cAdd(cScale(a, -1), cScale(b, 1 / referenceOhm));
      solveLeft[row][count + column] = identity;
      solveLeft[count + row][column] = cAdd(cScale(c, -referenceOhm), d);
      solveLeft[count + row][count + column] = identity;
      solveRight[row][column] = cAdd(a, cScale(b, 1 / referenceOhm));
      solveRight[row][count + column] = cScale(identity, -1);
      solveRight[count + row][column] = cAdd(cScale(c, referenceOhm), d);
      solveRight[count + row][count + column] = identity;
    }
  }
  const grouped = multiplyComplexMatrices(
    invertComplexMatrix(solveLeft),
    solveRight,
  );
  const interleaved = zeroComplexMatrix(2 * count);
  const groupedIndex = (port: number) =>
    port % 2 === 0 ? port / 2 : count + (port - 1) / 2;
  for (let row = 0; row < 2 * count; row++) {
    for (let column = 0; column < 2 * count; column++) {
      interleaved[row][column] =
        grouped[groupedIndex(row)][groupedIndex(column)];
    }
  }
  return interleaved;
}

function matrixValue(matrix: number[][], row: number, column: number): number {
  const value = matrix[row]?.[column];
  if (!Number.isFinite(value)) throw new Error('The solved RLGC matrix is incomplete.');
  return value;
}

function relativeDifference(a: number, b: number): number {
  return Math.abs(a - b) / Math.max(MIN_POSITIVE, Math.abs(a), Math.abs(b));
}

export function supportsDifferentialTouchstone(result: SolveResult): boolean {
  if (result.nSignals !== 2 || result.zOdd == null || result.zEven == null) return false;
  const b00 = result.B[0]?.[0];
  const b11 = result.B[1]?.[1];
  const b01 = result.B[0]?.[1];
  const b10 = result.B[1]?.[0];
  const l00 = result.L[0]?.[0];
  const l11 = result.L[1]?.[1];
  const l01 = result.L[0]?.[1];
  const l10 = result.L[1]?.[0];
  const r00 = result.Rdc[0]?.[0];
  const r11 = result.Rdc[1]?.[1];
  const values = [b00, b11, b01, b10, l00, l11, l01, l10, r00, r11];
  if (!values.every(Number.isFinite)) return false;
  const cSelf = (b00! + b11!) / 2;
  const cMutual = (b01! + b10!) / 2;
  const lSelf = (l00! + l11!) / 2;
  const lMutual = (l01! + l10!) / 2;
  return (
    cSelf + cMutual > 0 &&
    cSelf - cMutual > 0 &&
    lSelf + lMutual > 0 &&
    lSelf - lMutual > 0 &&
    relativeDifference(b00!, b11!) <= 0.02 &&
    relativeDifference(b01!, b10!) <= 0.02 &&
    relativeDifference(l00!, l11!) <= 0.02 &&
    relativeDifference(l01!, l10!) <= 0.02 &&
    relativeDifference(r00!, r11!) <= 0.02
  );
}

function modalToPhysical(
  even: Complex[][],
  odd: Complex[][],
): Complex[][] {
  // Physical port order is IEEE/IBIS 13-24:
  // [1 IN+, 2 OUT+, 3 IN-, 4 OUT-].
  // Modal order is [even near, even far, odd near, odd far].
  const inverseSqrtTwo = 1 / Math.sqrt(2);
  const transform = [
    [inverseSqrtTwo, 0, inverseSqrtTwo, 0],
    [0, inverseSqrtTwo, 0, inverseSqrtTwo],
    [inverseSqrtTwo, 0, -inverseSqrtTwo, 0],
    [0, inverseSqrtTwo, 0, -inverseSqrtTwo],
  ];
  const modal = zeroComplexMatrix(4);
  for (let row = 0; row < 2; row++) {
    for (let column = 0; column < 2; column++) {
      modal[row][column] = even[row][column];
      modal[row + 2][column + 2] = odd[row][column];
    }
  }
  const physical = zeroComplexMatrix(4);
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 4; column++) {
      let value = complex();
      for (let modalRow = 0; modalRow < 4; modalRow++) {
        for (let modalColumn = 0; modalColumn < 4; modalColumn++) {
          value = cAdd(
            value,
            cScale(
              modal[modalRow][modalColumn],
              transform[modalRow][row] * transform[modalColumn][column],
            ),
          );
        }
      }
      physical[row][column] = value;
    }
  }
  return physical;
}

interface DifferentialModalValues {
  evenCapacitance: number;
  oddCapacitance: number;
  evenInductance: number;
  oddInductance: number;
}

function differentialModalValues(input: ModelExportInput): DifferentialModalValues {
  if (input.flow !== 'preset-diff') {
    throw new Error(
      'Differential Touchstone export is only available for the guided differential-pair flow.',
    );
  }
  if (!supportsDifferentialTouchstone(input.result)) {
    throw new Error(
      'Differential Touchstone export requires a symmetric two-signal differential pair.',
    );
  }
  const cSelf =
    (matrixValue(input.result.B, 0, 0) + matrixValue(input.result.B, 1, 1)) / 2;
  const cMutual =
    (matrixValue(input.result.B, 0, 1) + matrixValue(input.result.B, 1, 0)) / 2;
  const lSelf =
    (matrixValue(input.result.L, 0, 0) + matrixValue(input.result.L, 1, 1)) / 2;
  const lMutual =
    (matrixValue(input.result.L, 0, 1) + matrixValue(input.result.L, 1, 0)) / 2;
  return {
    evenCapacitance: cSelf + cMutual,
    oddCapacitance: cSelf - cMutual,
    evenInductance: lSelf + lMutual,
    oddInductance: lSelf - lMutual,
  };
}

export function exportTouchstoneS2p(input: ModelExportInput): ExportedModelFile {
  validateCommon(input);
  if (input.flow !== 'preset-se' || input.result.nSignals !== 1) {
    throw new Error(
      'This Touchstone .s2p export is only available for the guided single-ended flow.',
    );
  }
  const capacitance = matrixValue(input.result.B, 0, 0);
  const inductance = matrixValue(input.result.L, 0, 0);
  const lines = [
    '! Web-MMTL uniform transmission-line model',
    `! Line length = ${finiteScientific(input.lengthM)} m`,
    '! Port 1 = input / near end',
    '! Port 2 = output / far end',
    '! Includes selected conductor roughness and dielectric loss settings.',
    `! ${referenceLossComment(input)}`,
    '# Hz S RI R 50',
    '! Hz Re(S11) Im(S11) Re(S21) Im(S21) Re(S12) Im(S12) Re(S22) Im(S22)',
  ];
  for (const frequencyHz of sweepFrequencies(input.lossParams)) {
    const resistance =
      resistanceAt(input, 0, frequencyHz) +
      referenceModeResistanceAt(input, frequencyHz, 'single');
    const conductance =
      2 * Math.PI * frequencyHz *
      dielectricModeLossFactorAt(
        input,
        frequencyHz,
        'single',
        capacitance,
      );
    const s = uniformLineSParameters(
      resistance,
      inductance,
      conductance,
      capacitance,
      frequencyHz,
      input.lengthM,
    );
    // Touchstone 1.0 has a special historical two-port order.
    lines.push(
      `${finiteScientific(frequencyHz)} ${riPair(s[0][0])} ${riPair(s[1][0])} ` +
      `${riPair(s[0][1])} ${riPair(s[1][1])}`,
    );
  }
  return {
    filename: `${modelExportBasename(input.title)}.s2p`,
    mimeType: 'text/plain;charset=utf-8',
    text: `${lines.join('\n')}\n`,
  };
}

function appendTouchstoneMatrix(
  lines: string[],
  frequencyHz: number,
  matrix: Complex[][],
): void {
  const portCount = matrix.length;
  if (portCount === 2) {
    // Touchstone 1.0 retains this historical two-port order.
    lines.push(
      `${finiteScientific(frequencyHz)} ${riPair(matrix[0][0])} ` +
      `${riPair(matrix[1][0])} ${riPair(matrix[0][1])} ${riPair(matrix[1][1])}`,
    );
    return;
  }
  // Touchstone 1.0 N-port matrices are row-major. Start every matrix row on
  // a new physical line and wrap after four complex pairs for compatibility.
  for (let row = 0; row < portCount; row++) {
    for (let firstColumn = 0; firstColumn < portCount; firstColumn += 4) {
      const prefix =
        row === 0 && firstColumn === 0
          ? `${finiteScientific(frequencyHz)} `
          : '';
      lines.push(
        `${prefix}${matrix[row]
          .slice(firstColumn, firstColumn + 4)
          .map(riPair)
          .join(' ')}`,
      );
    }
  }
}

export function exportTouchstoneNPort(
  input: ModelExportInput,
): ExportedModelFile {
  validateCommon(input);
  if (input.flow !== 'arbitrary') {
    throw new Error(
      'Generic 2N-port Touchstone export is only available for arbitrary stackups.',
    );
  }
  const count = input.result.nSignals;
  const portCount = 2 * count;
  const floating = input.result.floatingDifferential;
  const referenceOhm = floating ? 100 : DEFAULT_REFERENCE_OHM;
  const lines = floating
    ? [
        '! Web-MMTL floating differential-pair transmission-line model',
        `! Line length = ${finiteScientific(input.lengthM)} m`,
        `! Port 1 = differential input: ${floating.positiveName}_IN relative to ${floating.negativeName}_IN`,
        `! Port 2 = differential output: ${floating.positiveName}_OUT relative to ${floating.negativeName}_OUT`,
        '! Contains the solved differential mode only; common-mode behavior is not available.',
        '! Includes selected conductor roughness and dielectric loss settings.',
        `! ${referenceLossComment(input)}`,
        '# Hz S RI R 100',
        '! Hz Re(SDD11) Im(SDD11) Re(SDD21) Im(SDD21) Re(SDD12) Im(SDD12) Re(SDD22) Im(SDD22)',
      ]
    : [
        `! Web-MMTL uniform ${count}-conductor transmission-line model`,
        `! Line length = ${finiteScientific(input.lengthM)} m`,
        '! Port order is conductor-major: each signal near end, then far end.',
        ...input.result.names.flatMap((name, index) => [
          `! Port ${2 * index + 1} = ${name}_IN (near end)`,
          `! Port ${2 * index + 2} = ${name}_OUT (far end)`,
        ]),
        '! Includes selected conductor roughness and dielectric loss settings.',
        `! ${referenceLossComment(input)}`,
        '# Hz S RI R 50',
        `! Full ${portCount}x${portCount} matrix; rows are response ports and columns are stimulus ports.`,
      ];
  for (const frequencyHz of sweepFrequencies(input.lossParams)) {
    const resistance = seriesResistanceMatrixAt(input, frequencyHz);
    const conductance = dielectricConductanceMatrixAt(input, frequencyHz);
    appendTouchstoneMatrix(
      lines,
      frequencyHz,
      multiconductorLineSParameters(
        resistance,
        input.result.L,
        conductance,
        input.result.B,
        frequencyHz,
        input.lengthM,
        referenceOhm,
      ),
    );
  }
  return {
    filename: `${modelExportBasename(input.title)}.s${portCount}p`,
    mimeType: 'text/plain;charset=utf-8',
    text: `${lines.join('\n')}\n`,
  };
}

export function exportTouchstoneS4p(input: ModelExportInput): ExportedModelFile {
  validateCommon(input);
  const {
    evenCapacitance,
    oddCapacitance,
    evenInductance,
    oddInductance,
  } = differentialModalValues(input);
  const lines = [
    '! Web-MMTL uniform differential-pair model',
    `! Line length = ${finiteScientific(input.lengthM)} m`,
    '! IEEE/IBIS 13-24 port order:',
    '! Port 1 = IN+, Port 2 = OUT+, Port 3 = IN-, Port 4 = OUT-',
    '! Differential input pair = (1,3); differential output pair = (2,4).',
    '! Includes selected conductor roughness and dielectric loss settings.',
    `! ${referenceLossComment(input)}`,
    '# Hz S RI R 50',
    '! Full 4x4 matrix; rows are response ports and columns are stimulus ports.',
  ];
  for (const frequencyHz of sweepFrequencies(input.lossParams)) {
    const signalResistance =
      (resistanceAt(input, 0, frequencyHz) + resistanceAt(input, 1, frequencyHz)) /
      2;
    const evenResistance =
      signalResistance +
      referenceModeResistanceAt(input, frequencyHz, 'even');
    const oddResistance =
      signalResistance +
      referenceModeResistanceAt(input, frequencyHz, 'odd');
    const evenLossFactor = dielectricModeLossFactorAt(
      input,
      frequencyHz,
      'even',
      evenCapacitance,
    );
    const oddLossFactor = dielectricModeLossFactorAt(
      input,
      frequencyHz,
      'odd',
      oddCapacitance,
    );
    const even = uniformLineSParameters(
      evenResistance,
      evenInductance,
      2 * Math.PI * frequencyHz * evenLossFactor,
      evenCapacitance,
      frequencyHz,
      input.lengthM,
    );
    const odd = uniformLineSParameters(
      oddResistance,
      oddInductance,
      2 * Math.PI * frequencyHz * oddLossFactor,
      oddCapacitance,
      frequencyHz,
      input.lengthM,
    );
    const physical = modalToPhysical(even, odd);
    for (let row = 0; row < 4; row++) {
      const prefix = row === 0 ? `${finiteScientific(frequencyHz)} ` : '';
      lines.push(`${prefix}${physical[row].map(riPair).join(' ')}`);
    }
  }
  return {
    filename: `${modelExportBasename(input.title)}.s4p`,
    mimeType: 'text/plain;charset=utf-8',
    text: `${lines.join('\n')}\n`,
  };
}

export function exportTouchstoneDifferentialS2p(
  input: ModelExportInput,
): ExportedModelFile {
  validateCommon(input);
  const { oddCapacitance, oddInductance } = differentialModalValues(input);
  const lines = [
    '! Web-MMTL differential-only mixed-mode transmission-line model',
    `! Line length = ${finiteScientific(input.lengthM)} m`,
    '! Logical port 1 = differential input / near pair (S4P ports 1,3)',
    '! Logical port 2 = differential output / far pair (S4P ports 2,4)',
    '! Contains SDD only; common-mode and mode-conversion terms are omitted.',
    '! The 100 ohm reference is the natural differential reference for 50 ohm single-ended ports.',
    '! Includes selected conductor roughness and dielectric loss settings.',
    `! ${referenceLossComment(input)}`,
    '# Hz S RI R 100',
    '! Hz Re(SDD11) Im(SDD11) Re(SDD21) Im(SDD21) Re(SDD12) Im(SDD12) Re(SDD22) Im(SDD22)',
  ];
  for (const frequencyHz of sweepFrequencies(input.lossParams)) {
    const perLineResistance =
      (resistanceAt(input, 0, frequencyHz) + resistanceAt(input, 1, frequencyHz)) /
      2 +
      referenceModeResistanceAt(input, frequencyHz, 'odd');
    // In physical differential variables, Vdiff = V+ - V- and
    // Idiff = (I+ - I-)/2. This doubles odd-mode series Z and halves
    // odd-mode shunt Y, giving Zref,diff = 2 * 50 ohms.
    const differentialCapacitance = oddCapacitance / 2;
    const differentialLossFactor = dielectricModeLossFactorAt(
      input,
      frequencyHz,
      'odd',
      oddCapacitance,
    ) / 2;
    const sdd = uniformLineSParameters(
      2 * perLineResistance,
      2 * oddInductance,
      2 * Math.PI * frequencyHz * differentialLossFactor,
      differentialCapacitance,
      frequencyHz,
      input.lengthM,
      100,
    );
    lines.push(
      `${finiteScientific(frequencyHz)} ${riPair(sdd[0][0])} ${riPair(sdd[1][0])} ` +
      `${riPair(sdd[0][1])} ${riPair(sdd[1][1])}`,
    );
  }
  return {
    filename: `${modelExportBasename(input.title)}-sdd.s2p`,
    mimeType: 'text/plain;charset=utf-8',
    text: `${lines.join('\n')}\n`,
  };
}

function zeroMatrix(size: number): number[][] {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => 0));
}

function diagonalMatrix(values: number[]): number[][] {
  const matrix = zeroMatrix(values.length);
  values.forEach((value, index) => {
    matrix[index][index] = value;
  });
  return matrix;
}

function addRealMatrices(a: number[][], b: number[][]): number[][] {
  return a.map((row, rowIndex) =>
    row.map((value, columnIndex) => value + b[rowIndex][columnIndex]));
}

function lowerTriangle(matrix: number[][]): string[] {
  return matrix.map((row, rowIndex) =>
    row
      .slice(0, rowIndex + 1)
      .map(finiteScientific)
      .join(' '));
}

function addWMatrix(
  lines: string[],
  label: string,
  units: string,
  matrix: number[][],
): void {
  lines.push('', `* ${label} (${units})`, ...lowerTriangle(matrix));
}

interface ModelPortPair {
  near: string;
  far: string;
}

interface FloatingDifferentialPortPairs {
  positive: ModelPortPair;
  negative: ModelPortPair;
}

function safeSpiceNodeName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[a-zA-Z]/.test(cleaned) ? cleaned : `N_${cleaned || 'SIGNAL'}`;
}

function floatingDifferentialPortPairs(
  input: ModelExportInput,
): FloatingDifferentialPortPairs | null {
  const floating = input.result.floatingDifferential;
  if (!floating || input.result.nSignals !== 1) return null;
  const positive = safeSpiceNodeName(floating.positiveName);
  let negative = safeSpiceNodeName(floating.negativeName);
  if (positive.toUpperCase() === negative.toUpperCase()) {
    negative = `${negative}_NEG`;
  }
  return {
    positive: { near: `${positive}_IN`, far: `${positive}_OUT` },
    negative: { near: `${negative}_IN`, far: `${negative}_OUT` },
  };
}

function modelPortPairs(input: ModelExportInput): ModelPortPair[] {
  if (input.flow === 'preset-se' && input.result.nSignals === 1) {
    return [{ near: 'IN', far: 'OUT' }];
  }
  if (input.flow === 'preset-diff' && input.result.nSignals === 2) {
    return [
      { near: 'IN_P', far: 'OUT_P' },
      { near: 'IN_N', far: 'OUT_N' },
    ];
  }
  return input.result.names.map((name) => {
    const safe = safeSpiceNodeName(name);
    return { near: `${safe}_IN`, far: `${safe}_OUT` };
  });
}

export function exportHspiceWElement(input: ModelExportInput): ExportedModelFile {
  validateCommon(input);
  const count = input.result.nSignals;
  const ports = modelPortPairs(input);
  const floatingPorts = floatingDifferentialPortPairs(input);
  const signalR0 = diagonalMatrix(
    input.conductors.map((conductor) =>
      geometricDcResistance(conductor, input.unitScaleM)),
  );
  const signalRs = diagonalMatrix(
    input.conductors.map((conductor) =>
      smoothSkinCoefficient(conductor, input.unitScaleM)),
  );
  const referenceR0 = referencePlaneIsIncluded(input)
    ? referencePlaneDcResistanceMatrix(input.referencePlane!)
    : zeroMatrix(count);
  const referenceRs = referencePlaneIsIncluded(input)
    ? referencePlaneSkinCoefficientMatrix(input.referencePlane!)
    : zeroMatrix(count);
  const r0 = addRealMatrices(signalR0, referenceR0);
  const rs = addRealMatrices(signalRs, referenceRs);
  const g0 = zeroMatrix(count);
  const gd = dielectricLossFactorMatrixAt(input, input.designFreqHz).map(
    (row) => row.map((value) => 2 * Math.PI * value),
  );
  const filename = `${modelExportBasename(input.title)}.wlc`;
  const usage = floatingPorts
    ? `* Usage: W1 ${floatingPorts.positive.near} ${floatingPorts.negative.near} ` +
      `${floatingPorts.positive.far} ${floatingPorts.negative.far} ` +
      `N=1 L=<meters> RLGCfile=${filename}`
    : `* Usage: W1 ${ports.map(({ near }) => near).join(' ')} 0 ` +
      `${ports.map(({ far }) => far).join(' ')} 0 N=${count} L=<meters> RLGCfile=${filename}`;
  const lines = [
    '* Web-MMTL HSPICE W-element analytical RLGC data',
    ...(floatingPorts && input.result.floatingDifferential
      ? [
          `* Differential loop: ${input.result.floatingDifferential.positiveName} (+), ` +
            `${input.result.floatingDifferential.negativeName} (-)`,
          `* Positive terminals: near=${floatingPorts.positive.near}, far=${floatingPorts.positive.far}`,
          `* Negative/reference terminals: near=${floatingPorts.negative.near}, far=${floatingPorts.negative.far}`,
          '* N=1 contains the solved differential mode only; common mode is not available.',
        ]
      : [
          `* Signal order: ${input.result.names.join(', ')}`,
          ...input.result.names.map(
            (name, index) =>
              `* ${name}: near=${ports[index].near}, far=${ports[index].far}`,
          ),
        ]),
    '* Positional external-file order: N, L0, C0, R0, G0, Rs, Gd.',
    '* Signal R0 and smooth-conductor Rs are derived from conductor geometry.',
    referencePlaneIsIncluded(input)
      ? `* R0 and Rs include the ${
        input.referencePlane!.source === 'mesh' ? 'mesh-derived' : 'analytic'
      } reference-plane DC and high-frequency smooth asymptotes.`
      : `* ${referenceLossComment(input)}`,
    input.dielectricLoss
      ? '* Gd = 2*pi*K from the solved heterogeneous dielectric participation matrix.'
      : '* Gd = 2*pi*C0*tan(delta), frozen at the design-frequency material value.',
    '* Selected Hammerstad/Huray roughness and the finite-thickness crossover are not',
    '* representable by one classic Rs coefficient;',
    '* use the Touchstone export when that frequency-dependent correction must be retained.',
    usage,
    '',
    '* N (number of signal conductors)',
    String(count),
  ];
  addWMatrix(lines, 'L0', 'H/m', input.result.L);
  addWMatrix(lines, 'C0', 'F/m', input.result.B);
  addWMatrix(lines, 'R0', 'ohm/m', r0);
  addWMatrix(lines, 'G0', 'S/m', g0);
  addWMatrix(lines, 'Rs', 'ohm/(m*sqrt(Hz))', rs);
  addWMatrix(lines, 'Gd', 'S/(m*Hz)', gd);
  return {
    filename,
    mimeType: 'text/plain;charset=utf-8',
    text: `${lines.join('\n')}\n`,
  };
}

function positiveResistanceForConductance(conductanceS: number): number | null {
  return conductanceS > 0 ? 1 / conductanceS : null;
}

function appendSingleEndedLadder(
  lines: string[],
  input: ModelExportInput,
  subcktName: string,
  sections: number,
): void {
  const sectionLength = input.lengthM / sections;
  const resistance =
    (
      resistanceAt(input, 0, input.designFreqHz) +
      referenceModeResistanceAt(input, input.designFreqHz, 'single')
    ) * sectionLength / 2;
  const inductance =
    matrixValue(input.result.L, 0, 0) * sectionLength / 2;
  const capacitance =
    matrixValue(input.result.B, 0, 0) * sectionLength;
  const conductance =
    2 * Math.PI * input.designFreqHz * sectionLength *
    dielectricModeLossFactorAt(
      input,
      input.designFreqHz,
      'single',
      matrixValue(input.result.B, 0, 0),
    );
  const shuntResistance = positiveResistanceForConductance(conductance);
  lines.push(`.SUBCKT ${subcktName} IN OUT REF`);
  for (let section = 1; section <= sections; section++) {
    const left = section === 1 ? 'IN' : `N${section - 1}`;
    const right = section === sections ? 'OUT' : `N${section}`;
    const a = `S${section}A`;
    const middle = `S${section}M`;
    const b = `S${section}B`;
    lines.push(
      `R${section}A ${left} ${a} ${finiteScientific(resistance)}`,
      `L${section}A ${a} ${middle} ${finiteScientific(inductance)}`,
      `C${section} ${middle} REF ${finiteScientific(capacitance)}`,
    );
    if (shuntResistance != null) {
      lines.push(`RG${section} ${middle} REF ${finiteScientific(shuntResistance)}`);
    }
    lines.push(
      `L${section}B ${middle} ${b} ${finiteScientific(inductance)}`,
      `R${section}B ${b} ${right} ${finiteScientific(resistance)}`,
    );
  }
  lines.push(`.ENDS ${subcktName}`);
}

function appendDifferentialLadder(
  lines: string[],
  input: ModelExportInput,
  subcktName: string,
  sections: number,
): void {
  const sectionLength = input.lengthM / sections;
  const halfSection = sectionLength / 2;
  const lP = matrixValue(input.result.L, 0, 0) * halfSection;
  const lN = matrixValue(input.result.L, 1, 1) * halfSection;
  const mutualL =
    ((matrixValue(input.result.L, 0, 1) + matrixValue(input.result.L, 1, 0)) / 2) *
    halfSection;
  const coupling = Math.max(
    -0.999999,
    Math.min(0.999999, mutualL / Math.sqrt(lP * lN)),
  );
  const oddReferenceResistance =
    referenceModeResistanceAt(input, input.designFreqHz, 'odd');
  const rP =
    (resistanceAt(input, 0, input.designFreqHz) + oddReferenceResistance) *
    halfSection;
  const rN =
    (resistanceAt(input, 1, input.designFreqHz) + oddReferenceResistance) *
    halfSection;
  const b00 = matrixValue(input.result.B, 0, 0);
  const b11 = matrixValue(input.result.B, 1, 1);
  const b01 = matrixValue(input.result.B, 0, 1);
  const b10 = matrixValue(input.result.B, 1, 0);
  const cGroundP = Math.max(0, (b00 + b01) * sectionLength);
  const cGroundN = Math.max(0, (b11 + b10) * sectionLength);
  const cMutual = Math.max(0, (-(b01 + b10) / 2) * sectionLength);
  const lossFactor = dielectricLossFactorMatrixAt(
    input,
    input.designFreqHz,
  );
  const lossScale = Math.max(
    MIN_POSITIVE,
    ...lossFactor.flat().map((value) => Math.abs(value)),
  );
  const lossTolerance = lossScale * sectionLength * 1e-8;
  const passiveLossBranch = (value: number, label: string) => {
    if (value < -lossTolerance) {
      throw new Error(
        `The dielectric participation matrix gives a negative ${label}; ` +
        'the generic passive-resistor ladder cannot represent it.',
      );
    }
    return Math.max(0, value);
  };
  const kGroundP = passiveLossBranch(
    (matrixValue(lossFactor, 0, 0) + matrixValue(lossFactor, 0, 1)) *
      sectionLength,
    'positive-line reference-loss branch',
  );
  const kGroundN = passiveLossBranch(
    (matrixValue(lossFactor, 1, 1) + matrixValue(lossFactor, 1, 0)) *
      sectionLength,
    'negative-line reference-loss branch',
  );
  const kMutual = passiveLossBranch(
    (-(matrixValue(lossFactor, 0, 1) + matrixValue(lossFactor, 1, 0)) / 2) *
      sectionLength,
    'line-to-line loss branch',
  );
  const omega = 2 * Math.PI * input.designFreqHz;
  const rgP = positiveResistanceForConductance(kGroundP * omega);
  const rgN = positiveResistanceForConductance(kGroundN * omega);
  const rgMutual = positiveResistanceForConductance(kMutual * omega);
  lines.push(`.SUBCKT ${subcktName} IN_P IN_N OUT_P OUT_N REF`);
  for (let section = 1; section <= sections; section++) {
    const leftP = section === 1 ? 'IN_P' : `P${section - 1}`;
    const leftN = section === 1 ? 'IN_N' : `N${section - 1}`;
    const rightP = section === sections ? 'OUT_P' : `P${section}`;
    const rightN = section === sections ? 'OUT_N' : `N${section}`;
    const pA = `S${section}PA`;
    const nA = `S${section}NA`;
    const pM = `S${section}PM`;
    const nM = `S${section}NM`;
    const pB = `S${section}PB`;
    const nB = `S${section}NB`;
    lines.push(
      `R${section}PA ${leftP} ${pA} ${finiteScientific(rP)}`,
      `R${section}NA ${leftN} ${nA} ${finiteScientific(rN)}`,
      `L${section}PA ${pA} ${pM} ${finiteScientific(lP)}`,
      `L${section}NA ${nA} ${nM} ${finiteScientific(lN)}`,
      `K${section}A L${section}PA L${section}NA ${finiteScientific(coupling)}`,
    );
    if (cGroundP > 0) {
      lines.push(`C${section}PG ${pM} REF ${finiteScientific(cGroundP)}`);
    }
    if (cGroundN > 0) {
      lines.push(`C${section}NG ${nM} REF ${finiteScientific(cGroundN)}`);
    }
    if (cMutual > 0) {
      lines.push(`C${section}PN ${pM} ${nM} ${finiteScientific(cMutual)}`);
    }
    if (rgP != null) lines.push(`RG${section}P ${pM} REF ${finiteScientific(rgP)}`);
    if (rgN != null) lines.push(`RG${section}N ${nM} REF ${finiteScientific(rgN)}`);
    if (rgMutual != null) {
      lines.push(`RG${section}PN ${pM} ${nM} ${finiteScientific(rgMutual)}`);
    }
    lines.push(
      `L${section}PB ${pM} ${pB} ${finiteScientific(lP)}`,
      `L${section}NB ${nM} ${nB} ${finiteScientific(lN)}`,
      `K${section}B L${section}PB L${section}NB ${finiteScientific(coupling)}`,
      `R${section}PB ${pB} ${rightP} ${finiteScientific(rP)}`,
      `R${section}NB ${nB} ${rightN} ${finiteScientific(rN)}`,
    );
  }
  lines.push(`.ENDS ${subcktName}`);
}

function appendFloatingDifferentialLadder(
  lines: string[],
  input: ModelExportInput,
  subcktName: string,
  sections: number,
): void {
  const ports = floatingDifferentialPortPairs(input);
  if (!ports) {
    throw new Error('The floating differential conductor mapping is incomplete.');
  }
  const sectionLength = input.lengthM / sections;
  // The solve publishes one loop voltage/current mode. Split each symmetric-T
  // series half equally between the physical positive and negative paths so
  // the differential loop retains exactly the solved scalar R and L.
  const branchResistance = (
    resistanceAt(input, 0, input.designFreqHz) +
    referenceModeResistanceAt(input, input.designFreqHz, 'single')
  ) * sectionLength / 4;
  const branchInductance =
    matrixValue(input.result.L, 0, 0) * sectionLength / 4;
  const capacitance =
    matrixValue(input.result.B, 0, 0) * sectionLength;
  const lossFactor = dielectricModeLossFactorAt(
    input,
    input.designFreqHz,
    'single',
    matrixValue(input.result.B, 0, 0),
  ) * sectionLength;
  const shuntResistance = positiveResistanceForConductance(
    2 * Math.PI * input.designFreqHz * lossFactor,
  );
  lines.push(
    `.SUBCKT ${subcktName} ${ports.positive.near} ${ports.negative.near} ` +
      `${ports.positive.far} ${ports.negative.far}`,
    `* Differential input: ${ports.positive.near} relative to ${ports.negative.near}`,
    `* Differential output: ${ports.positive.far} relative to ${ports.negative.far}`,
    '* This balanced equivalent represents only the solved differential mode; common mode is not available.',
  );
  for (let section = 1; section <= sections; section++) {
    const leftP = section === 1 ? ports.positive.near : `P${section - 1}`;
    const leftN = section === 1 ? ports.negative.near : `N${section - 1}`;
    const rightP = section === sections ? ports.positive.far : `P${section}`;
    const rightN = section === sections ? ports.negative.far : `N${section}`;
    const pA = `S${section}PA`;
    const nA = `S${section}NA`;
    const pM = `S${section}PM`;
    const nM = `S${section}NM`;
    const pB = `S${section}PB`;
    const nB = `S${section}NB`;
    lines.push(
      `R${section}PA ${leftP} ${pA} ${finiteScientific(branchResistance)}`,
      `R${section}NA ${leftN} ${nA} ${finiteScientific(branchResistance)}`,
      `L${section}PA ${pA} ${pM} ${finiteScientific(branchInductance)}`,
      `L${section}NA ${nA} ${nM} ${finiteScientific(branchInductance)}`,
      `C${section}PN ${pM} ${nM} ${finiteScientific(capacitance)}`,
    );
    if (shuntResistance != null) {
      lines.push(
        `RG${section}PN ${pM} ${nM} ${finiteScientific(shuntResistance)}`,
      );
    }
    lines.push(
      `L${section}PB ${pM} ${pB} ${finiteScientific(branchInductance)}`,
      `L${section}NB ${nM} ${nB} ${finiteScientific(branchInductance)}`,
      `R${section}PB ${pB} ${rightP} ${finiteScientific(branchResistance)}`,
      `R${section}NB ${nB} ${rightN} ${finiteScientific(branchResistance)}`,
    );
  }
  lines.push(`.ENDS ${subcktName}`);
}

function symmetricRealMatrix(matrix: number[][]): number[][] {
  return matrix.map((row, rowIndex) =>
    row.map(
      (_, columnIndex) =>
        (matrixValue(matrix, rowIndex, columnIndex) +
          matrixValue(matrix, columnIndex, rowIndex)) /
        2,
    ));
}

function assertPositiveDefinite(matrix: number[][], label: string): void {
  const size = matrix.length;
  const lower = zeroMatrix(size);
  const scale = Math.max(
    MIN_POSITIVE,
    ...matrix.map((row) => Math.max(...row.map((value) => Math.abs(value)))),
  );
  const tolerance = scale * 1e-12;
  for (let row = 0; row < size; row++) {
    for (let column = 0; column <= row; column++) {
      let value = matrix[row][column];
      for (let inner = 0; inner < column; inner++) {
        value -= lower[row][inner] * lower[column][inner];
      }
      if (row === column) {
        if (!(value > tolerance)) {
          throw new Error(`${label} must be positive definite.`);
        }
        lower[row][column] = Math.sqrt(value);
      } else {
        lower[row][column] = value / lower[column][column];
      }
    }
  }
}

function appendSpiceLogicalLine(
  lines: string[],
  prefix: string,
  tokens: string[],
): void {
  let line = prefix;
  for (const token of tokens) {
    if (line.length + token.length + 1 > 100) {
      lines.push(line);
      line = `+ ${token}`;
    } else {
      line += ` ${token}`;
    }
  }
  lines.push(line);
}

function appendMulticonductorLadder(
  lines: string[],
  input: ModelExportInput,
  subcktName: string,
  sections: number,
): void {
  const count = input.result.nSignals;
  const ports = modelPortPairs(input);
  const pinOrder = ports.flatMap(({ near, far }) => [near, far]);
  const inductanceMatrix = symmetricRealMatrix(input.result.L);
  const capacitanceMatrix = symmetricRealMatrix(input.result.B);
  assertPositiveDefinite(inductanceMatrix, 'The solved inductance matrix');
  assertPositiveDefinite(capacitanceMatrix, 'The solved capacitance matrix');
  const sectionLength = input.lengthM / sections;
  const halfSection = sectionLength / 2;
  const selfInductance = inductanceMatrix.map(
    (row, index) => row[index] * halfSection,
  );
  const halfResistance = input.conductors.map(
    (_, index) =>
      resistanceAt(input, index, input.designFreqHz) * halfSection,
  );
  const matrixScale = Math.max(
    MIN_POSITIVE,
    ...capacitanceMatrix.map((row) =>
      Math.max(...row.map((value) => Math.abs(value)))),
  );
  const capacitanceTolerance = matrixScale * sectionLength * 1e-10;
  const groundCapacitance = capacitanceMatrix.map((row, rowIndex) => {
    const value =
      row.reduce((sum, entry) => sum + entry, 0) * sectionLength;
    if (value < -capacitanceTolerance) {
      throw new Error(
        `Signal ${input.result.names[rowIndex]} has a negative reference capacitance.`,
      );
    }
    return Math.max(0, value);
  });
  const mutualCapacitance = new Map<string, number>();
  for (let left = 0; left < count; left++) {
    for (let right = left + 1; right < count; right++) {
      const value = -capacitanceMatrix[left][right] * sectionLength;
      if (value < -capacitanceTolerance) {
        throw new Error(
          `Signals ${input.result.names[left]} and ${input.result.names[right]} ` +
            'have a positive off-diagonal Maxwell capacitance.',
        );
      }
      mutualCapacitance.set(`${left}:${right}`, Math.max(0, value));
    }
  }
  const lossFactorMatrix = symmetricRealMatrix(
    dielectricLossFactorMatrixAt(input, input.designFreqHz),
  );
  const lossMatrixScale = Math.max(
    MIN_POSITIVE,
    ...lossFactorMatrix.flat().map((value) => Math.abs(value)),
  );
  const lossBranchTolerance = lossMatrixScale * sectionLength * 1e-8;
  const passiveLossBranch = (value: number, label: string) => {
    if (value < -lossBranchTolerance) {
      throw new Error(
        `The dielectric participation matrix gives a negative ${label}; ` +
        'the generic passive-resistor ladder cannot represent it.',
      );
    }
    return Math.max(0, value);
  };
  const groundLossFactor = lossFactorMatrix.map((row, rowIndex) =>
    passiveLossBranch(
      row.reduce((sum, entry) => sum + entry, 0) * sectionLength,
      `${input.result.names[rowIndex]} reference-loss branch`,
    ));
  const mutualLossFactor = new Map<string, number>();
  for (let left = 0; left < count; left++) {
    for (let right = left + 1; right < count; right++) {
      mutualLossFactor.set(
        `${left}:${right}`,
        passiveLossBranch(
          -lossFactorMatrix[left][right] * sectionLength,
          `${input.result.names[left]}-${input.result.names[right]} loss branch`,
        ),
      );
    }
  }
  const dielectricOmega = 2 * Math.PI * input.designFreqHz;
  appendSpiceLogicalLine(lines, `.SUBCKT ${subcktName}`, [...pinOrder, 'REF']);
  lines.push(
    `* Port order: ${ports
      .map(({ near, far }, index) =>
        `${2 * index + 1}=${near}, ${2 * index + 2}=${far}`)
      .join('; ')}`,
  );
  for (let section = 1; section <= sections; section++) {
    const leftNodes = ports.map(({ near }, index) =>
      section === 1 ? near : `C${index + 1}N${section - 1}`);
    const rightNodes = ports.map(({ far }, index) =>
      section === sections ? far : `C${index + 1}N${section}`);
    const aNodes = ports.map((_, index) => `S${section}C${index + 1}A`);
    const middleNodes = ports.map((_, index) => `S${section}C${index + 1}M`);
    const bNodes = ports.map((_, index) => `S${section}C${index + 1}B`);
    const inductorA = ports.map((_, index) => `L${section}C${index + 1}A`);
    const inductorB = ports.map((_, index) => `L${section}C${index + 1}B`);
    for (let conductorIndex = 0; conductorIndex < count; conductorIndex++) {
      lines.push(
        `R${section}C${conductorIndex + 1}A ${leftNodes[conductorIndex]} ` +
          `${aNodes[conductorIndex]} ${finiteScientific(halfResistance[conductorIndex])}`,
        `${inductorA[conductorIndex]} ${aNodes[conductorIndex]} ` +
          `${middleNodes[conductorIndex]} ${finiteScientific(selfInductance[conductorIndex])}`,
      );
    }
    for (let left = 0; left < count; left++) {
      for (let right = left + 1; right < count; right++) {
        const coupling =
          (inductanceMatrix[left][right] * halfSection) /
          Math.sqrt(selfInductance[left] * selfInductance[right]);
        if (Math.abs(coupling) >= 1) {
          throw new Error(
            `Signals ${input.result.names[left]} and ${input.result.names[right]} ` +
              'have a non-physical inductive coupling coefficient.',
          );
        }
        if (Math.abs(coupling) > 1e-15) {
          lines.push(
            `K${section}C${left + 1}C${right + 1}A ` +
              `${inductorA[left]} ${inductorA[right]} ${finiteScientific(coupling)}`,
          );
        }
      }
    }
    for (let conductorIndex = 0; conductorIndex < count; conductorIndex++) {
      const capacitance = groundCapacitance[conductorIndex];
      if (capacitance > 0) {
        lines.push(
          `C${section}C${conductorIndex + 1}G ${middleNodes[conductorIndex]} ` +
            `REF ${finiteScientific(capacitance)}`,
        );
        const resistance = positiveResistanceForConductance(
          groundLossFactor[conductorIndex] * dielectricOmega,
        );
        if (resistance != null) {
          lines.push(
            `RG${section}C${conductorIndex + 1}G ${middleNodes[conductorIndex]} ` +
              `REF ${finiteScientific(resistance)}`,
          );
        }
      }
    }
    for (let left = 0; left < count; left++) {
      for (let right = left + 1; right < count; right++) {
        const capacitance = mutualCapacitance.get(`${left}:${right}`) ?? 0;
        if (capacitance > 0) {
          lines.push(
            `C${section}C${left + 1}C${right + 1} ${middleNodes[left]} ` +
              `${middleNodes[right]} ${finiteScientific(capacitance)}`,
          );
          const resistance = positiveResistanceForConductance(
            (mutualLossFactor.get(`${left}:${right}`) ?? 0) *
              dielectricOmega,
          );
          if (resistance != null) {
            lines.push(
              `RG${section}C${left + 1}C${right + 1} ${middleNodes[left]} ` +
                `${middleNodes[right]} ${finiteScientific(resistance)}`,
            );
          }
        }
      }
    }
    for (let conductorIndex = 0; conductorIndex < count; conductorIndex++) {
      lines.push(
        `${inductorB[conductorIndex]} ${middleNodes[conductorIndex]} ` +
          `${bNodes[conductorIndex]} ${finiteScientific(selfInductance[conductorIndex])}`,
        `R${section}C${conductorIndex + 1}B ${bNodes[conductorIndex]} ` +
          `${rightNodes[conductorIndex]} ${finiteScientific(halfResistance[conductorIndex])}`,
      );
    }
    for (let left = 0; left < count; left++) {
      for (let right = left + 1; right < count; right++) {
        const coupling =
          (inductanceMatrix[left][right] * halfSection) /
          Math.sqrt(selfInductance[left] * selfInductance[right]);
        if (Math.abs(coupling) > 1e-15) {
          lines.push(
            `K${section}C${left + 1}C${right + 1}B ` +
              `${inductorB[left]} ${inductorB[right]} ${finiteScientific(coupling)}`,
          );
        }
      }
    }
  }
  lines.push(`.ENDS ${subcktName}`);
}

export function exportGenericSpiceSubcircuit(
  input: ModelExportInput,
  requestedSections: number,
): ExportedModelFile {
  validateCommon(input);
  const sections = Math.max(1, Math.round(requestedSections));
  if (!Number.isSafeInteger(sections) || sections > 100_000) {
    throw new Error('The SPICE ladder section count is too large to export safely.');
  }
  const subcktName = safeSubcktName(input.title);
  const referenceComment = !input.lossParams.includeReferencePlaneLoss
    ? '* Reference-plane loss is excluded by the selected setting.'
    : !input.referencePlane
      ? '* Reference-plane loss is unavailable for this geometry.'
      : input.result.floatingDifferential
        ? `* ${
          input.referencePlane.source === 'mesh' ? 'Mesh-derived' : 'Analytic'
        } physical return-conductor loss is included in the differential-loop series resistance.`
        : input.flow === 'preset-se'
        ? `* ${
          input.referencePlane.source === 'mesh' ? 'Mesh-derived' : 'Analytic'
        } reference-plane loss is included in the design-frequency series resistance.`
        : input.flow === 'preset-diff'
          ? `* ${
            input.referencePlane.source === 'mesh' ? 'Mesh-derived' : 'Analytic'
          } reference-plane loss is fitted to the differential odd mode at the design frequency.`
          : `* ${
            input.referencePlane.source === 'mesh' ? 'Mesh-derived' : 'Analytic'
          } reference-plane mutual resistance is not representable by this basic-element topology.`;
  const lines = [
    '* Web-MMTL generic basic-element SPICE transmission-line ladder',
    `* ${sections} symmetric T sections over ${finiteScientific(input.lengthM)} m`,
    `* R and dielectric G are evaluated at ${finiteScientific(input.designFreqHz)} Hz.`,
    '* Selected roughness is included in the design-frequency series resistance.',
    referenceComment,
    '* Uses only R, L, C, K, .SUBCKT, and .ENDS for broad SPICE compatibility.',
    input.result.floatingDifferential
      ? `* Differential loop: ${input.result.floatingDifferential.positiveName} (+), ` +
        `${input.result.floatingDifferential.negativeName} (-)`
      : `* Signal order: ${input.result.names.join(', ')}`,
    '',
  ];
  if (input.result.floatingDifferential) {
    appendFloatingDifferentialLadder(lines, input, subcktName, sections);
  } else if (input.flow === 'preset-se' && input.result.nSignals === 1) {
    appendSingleEndedLadder(lines, input, subcktName, sections);
  } else if (input.flow === 'preset-diff' && input.result.nSignals === 2) {
    appendDifferentialLadder(lines, input, subcktName, sections);
  } else {
    appendMulticonductorLadder(lines, input, subcktName, sections);
  }
  return {
    filename: `${modelExportBasename(input.title)}.cir`,
    mimeType: 'text/plain;charset=utf-8',
    text: `${lines.join('\n')}\n`,
  };
}
