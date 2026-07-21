/**
 * Adapter for free-form geometries whose reference is made only from explicit
 * conductor contours. The legacy MMTL kernel always needs an image plane, so
 * every physical conductor is solved as an active conductor above a remote
 * helper plane. Physical dielectric items keep their order and geometry;
 * matrix projection then removes the helper plane and restores an exactly
 * charge-neutral physical solution.
 */
import type {
  ConductorItem,
  LengthUnits,
  SolveOutput,
  SolveResult,
  Stackup,
} from '../model/types.ts';
import { isConductor } from '../model/types.ts';
import { solverSignalBindings } from '../xsctn/generate.ts';
import { calculateMmtlCrosstalk } from './crosstalk.ts';

export const EXPLICIT_REFERENCE_CLEARANCE_MULTIPLIER = 50;
export const MMTL_SPEED_OF_LIGHT_M_PER_S = 2.997925e8;
export const EXPLICIT_REFERENCE_CONDITION_LIMIT = 1e12;

const UNIT_SCALE_M: Record<LengthUnits, number> = {
  mils: 2.54e-5,
  microns: 1e-6,
  inches: 0.0254,
  meters: 1,
};

export type ExplicitReferencePhysicalRole = 'signal' | 'ground';

export interface ExplicitReferenceMemberMapping {
  /** Stable physical-member order: stackup item order, then set member. */
  memberIndex: number;
  /** Name produced after every physical member is made active for MMTL. */
  internalSolverName: string;
  role: ExplicitReferencePhysicalRole;
  originalItemIndex: number;
  originalItemId: string;
  /** Zero-based member index within the original conductor set. */
  originalMemberIndex: number;
  /** User-facing item/member name, for example return[2]. */
  originalMemberName: string;
  /** Zero-based physical-signal index, present only for signal members. */
  originalSignalIndex?: number;
  /** Original MMTL signal name, present only for signal members. */
  originalSignalName?: string;
  /** Original ground item identity, present only for ground members. */
  groundId?: string;
  /** Zero-based member index within a ground conductor set. */
  groundMemberIndex?: number;
  /** Translation from physical y coordinates to solver y coordinates. */
  verticalOffsetM: number;
}

export interface ExplicitReferencePreparation {
  solverStackup: Stackup;
  members: ExplicitReferenceMemberMapping[];
  signalMemberIndices: number[];
  /** Original MMTL signal names in physical-signal order. */
  signalNames: string[];
  /** True only when two user signal members form one isolated differential loop. */
  floatingPair: boolean;
  /** Original positive/negative conductor names for the floating loop. */
  floatingPairSignalNames?: [string, string];
  clearanceM: number;
  verticalOffsetM: number;
}

export interface ExplicitReferenceReduction {
  result: SolveResult;
  /** Primary capacitance reordered into physical-member order. */
  memberCapacitance: number[][];
  /** All-air capacitance reordered into physical-member order. */
  memberFreeSpaceCapacitance: number[][];
  /** Full member matrices after eliminating the remote helper plane. */
  neutralCapacitance: number[][];
  neutralFreeSpaceCapacitance: number[][];
  /** Physical-signal submatrices used in the reduced result. */
  capacitance: number[][];
  freeSpaceCapacitance: number[][];
  inductance: number[][];
  /** Full primary Rdc matrix reordered into physical-member order. */
  reorderedRdc: number[][];
  /** Physical-signal Rdc submatrix used in the reduced result. */
  signalRdc: number[][];
  /** [physical member][physical signal current] charge/current transform. */
  currentTransform: number[][];
}

/**
 * Publish the reduced physical result without exposing the shifted helper-plane
 * field plot. The raw solver output is cloned, not mutated.
 */
export function exposeExplicitReferenceSolveOutput(
  rawOutput: SolveOutput,
  reduction: ExplicitReferenceReduction,
): SolveOutput {
  if (!rawOutput.ok || rawOutput.result == null) {
    throw new Error('Cannot expose an unsuccessful explicit-reference solve.');
  }
  return {
    ...rawOutput,
    result: reduction.result,
    fieldText: null,
  };
}

