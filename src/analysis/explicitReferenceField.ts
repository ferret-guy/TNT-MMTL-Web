/**
 * Reconstruct physical field-plot bases for an isolated, explicit-reference
 * solve. MMTL drives every physical conductor against a remote helper plane.
 * A common-mode voltage is added to each ordinary one-hot excitation so the
 * helper plane has zero net charge, after which the helper-plane translation
 * is removed from the published mesh coordinates.
 */
import type {
  FieldElement,
  FieldSolution,
} from '../solver/parseFieldPlot.mjs';
import { parseFieldPlot } from '../solver/parseFieldPlot.mjs';
import type {
  ExplicitReferencePreparation,
  ExplicitReferenceReduction,
} from './explicitReference.ts';

export interface ExplicitReferenceFieldExcitation {
  signalIndex: number;
  signalName: string;
  signalMemberIndex: number;
  /** Voltage shared by every physical member relative to the helper plane. */
  commonModeVoltage: number;
  /** Raw full-active field-solution coefficients in physical-member order. */
  coefficients: number[];
}

const MESH_RELATIVE_TOLERANCE = 1e-12;

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be finite.`);
  }
}

function finiteSquareMatrix(
  matrix: readonly (readonly number[])[],
  size: number,
  label: string,
): number[][] {
  if (
    matrix.length !== size ||
    matrix.some((row) => row.length !== size)
  ) {
    throw new Error(`${label} dimensions do not match the active members.`);
  }
  return matrix.map((row, rowIndex) => row.map((value, columnIndex) => {
    assertFinite(value, `${label}[${rowIndex}][${columnIndex}]`);
    return value;
  }));
}

function validatePreparation(
  preparation: ExplicitReferencePreparation,
  reduction: ExplicitReferenceReduction,
): number[][] {
  const size = preparation.members.length;
  if (size < 2) {
    throw new Error(
      'Explicit-reference field transformation needs at least two physical members.',
    );
  }
  if (
    preparation.members.some(
      (member, index) =>
        member.memberIndex !== index ||
        member.verticalOffsetM !== preparation.verticalOffsetM,
    )
  ) {
    throw new Error('Explicit-reference member order or translation is inconsistent.');
  }
  const activeNames = preparation.members.map(
    (member) => member.internalSolverName,
  );
  if (
    new Set(activeNames).size !== size ||
    activeNames.some((name) => name.length === 0)
  ) {
    throw new Error('Explicit-reference active member names must be unique.');
  }
  if (
    preparation.signalNames.length === 0 ||
    preparation.signalNames.length !== preparation.signalMemberIndices.length ||
    preparation.signalNames.some((name) => name.length === 0) ||
    new Set(preparation.signalNames).size !== preparation.signalNames.length
  ) {
    throw new Error('Explicit-reference physical signal mapping is incomplete.');
  }
  const seenSignalMembers = new Set<number>();
  for (
    let signalIndex = 0;
    signalIndex < preparation.signalMemberIndices.length;
    signalIndex++
  ) {
    const memberIndex = preparation.signalMemberIndices[signalIndex];
    const member = preparation.members[memberIndex];
    if (
      !Number.isInteger(memberIndex) ||
      !member ||
      member.role !== 'signal' ||
      member.originalSignalIndex !== signalIndex ||
      member.originalSignalName !== preparation.signalNames[signalIndex] ||
      seenSignalMembers.has(memberIndex)
    ) {
      throw new Error('Explicit-reference physical signal member mapping is inconsistent.');
    }
    seenSignalMembers.add(memberIndex);
  }
  assertFinite(
    preparation.verticalOffsetM,
    'Explicit-reference vertical offset',
  );
  return finiteSquareMatrix(
    reduction.memberCapacitance,
    size,
    'Explicit-reference member capacitance',
  );
}

/**
 * Build the raw full-active voltage combinations for each physical signal.
 *
 * For raw Maxwell matrix C and desired one-hot physical voltage w, the
 * helper-plane charge vanishes when every member also receives
 *
 *   u = -(1^T C w) / (1^T C 1).
 *
 * Thus each returned coefficient vector is w + u1. This is the field-space
 * counterpart of the charge-neutral capacitance projection.
 */
export function explicitReferenceFieldExcitations(
  preparation: ExplicitReferencePreparation,
  reduction: ExplicitReferenceReduction,
): ExplicitReferenceFieldExcitation[] {
  const capacitance = validatePreparation(preparation, reduction);
  const size = capacitance.length;
  const columnSums = Array.from({ length: size }, (_, column) =>
    capacitance.reduce((sum, row) => sum + row[column], 0));
  const denominator = columnSums.reduce((sum, value) => sum + value, 0);
  const scale = Math.max(
    Number.MIN_VALUE,
    ...capacitance.map((row) =>
      row.reduce((sum, value) => sum + Math.abs(value), 0)),
  );
  if (
    !Number.isFinite(denominator) ||
    !(denominator > scale * size * 1e-14)
  ) {
    throw new Error(
      'Explicit-reference field transformation cannot eliminate a singular helper-plane common mode.',
    );
  }

  return preparation.signalMemberIndices.map((signalMemberIndex, signalIndex) => {
    const commonModeVoltage = -columnSums[signalMemberIndex] / denominator;
    assertFinite(
      commonModeVoltage,
      `Explicit-reference signal ${signalIndex + 1} common-mode voltage`,
    );
    const coefficients = Array(size).fill(commonModeVoltage) as number[];
    coefficients[signalMemberIndex] += 1;
    return {
      signalIndex,
      signalName: preparation.signalNames[signalIndex],
      signalMemberIndex,
      commonModeVoltage,
      coefficients,
    };
  });
}

function finiteElement(element: FieldElement, label: string): void {
  if (
    element.x.length === 0 ||
    element.x.length !== element.y.length ||
    element.x.length !== element.sigma.length
  ) {
    throw new Error(`${label} has inconsistent interpolation-node arrays.`);
  }
  for (const [arrayName, values] of [
    ['x', element.x],
    ['y', element.y],
    ['sigma', element.sigma],
  ] as const) {
    values.forEach((value, index) =>
      assertFinite(value, `${label} ${arrayName}[${index}]`));
  }
  assertFinite(element.epsilon, `${label} epsilon`);
  assertFinite(element.epsilonPlus, `${label} epsilon plus`);
  assertFinite(element.epsilonMinus, `${label} epsilon minus`);
  for (const [edgeIndex, edge] of element.edges.entries()) {
    if (edge.end !== 0 && edge.end !== 1) {
      throw new Error(`${label} edge ${edgeIndex} has an invalid endpoint.`);
    }
    assertFinite(edge.nu, `${label} edge ${edgeIndex} exponent`);
  }
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <=
    MESH_RELATIVE_TOLERANCE * Math.max(1, Math.abs(left), Math.abs(right));
}

function validateIdenticalMesh(
  reference: FieldSolution,
  candidate: FieldSolution,
  candidateIndex: number,
): void {
  if (candidate.elements.length !== reference.elements.length) {
    throw new Error(
      `Explicit-reference field solution ${candidateIndex + 1} uses a different mesh.`,
    );
  }
  for (let elementIndex = 0; elementIndex < reference.elements.length; elementIndex++) {
    const expected = reference.elements[elementIndex];
    const actual = candidate.elements[elementIndex];
    const label = `Explicit-reference field element ${elementIndex + 1}`;
    finiteElement(actual, label);
    if (
      actual.type !== expected.type ||
      actual.x.length !== expected.x.length ||
      actual.y.length !== expected.y.length ||
      actual.sigma.length !== expected.sigma.length ||
      actual.edges.length !== expected.edges.length ||
      !nearlyEqual(actual.epsilon, expected.epsilon) ||
      !nearlyEqual(actual.epsilonPlus, expected.epsilonPlus) ||
      !nearlyEqual(actual.epsilonMinus, expected.epsilonMinus)
    ) {
      throw new Error(`${label} differs between active solutions.`);
    }
    for (let point = 0; point < expected.x.length; point++) {
      if (
        !nearlyEqual(actual.x[point], expected.x[point]) ||
        !nearlyEqual(actual.y[point], expected.y[point])
      ) {
        throw new Error(`${label} geometry differs between active solutions.`);
      }
    }
    for (let edgeIndex = 0; edgeIndex < expected.edges.length; edgeIndex++) {
      if (
        actual.edges[edgeIndex].end !== expected.edges[edgeIndex].end ||
        !nearlyEqual(actual.edges[edgeIndex].nu, expected.edges[edgeIndex].nu)
      ) {
        throw new Error(`${label} edge data differs between active solutions.`);
      }
    }
  }
}

function cloneCombinedElement(
  elements: readonly FieldElement[],
  coefficients: readonly number[],
  verticalOffsetM: number,
): FieldElement {
  const reference = elements[0];
  return {
    type: reference.type,
    x: [...reference.x],
    y: reference.y.map((value) => value - verticalOffsetM),
    sigma: reference.sigma.map((_, pointIndex) => {
      const value = elements.reduce(
        (sum, element, solutionIndex) =>
          sum + coefficients[solutionIndex] * element.sigma[pointIndex],
        0,
      );
      assertFinite(value, 'Combined explicit-reference field charge');
      return value;
    }),
    edges: reference.edges.map((edge) => ({ ...edge })),
    epsilon: reference.epsilon,
    epsilonPlus: reference.epsilonPlus,
    epsilonMinus: reference.epsilonMinus,
  };
}

/**
 * Parse and combine MMTL's full-active field bases into physical-signal
 * bases. Returned geometry is in the original physical coordinate system.
 */
export function transformExplicitReferenceFieldSolutions(
  rawFieldText: string,
  preparation: ExplicitReferencePreparation,
  reduction: ExplicitReferenceReduction,
): FieldSolution[] {
  const excitations = explicitReferenceFieldExcitations(
    preparation,
    reduction,
  );
  const parsed = parseFieldPlot(rawFieldText);
  const expectedNames = preparation.members.map(
    (member) => member.internalSolverName,
  );
  const expectedSet = new Set(expectedNames);
  const byName = new Map<string, FieldSolution>();
  for (const solution of parsed) {
    if (!expectedSet.has(solution.line)) {
      throw new Error(
        `Explicit-reference field data contains unexpected active line ${solution.line}.`,
      );
    }
    if (byName.has(solution.line)) {
      throw new Error(
        `Explicit-reference field data contains duplicate active line ${solution.line}.`,
      );
    }
    byName.set(solution.line, solution);
  }
  if (byName.size !== expectedNames.length) {
    throw new Error('Explicit-reference field data is missing an active conductor basis.');
  }
  const activeSolutions = expectedNames.map((name) => {
    const solution = byName.get(name);
    if (!solution) {
      throw new Error(
        `Explicit-reference field data is missing active line ${name}.`,
      );
    }
    return solution;
  });
  if (activeSolutions[0].elements.length === 0) {
    throw new Error('Explicit-reference field data contains no boundary mesh.');
  }
  for (const [elementIndex, element] of activeSolutions[0].elements.entries()) {
    finiteElement(element, `Explicit-reference field element ${elementIndex + 1}`);
  }
  for (let solutionIndex = 1; solutionIndex < activeSolutions.length; solutionIndex++) {
    validateIdenticalMesh(
      activeSolutions[0],
      activeSolutions[solutionIndex],
      solutionIndex,
    );
  }

  return excitations.map((excitation) => ({
    line: excitation.signalName,
    imagePlaneYM: -preparation.verticalOffsetM,
    calibrationMode: 'isolated',
    elements: activeSolutions[0].elements.map((_, elementIndex) =>
      cloneCombinedElement(
        activeSolutions.map((solution) => solution.elements[elementIndex]),
        excitation.coefficients,
        preparation.verticalOffsetM,
      )),
  }));
}

function formatFieldNumber(value: number, label: string): string {
  assertFinite(value, label);
  return (Object.is(value, -0) ? 0 : value).toExponential(16);
}

/** Serialize field solutions in MMTL's parse-compatible plot-data format. */
export function serializeFieldSolutions(
  solutions: readonly FieldSolution[],
): string {
  if (solutions.length === 0) {
    throw new Error('Cannot serialize an empty field-solution set.');
  }
  const lines: string[] = [];
  for (const [solutionIndex, solution] of solutions.entries()) {
    if (!solution.line || /[\r\n]/.test(solution.line)) {
      throw new Error(`Field solution ${solutionIndex + 1} has an invalid line name.`);
    }
    lines.push('Start Solution Output:');
    lines.push(`Active Line: ${solution.line}`);
    if (solution.imagePlaneYM != null) {
      lines.push(
        `Image Plane Y: ${formatFieldNumber(
          solution.imagePlaneYM,
          `Field solution ${solutionIndex + 1} image-plane position`,
        )}`,
      );
    }
    if (solution.calibrationMode != null) {
      if (!solution.calibrationMode || /[\r\n]/.test(solution.calibrationMode)) {
        throw new Error(
          `Field solution ${solutionIndex + 1} has an invalid calibration mode.`,
        );
      }
      lines.push(`Calibration Mode: ${solution.calibrationMode}`);
    }
    lines.push('');
    for (const [elementIndex, element] of solution.elements.entries()) {
      finiteElement(
        element,
        `Field solution ${solutionIndex + 1} element ${elementIndex + 1}`,
      );
      lines.push(
        `Element Type: ${element.type === 'conductor' ? 'Conductor' : 'Dielectric'}`,
      );
      lines.push(
        `X Points: ${element.x.map((value) =>
          formatFieldNumber(value, 'Field element x coordinate')).join(' ')}`,
      );
      lines.push(
        `Y Points: ${element.y.map((value) =>
          formatFieldNumber(value, 'Field element y coordinate')).join(' ')}`,
      );
      for (const edge of element.edges) {
        lines.push(
          `Edge: ${edge.end} ${formatFieldNumber(edge.nu, 'Field element edge exponent')}`,
        );
      }
      if (element.type === 'conductor') {
        lines.push(
          `Epsilon: ${formatFieldNumber(element.epsilon, 'Field element epsilon')}`,
        );
      }
      lines.push(
        `Charge Values: ${element.sigma.map((value) =>
          formatFieldNumber(value, 'Field element charge')).join(' ')}`,
      );
      if (element.type === 'dielectric') {
        lines.push(
          `EpsilonPM: ${formatFieldNumber(
            element.epsilonPlus,
            'Field element epsilon plus',
          )} ${formatFieldNumber(
            element.epsilonMinus,
            'Field element epsilon minus',
          )}`,
        );
      }
      lines.push('');
    }
    lines.push('End Solution Output:');
  }
  return `${lines.join('\n')}\n`;
}

/** Convenience form used by SolveOutput.fieldText. */
export function transformExplicitReferenceFieldText(
  rawFieldText: string,
  preparation: ExplicitReferencePreparation,
  reduction: ExplicitReferenceReduction,
): string {
  return serializeFieldSolutions(
    transformExplicitReferenceFieldSolutions(
      rawFieldText,
      preparation,
      reduction,
    ),
  );
}