interface PhysicalMember {
  itemIndex: number;
  memberIndex: number;
  memberName: string;
  role: ExplicitReferencePhysicalRole;
}

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

type Matrix = readonly (readonly number[])[];

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be finite.`);
  }
}

function validateConductor(conductor: ConductorItem, itemIndex: number): void {
  const label = `Conductor item ${itemIndex + 1}`;
  if (!Number.isInteger(conductor.number) || conductor.number < 1) {
    throw new Error(`${label} must contain at least one member.`);
  }
  for (const [name, value] of [
    ['pitch', conductor.pitch],
    ['x offset', conductor.xOffset],
    ['y offset', conductor.yOffset],
    ['conductivity', conductor.conductivity],
  ] as const) {
    assertFinite(value, `${label} ${name}`);
  }
  if (!(conductor.conductivity > 0)) {
    throw new Error(`${label} conductivity must be positive.`);
  }
  if (conductor.number > 1 && !(conductor.pitch > 0)) {
    throw new Error(`${label} pitch must be positive for multiple members.`);
  }
  if (conductor.kind === 'CircleConductors') {
    assertFinite(conductor.diameter, `${label} diameter`);
    if (!(conductor.diameter > 0)) {
      throw new Error(`${label} diameter must be positive.`);
    }
    return;
  }
  assertFinite(conductor.height, `${label} height`);
  if (!(conductor.height > 0)) {
    throw new Error(`${label} height must be positive.`);
  }
  if (conductor.kind === 'RectangleConductors') {
    assertFinite(conductor.width, `${label} width`);
    if (!(conductor.width > 0)) {
      throw new Error(`${label} width must be positive.`);
    }
    return;
  }
  assertFinite(conductor.topWidth, `${label} top width`);
  assertFinite(conductor.bottomWidth, `${label} bottom width`);
  if (!(conductor.topWidth > 0) || !(conductor.bottomWidth > 0)) {
    throw new Error(`${label} widths must be positive.`);
  }
}

function conductorSize(conductor: ConductorItem): {
  width: number;
  height: number;
} {
  if (conductor.kind === 'CircleConductors') {
    return { width: conductor.diameter, height: conductor.diameter };
  }
  return {
    width: conductor.kind === 'RectangleConductors'
      ? conductor.width
      : Math.max(conductor.topWidth, conductor.bottomWidth),
    height: conductor.height,
  };
}

function physicalMembersAndBounds(stackup: Stackup): {
  physicalMembers: PhysicalMember[];
  bounds: Bounds;
  geometryBounds: Bounds;
} {
  const physicalMembers: PhysicalMember[] = [];
  const bounds: Bounds = {
    minX: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  };
  const geometryBounds: Bounds = {
    minX: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  };
  let layerTop = 0;
  for (const [itemIndex, item] of stackup.items.entries()) {
    if (item.kind === 'DielectricLayer') {
      assertFinite(item.thickness, `Dielectric layer ${itemIndex + 1} thickness`);
      if (!(item.thickness > 0)) {
        throw new Error(`Dielectric layer ${itemIndex + 1} thickness must be positive.`);
      }
      geometryBounds.minY = Math.min(geometryBounds.minY, layerTop);
      layerTop += item.thickness;
      geometryBounds.maxY = Math.max(geometryBounds.maxY, layerTop);
      continue;
    }
    if (
      item.kind === 'RectangleDielectric' ||
      item.kind === 'TrapezoidDielectric' ||
      item.kind === 'CircleDielectric'
    ) {
      const width = item.kind === 'RectangleDielectric'
        ? item.width
        : item.kind === 'TrapezoidDielectric'
          ? Math.max(item.topWidth, item.bottomWidth)
          : item.diameter + (item.number - 1) * item.pitch;
      const x0 = item.xOffset;
      const x1 = x0 + width;
      const y0 = layerTop + item.yOffset;
      const height = item.kind === 'CircleDielectric' ? item.diameter : item.height;
      const y1 = y0 + height;
      for (const [name, value] of [
        ['width', width],
        ['height', height],
        ['x offset', item.xOffset],
        ['y offset', item.yOffset],
        ['permittivity', item.permittivity],
      ] as const) {
        assertFinite(value, `Dielectric item ${itemIndex + 1} ${name}`);
      }
      if (!(width > 0) || !(height > 0) || !(item.permittivity > 0)) {
        throw new Error(
          `Dielectric item ${itemIndex + 1} dimensions and permittivity must be positive.`,
        );
      }
      geometryBounds.minX = Math.min(geometryBounds.minX, x0);
      geometryBounds.maxX = Math.max(geometryBounds.maxX, x1);
      geometryBounds.minY = Math.min(geometryBounds.minY, y0);
      geometryBounds.maxY = Math.max(geometryBounds.maxY, y1);
      continue;
    }
    if (!isConductor(item)) continue;
    validateConductor(item, itemIndex);
    const { width, height } = conductorSize(item);
    for (let memberIndex = 0; memberIndex < item.number; memberIndex++) {
      const x0 = item.xOffset + memberIndex * item.pitch;
      const x1 = x0 + width;
      const y0 = layerTop + item.yOffset;
      const y1 = y0 + height;
      bounds.minX = Math.min(bounds.minX, x0);
      bounds.maxX = Math.max(bounds.maxX, x1);
      bounds.minY = Math.min(bounds.minY, y0);
      bounds.maxY = Math.max(bounds.maxY, y1);
      geometryBounds.minX = Math.min(geometryBounds.minX, x0);
      geometryBounds.maxX = Math.max(geometryBounds.maxX, x1);
      geometryBounds.minY = Math.min(geometryBounds.minY, y0);
      geometryBounds.maxY = Math.max(geometryBounds.maxY, y1);
      physicalMembers.push({
        itemIndex,
        memberIndex,
        memberName: item.number > 1
          ? `${item.id}[${memberIndex + 1}]`
          : item.id,
        role: item.isGround ? 'ground' : 'signal',
      });
    }
  }
  if (physicalMembers.length === 0) {
    throw new Error('An explicit-reference stackup needs physical conductors.');
  }
  return { physicalMembers, bounds, geometryBounds };
}

/** True only for an isolated two-member signal pair with no reference object. */
export function isFloatingPairStackup(stackup: Stackup): boolean {
  let signalMembers = 0;
  for (const item of stackup.items) {
    if (item.kind === 'GroundPlane') return false;
    if (!isConductor(item)) continue;
    if (item.isGround || !Number.isInteger(item.number) || item.number < 1) {
      return false;
    }
    signalMembers += item.number;
  }
  return signalMembers === 2;
}

/**
 * True for a topology with no implicit plane whose physical reference is made
 * either from explicit ground conductors or from the other member of an exact
 * two-conductor floating pair. Dielectric items are translated together with
 * the physical conductors by prepareExplicitReferenceStackup().
 */
export function isExplicitReferenceStackup(stackup: Stackup): boolean {
  let hasGround = false;
  for (const item of stackup.items) {
    if (item.kind === 'GroundPlane') return false;
    if (isConductor(item) && item.isGround && item.number > 0) hasGround = true;
  }
  return hasGround || isFloatingPairStackup(stackup);
}

/** Prepare an immutable, remote-plane full-active solve and member mapping. */
export function prepareExplicitReferenceStackup(
  stackup: Stackup,
): ExplicitReferencePreparation {
  if (!isExplicitReferenceStackup(stackup)) {
    throw new Error(
      'Explicit-reference preparation requires explicit ground conductors or an exact two-conductor floating pair, and no ground plane.',
    );
  }
  const floatingPair = isFloatingPairStackup(stackup);
  const unitScaleM = UNIT_SCALE_M[stackup.units];
  if (!(unitScaleM > 0)) {
    throw new Error('Unsupported explicit-reference stackup units.');
  }
  const {
    physicalMembers,
    bounds,
    geometryBounds,
  } = physicalMembersAndBounds(stackup);
  if (floatingPair) {
    if (physicalMembers.length !== 2) {
      throw new Error('A floating pair must contain exactly two physical members.');
    }
    // A floating pair has one independent loop. Use the first member as the
    // positive conductor and the second as its physical return. Reversing the
    // drive only negates this same basis; it is not a second electrical mode.
    physicalMembers[0] = { ...physicalMembers[0], role: 'signal' };
    physicalMembers[1] = { ...physicalMembers[1], role: 'ground' };
  }
  if (!physicalMembers.some((member) => member.role === 'signal')) {
    throw new Error('An explicit-reference stackup needs at least one signal.');
  }
  const physicalSpan = Math.max(
    bounds.maxX - bounds.minX,
    bounds.maxY - bounds.minY,
  );
  if (!(physicalSpan > 0) || !Number.isFinite(physicalSpan)) {
    throw new Error('The explicit-reference physical span must be positive.');
  }
  const clearance =
    EXPLICIT_REFERENCE_CLEARANCE_MULTIPLIER * physicalSpan;
  const physicalMinY = geometryBounds.minY;
  if (!Number.isFinite(physicalMinY)) {
    throw new Error('The explicit-reference physical geometry has invalid bounds.');
  }
  // Preserve the whole original stack verbatim and translate it only through
  // the prepended helper-air layer. Normally this places the lowest feature at
  // exactly `clearance`; a geometry already farther above its local origin only
  // needs a small positive layer to satisfy the legacy parser.
  const helperAirThickness = Math.max(
    clearance - physicalMinY,
    clearance * 1e-6,
  );
  if (!(helperAirThickness > 0) || !Number.isFinite(helperAirThickness)) {
    throw new Error('The explicit-reference helper-plane clearance is invalid.');
  }
  const translatedItems = stackup.items.map((item) => {
    if (item.kind === 'DielectricLayer') return { ...item };
    if (item.kind === 'GroundPlane') {
      throw new Error('Explicit-reference preparation found a ground plane.');
    }
    if (isConductor(item)) {
      return {
        ...item,
        isGround: false,
      } satisfies ConductorItem;
    }
    return { ...item };
  });
  const verticalOffset = helperAirThickness;
  const solverStackup: Stackup = {
    ...stackup,
    title: `${stackup.title}-explicit-reference-solver`,
    items: [
      { kind: 'GroundPlane', id: '__explicit_reference_plane' },
      {
        kind: 'DielectricLayer',
        id: '__explicit_reference_air',
        thickness: helperAirThickness,
        permittivity: 1,
        lossTangent: 0,
      },
      ...translatedItems,
    ],
  };

  const internalBindings = solverSignalBindings(solverStackup);
  if (internalBindings.length !== physicalMembers.length) {
    throw new Error('Explicit-reference member mapping is incomplete.');
  }
  const allOriginalBindings = solverSignalBindings(stackup);
  const floatingPairSignalNames = floatingPair
    ? [
        allOriginalBindings[0]?.solverName,
        allOriginalBindings[1]?.solverName,
      ]
    : undefined;
  if (
    floatingPair &&
    (
      !floatingPairSignalNames?.[0] ||
      !floatingPairSignalNames[1]
    )
  ) {
    throw new Error('Floating-pair conductor-name mapping is incomplete.');
  }
  const originalBindings = floatingPair
    ? allOriginalBindings.slice(0, 1)
    : allOriginalBindings;
  let nextSignal = 0;
  const verticalOffsetM = verticalOffset * unitScaleM;
  const members = physicalMembers.map((member, memberIndex) => {
    const item = stackup.items[member.itemIndex];
    if (!isConductor(item)) {
      throw new Error('Explicit-reference member no longer maps to a conductor.');
    }
    const common = {
      memberIndex,
      internalSolverName: internalBindings[memberIndex].solverName,
      role: member.role,
      originalItemIndex: member.itemIndex,
      originalItemId: item.id,
      originalMemberIndex: member.memberIndex,
      originalMemberName: member.memberName,
      verticalOffsetM,
    };
    if (member.role === 'signal') {
      const binding = originalBindings[nextSignal];
      if (!binding) {
        throw new Error('Original explicit-reference signal mapping is incomplete.');
      }
      const mapped: ExplicitReferenceMemberMapping = {
        ...common,
        originalSignalIndex: nextSignal,
        originalSignalName: binding.solverName,
      };
      nextSignal++;
      return mapped;
    }
    return {
      ...common,
      groundId: item.id,
      groundMemberIndex: member.memberIndex,
    } satisfies ExplicitReferenceMemberMapping;
  });
  if (nextSignal !== originalBindings.length) {
    throw new Error('Original explicit-reference signal mapping has extra entries.');
  }
  const signalMembers = members.filter(
    (member): member is ExplicitReferenceMemberMapping & {
      originalSignalIndex: number;
      originalSignalName: string;
    } =>
      member.role === 'signal' &&
      member.originalSignalIndex != null &&
      member.originalSignalName != null,
  );
  signalMembers.sort(
    (left, right) => left.originalSignalIndex - right.originalSignalIndex,
  );
  return {
    solverStackup,
    members,
    signalMemberIndices: signalMembers.map((member) => member.memberIndex),
    signalNames: signalMembers.map((member) => member.originalSignalName),
    floatingPair,
    floatingPairSignalNames: floatingPairSignalNames as
      [string, string] | undefined,
    clearanceM: clearance * unitScaleM,
    verticalOffsetM,
  };
}

function finiteSquareMatrix(matrix: Matrix, label: string): number[][] {
  const size = matrix.length;
  if (size === 0 || matrix.some((row) => row.length !== size)) {
    throw new Error(`${label} must be a non-empty square matrix.`);
  }
  const copy = matrix.map((row) => row.map((value) => {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} contains a non-finite value.`);
    }
    return value;
  }));
  return copy;
}

/** Enforce electrostatic reciprocity after the legacy text result is parsed. */
function symmetricFiniteMatrix(matrix: Matrix, label: string): number[][] {
  const source = finiteSquareMatrix(matrix, label);
  return source.map((row, rowIndex) => row.map(
    (_, columnIndex) =>
      (source[rowIndex][columnIndex] + source[columnIndex][rowIndex]) / 2,
  ));
}

function infinityNorm(matrix: Matrix): number {
  return Math.max(
    0,
    ...matrix.map((row) =>
      row.reduce((sum, value) => sum + Math.abs(value), 0)),
  );
}

/** Invert a finite matrix and reject singular or ill-conditioned inputs. */
export function invertExplicitReferenceMatrix(
  matrix: Matrix,
  label = 'Explicit-reference matrix',
): number[][] {
  const source = finiteSquareMatrix(matrix, label);
  const size = source.length;
  const scale = Math.max(Number.MIN_VALUE, infinityNorm(source));
  const augmented = source.map((row, rowIndex) => [
    ...row,
    ...Array.from(
      { length: size },
      (_, columnIndex) => rowIndex === columnIndex ? 1 : 0,
    ),
  ]);
  for (let column = 0; column < size; column++) {
    let pivotRow = column;
    for (let row = column + 1; row < size; row++) {
      if (
        Math.abs(augmented[row][column]) >
          Math.abs(augmented[pivotRow][column])
      ) {
        pivotRow = row;
      }
    }
    const pivotMagnitude = Math.abs(augmented[pivotRow][column]);
    if (!(pivotMagnitude > scale * 1e-14)) {
      throw new Error(`${label} is singular or numerically rank deficient.`);
    }
    [augmented[column], augmented[pivotRow]] = [
      augmented[pivotRow],
      augmented[column],
    ];
    const pivot = augmented[column][column];
    for (let entry = 0; entry < 2 * size; entry++) {
      augmented[column][entry] /= pivot;
    }
    for (let row = 0; row < size; row++) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let entry = 0; entry < 2 * size; entry++) {
        augmented[row][entry] -= factor * augmented[column][entry];
      }
    }
  }
  const inverse = augmented.map((row) => row.slice(size));
  const condition = infinityNorm(source) * infinityNorm(inverse);
  if (
    !Number.isFinite(condition) ||
    condition > EXPLICIT_REFERENCE_CONDITION_LIMIT
  ) {
    throw new Error(
      `${label} is ill-conditioned (condition estimate ${condition.toExponential(3)}).`,
    );
  }
  return inverse;
}

/**
 * Eliminate the remote helper plane from a full-active Maxwell matrix:
 * Cn = C - C1 (1^T C) / (1^T C 1).
 */
export function chargeNeutralProjection(
  matrix: Matrix,
  label = 'Explicit-reference capacitance',
): number[][] {
  const source = finiteSquareMatrix(matrix, label);
  const size = source.length;
  const rowSums = source.map((row) =>
    row.reduce((sum, value) => sum + value, 0));
  const columnSums = Array.from(
    { length: size },
    (_, column) => source.reduce(
      (sum, row) => sum + row[column],
      0,
    ),
  );
  const denominator = rowSums.reduce((sum, value) => sum + value, 0);
  const scale = Math.max(Number.MIN_VALUE, infinityNorm(source));
  if (
    !Number.isFinite(denominator) ||
    !(denominator > scale * size * 1e-14)
  ) {
    throw new Error(
      `${label} cannot eliminate the helper plane because its common-mode capacitance is singular.`,
    );
  }
  return source.map((row, rowIndex) => row.map(
    (value, columnIndex) =>
      value - rowSums[rowIndex] * columnSums[columnIndex] / denominator,
  ));
}

function reorderResultMatrix(
  result: SolveResult,
  matrix: Matrix,
  members: readonly ExplicitReferenceMemberMapping[],
  label: string,
): number[][] {
  if (
    result.nSignals !== result.names.length ||
    result.names.length !== members.length
  ) {
    throw new Error(`${label} does not contain every full-active member.`);
  }
  const source = finiteSquareMatrix(matrix, label);
  if (source.length !== result.names.length) {
    throw new Error(`${label} dimensions do not match its signal names.`);
  }
  const indices = new Map<string, number>();
  for (const [index, name] of result.names.entries()) {
    if (indices.has(name)) throw new Error(`${label} has duplicate signal names.`);
    indices.set(name, index);
  }
  const order = members.map((member) => {
    const index = indices.get(member.internalSolverName);
    if (index == null) {
      throw new Error(
        `${label} is missing full-active member ${member.internalSolverName}.`,
      );
    }
    return index;
  });
  return order.map((row) => order.map((column) => source[row][column]));
}

function submatrix(matrix: Matrix, indices: readonly number[]): number[][] {
  return indices.map((row) => indices.map((column) => matrix[row][column]));
}

function multiplyMatrices(left: Matrix, right: Matrix): number[][] {
  if (
    left.length === 0 ||
    right.length === 0 ||
    left[0].length !== right.length
  ) {
    throw new Error('Explicit-reference matrix product dimensions do not match.');
  }
  const columns = right[0].length;
  if (
    left.some((row) => row.length !== right.length) ||
    right.some((row) => row.length !== columns)
  ) {
    throw new Error('Explicit-reference matrix product is ragged.');
  }
  return left.map((row) => Array.from(
    { length: columns },
    (_, column) => row.reduce(
      (sum, value, inner) => sum + value * right[inner][column],
      0,
    ),
  ));
}

function columns(matrix: Matrix, indices: readonly number[]): number[][] {
  return matrix.map((row) => indices.map((index) => row[index]));
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || !(value > 0)) {
    throw new Error(`${label} must be finite and positive.`);
  }
  return value;
}

function validateCurrentTransform(
  transform: Matrix,
  signalMemberIndices: readonly number[],
): void {
  const tolerance = 2e-7;
  for (let signal = 0; signal < signalMemberIndices.length; signal++) {
    for (let column = 0; column < signalMemberIndices.length; column++) {
      const expected = signal === column ? 1 : 0;
      const actual = transform[signalMemberIndices[signal]][column];
      if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
        throw new Error('Explicit-reference current transform did not preserve signal currents.');
      }
    }
  }
  for (let column = 0; column < signalMemberIndices.length; column++) {
    const sum = transform.reduce((total, row) => total + row[column], 0);
    if (!Number.isFinite(sum) || Math.abs(sum) > tolerance) {
      throw new Error('Explicit-reference current transform is not charge neutral.');
    }
  }
}

/**
 * Reduce full-active primary and free-space solves to the original physical
 * signals while retaining a member-current transform for mesh postprocessing.
 */
export function reduceExplicitReferenceResults(
  preparation: ExplicitReferencePreparation,
  primaryResult: SolveResult,
  freeSpaceResult: SolveResult,
): ExplicitReferenceReduction {
  if (
    preparation.members.length === 0 ||
    preparation.signalMemberIndices.length === 0 ||
    preparation.signalNames.length !== preparation.signalMemberIndices.length
  ) {
    throw new Error('Explicit-reference preparation has no physical signals.');
  }
  const memberCapacitance = symmetricFiniteMatrix(
    reorderResultMatrix(
      primaryResult,
      primaryResult.B,
      preparation.members,
      'Primary full-active capacitance',
    ),
    'Primary full-active capacitance',
  );
  const memberFreeSpaceCapacitance = symmetricFiniteMatrix(
    reorderResultMatrix(
      freeSpaceResult,
      freeSpaceResult.B,
      preparation.members,
      'Free-space full-active capacitance',
    ),
    'Free-space full-active capacitance',
  );
  const reorderedRdc = symmetricFiniteMatrix(
    reorderResultMatrix(
      primaryResult,
      primaryResult.Rdc,
      preparation.members,
      'Primary full-active Rdc',
    ),
    'Primary full-active Rdc',
  );
  const neutralCapacitance = chargeNeutralProjection(
    memberCapacitance,
    'Primary full-active capacitance',
  );
  const neutralFreeSpaceCapacitance = chargeNeutralProjection(
    memberFreeSpaceCapacitance,
    'Free-space full-active capacitance',
  );
  const signalIndices = preparation.signalMemberIndices;
  if (
    preparation.floatingPair &&
    (
      preparation.members.length !== 2 ||
      signalIndices.length !== 1 ||
      signalIndices[0] !== 0 ||
      preparation.members[1]?.role !== 'ground'
    )
  ) {
    throw new Error(
      'Floating-pair preparation must map one driven member and one return member.',
    );
  }
  const capacitance = symmetricFiniteMatrix(
    submatrix(neutralCapacitance, signalIndices),
    'Reduced explicit-reference capacitance',
  );
  const freeSpaceCapacitance = symmetricFiniteMatrix(
    submatrix(neutralFreeSpaceCapacitance, signalIndices),
    'Reduced explicit-reference free-space capacitance',
  );
  const inverseFreeSpaceCapacitance = invertExplicitReferenceMatrix(
    freeSpaceCapacitance,
    'Reduced explicit-reference free-space capacitance',
  );
  const inverseCSquared =
    1 / (MMTL_SPEED_OF_LIGHT_M_PER_S * MMTL_SPEED_OF_LIGHT_M_PER_S);
  const inductance = symmetricFiniteMatrix(
    inverseFreeSpaceCapacitance.map((row) =>
      row.map((value) => value * inverseCSquared)),
    'Reduced explicit-reference inductance',
  );
  const currentTransform = multiplyMatrices(
    columns(neutralFreeSpaceCapacitance, signalIndices),
    inverseFreeSpaceCapacitance,
  );
  validateCurrentTransform(currentTransform, signalIndices);
  const signalRdc = symmetricFiniteMatrix(
    submatrix(reorderedRdc, signalIndices),
    'Reduced explicit-reference Rdc',
  );

  const count = signalIndices.length;
  const z0: number[] = [];
  const epsEff: number[] = [];
  const velocity: number[] = [];
  const delay: number[] = [];
  for (let index = 0; index < count; index++) {
    const cii = positiveFinite(
      capacitance[index][index],
      `Signal ${index + 1} capacitance`,
    );
    const c0ii = positiveFinite(
      freeSpaceCapacitance[index][index],
      `Signal ${index + 1} free-space capacitance`,
    );
    const lii = positiveFinite(
      inductance[index][index],
      `Signal ${index + 1} inductance`,
    );
    const effectivePermittivity = positiveFinite(
      cii / c0ii,
      `Signal ${index + 1} effective permittivity`,
    );
    const lineVelocity = positiveFinite(
      MMTL_SPEED_OF_LIGHT_M_PER_S / Math.sqrt(effectivePermittivity),
      `Signal ${index + 1} velocity`,
    );
    z0.push(positiveFinite(
      Math.sqrt(lii / cii),
      `Signal ${index + 1} characteristic impedance`,
    ));
    epsEff.push(effectivePermittivity);
    velocity.push(lineVelocity);
    delay.push(1 / lineVelocity);
  }

  let zOdd: number | undefined;
  let zEven: number | undefined;
  let velocityOdd: number | undefined;
  let velocityEven: number | undefined;
  let delayOdd: number | undefined;
  let delayEven: number | undefined;
  if (count === 2) {
    const cOdd = positiveFinite(
      capacitance[0][0] - capacitance[0][1],
      'Odd-mode capacitance',
    );
    const lOdd = positiveFinite(
      inductance[0][0] - inductance[0][1],
      'Odd-mode inductance',
    );
    zOdd = positiveFinite(Math.sqrt(lOdd / cOdd), 'Odd-mode impedance');
    velocityOdd = positiveFinite(
      1 / Math.sqrt(cOdd * lOdd),
      'Odd-mode velocity',
    );
    delayOdd = 1 / velocityOdd;
    const cEven = positiveFinite(
      capacitance[0][0] + capacitance[0][1],
      'Even-mode capacitance',
    );
    const lEven = positiveFinite(
      inductance[0][0] + inductance[0][1],
      'Even-mode inductance',
    );
    zEven = positiveFinite(Math.sqrt(lEven / cEven), 'Even-mode impedance');
    velocityEven = positiveFinite(
      1 / Math.sqrt(cEven * lEven),
      'Even-mode velocity',
    );
    delayEven = 1 / velocityEven;
  }

  const warnings = [...new Set([
    ...primaryResult.warnings,
    ...freeSpaceResult.warnings.map((warning) => `Free-space: ${warning}`),
  ])];
  // The native report rounds length to five decimal places and rise time to
  // four. Use the exact configured values so short-line crosstalk is neither
  // quantized nor rejected when a printed length rounds to zero.
  const couplingLengthM = preparation.solverStackup.couplingLengthM;
  const riseTimePs = preparation.solverStackup.riseTimePs;
  const { fxt, bxt } = calculateMmtlCrosstalk(
    preparation.signalNames,
    capacitance,
    inductance,
    velocity,
    couplingLengthM,
    riseTimePs,
  );
  const result: SolveResult = {
    nSignals: count,
    names: [...preparation.signalNames],
    floatingDifferential:
      preparation.floatingPair && preparation.floatingPairSignalNames
        ? {
            positiveName: preparation.floatingPairSignalNames[0],
            negativeName: preparation.floatingPairSignalNames[1],
          }
        : undefined,
    B: capacitance,
    L: inductance,
    Rdc: signalRdc,
    z0,
    zOdd,
    zEven,
    epsEff,
    velocity,
    velocityOdd,
    velocityEven,
    delay,
    delayOdd,
    delayEven,
    fxt,
    bxt,
    couplingLengthM,
    riseTimePs,
    minFreqMHz: primaryResult.minFreqMHz,
    warnings,
  };

  return {
    result,
    memberCapacitance,
    memberFreeSpaceCapacitance,
    neutralCapacitance,
    neutralFreeSpaceCapacitance,
    capacitance,
    freeSpaceCapacitance,
    inductance,
    reorderedRdc,
    signalRdc,
    currentTransform,
  };
}
