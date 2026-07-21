/**
 * Mesh-derived return-conductor loss geometry.
 *
 * MMTL obtains L from an electrostatic solve with every dielectric replaced
 * by air. For quasi-TEM lines, that free-space charge basis is the magnetic
 * dual of the longitudinal surface-current basis. The bundled solver only
 * writes its final dielectric solution, so the browser repeats the same mesh
 * solve with er=1 and consumes that otherwise-identical field output here.
 *
 * The bottom ground plane is implicit in MMTL's image Green function and is
 * therefore not present in the element list. Its current-overlap matrix is
 * recovered with the exact product integral of two Poisson kernels.
 */
import type {
  ConductorItem,
  GroundPlaneItem,
  SolveOutput,
  Stackup,
  StackupItem,
} from '../model/types.ts';
import { isConductor } from '../model/types.ts';
import { parseFieldPlot } from '../solver/parseFieldPlot.mjs';
import type {
  FieldElement,
  FieldSolution,
} from '../solver/parseFieldPlot.mjs';
import { solverSignalBindings } from '../xsctn/generate.ts';
import {
  UNIT_SCALE,
  type ReferencePlaneLossModel,
  type ReferencePlaneLossTerm,
} from './losses.ts';
import type { GroundCurrentDistribution } from './groundCurrent.ts';
import type {
  ExplicitReferencePreparation,
  ExplicitReferenceReduction,
} from './explicitReference.ts';

const DEFAULT_CONDUCTIVITY_S_PER_M = 5e7;
const DEFAULT_PLANE_THICKNESS_M = 1.4 * 2.54e-5;
const MIN_POSITIVE = 1e-30;

export const CPW_RETURN_CURRENT_MESH_MULTIPLIER = 10;

type Point = [number, number];

interface SurfaceComponent {
  key: string;
  id: string;
  role: 'signal' | 'ground';
  kind: 'conductor' | 'top-plane';
  solverName?: string;
  signalIndex?: number;
  centerM: number;
  widthM: number;
  conductivity: number;
  thicknessM: number;
  distanceM: (xM: number, yM: number) => number;
  outwardNormal: (
    xM: number,
    yM: number,
    tangentXM: number,
    tangentYM: number,
  ) => [number, number];
}

interface RawQuadraturePoint {
  elementIndex: number;
  t: number;
  xM: number;
  yM: number;
  nx: number;
  ny: number;
  weightM: number;
  rawSigma: number[];
  component: SurfaceComponent;
}

interface CurrentQuadraturePoint extends RawQuadraturePoint {
  currentAPerM: number[];
}

export interface MeshGroundCurrentSample {
  t: number;
  xM: number;
  yM: number;
  /** Unit normal pointing away from the conductor into the field region. */
  nx: number;
  ny: number;
  /** Quadrature weight ds in meters. */
  weightM: number;
  /** Signed physical +z current-density bases in signalNames order. */
  currentBasisAPerM: number[];
}

export interface MeshGroundCurrentElement {
  elementIndex: number;
  samples: MeshGroundCurrentSample[];
}

export interface MeshGroundCurrentSurface {
  /** Stable geometry key; unlike the display id, this cannot merge members. */
  key: string;
  id: string;
  label: string;
  kind: 'conductor' | 'top-plane';
  elements: MeshGroundCurrentElement[];
  /** Signed physical +z current for every unit signal-current basis. */
  netCurrentBasisA: number[];
}

export interface MeshGroundCurrentSignal {
  id: string;
  solverName: string;
  centerM: number;
  widthM: number;
  /** Index in signalNames and in every current-basis vector. */
  resultIndex: number;
}

export interface MeshGroundCurrentSource {
  xM: number;
  yM: number;
  weightM: number;
  /** Signed physical +z current-density bases in signalNames order. */
  currentBasisAPerM: number[];
}

export interface MeshImplicitBottomCurrent {
  id: string;
  label: string;
  yM: 0;
  xMinM: number;
  xMaxM: number;
  /** All explicit mesh sources above the image plane. */
  sources: MeshGroundCurrentSource[];
  /** Exact signed physical current; it does not depend on the display span. */
  netCurrentBasisA: number[];
}

export interface MeshGroundCurrentBasis {
  /** Native MMTL result order. */
  signalNames: string[];
  /** Signal geometry remains in drawing order and joins by solverName. */
  signals: MeshGroundCurrentSignal[];
  /** Explicit ground conductors, including the meshed upper plane. */
  surfaces: MeshGroundCurrentSurface[];
  /** The lower plane is implicit in MMTL's image Green function, when used. */
  implicitBottom: MeshImplicitBottomCurrent | null;
}

export interface MeshReferenceAnalysis {
  lossModel: ReferencePlaneLossModel;
  currentBasis: MeshGroundCurrentBasis;
}

const GL8_U = [
  0.0198550717512319,
  0.101666761293187,
  0.237233795041836,
  0.408282678752175,
  0.591717321247825,
  0.762766204958164,
  0.898333238706813,
  0.980144928248768,
];

const GL8_W = [
  0.0506142681451881,
  0.111190517226687,
  0.156853322938944,
  0.181341891689181,
  0.181341891689181,
  0.156853322938944,
  0.111190517226687,
  0.0506142681451881,
];

function zeroMatrix(size: number): number[][] {
  return Array.from({ length: size }, () => Array(size).fill(0));
}

function addMatrix(target: number[][], source: number[][]): void {
  for (let row = 0; row < target.length; row++) {
    for (let column = 0; column < target.length; column++) {
      target[row][column] += source[row]?.[column] ?? 0;
    }
  }
}

function sanitizeOverlap(matrix: number[][]): number[][] {
  const out = matrix.map((row) => [...row]);
  for (let row = 0; row < out.length; row++) {
    out[row][row] = Math.max(0, out[row][row]);
    for (let column = 0; column < row; column++) {
      const limit = Math.sqrt(
        Math.max(0, out[row][row] * out[column][column]),
      );
      const symmetric =
        ((out[row][column] ?? 0) + (out[column][row] ?? 0)) / 2;
      const bounded = Math.max(-limit, Math.min(limit, symmetric));
      out[row][column] = bounded;
      out[column][row] = bounded;
    }
  }
  return out;
}

function transpose(matrix: number[][]): number[][] {
  return matrix.map((_, column) => matrix.map((row) => row[column]));
}

function invert(matrix: number[][]): number[][] {
  const size = matrix.length;
  if (
    size === 0 ||
    matrix.some((row) => row.length !== size || row.some((value) => !Number.isFinite(value)))
  ) {
    throw new Error('The free-space current-normalization matrix is incomplete.');
  }
  const scale = Math.max(
    MIN_POSITIVE,
    ...matrix.flat().map((value) => Math.abs(value)),
  );
  const augmented = matrix.map((row, index) => [
    ...row,
    ...Array.from({ length: size }, (_, column) =>
      column === index ? 1 : 0),
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
    if (Math.abs(augmented[pivotRow][column]) <= scale * 1e-12) {
      throw new Error('The free-space current-normalization matrix is singular.');
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
  return augmented.map((row) => row.slice(size));
}

function multiplyRowByMatrix(row: number[], matrix: number[][]): number[] {
  return matrix[0].map((_, column) =>
    row.reduce(
      (sum, value, index) => sum + value * matrix[index][column],
      0,
    ));
}

function shape(t: number): [number, number, number] {
  const oneMinus = 1 - t;
  return [
    oneMinus * (1 - 2 * t),
    4 * oneMinus * t,
    t * (2 * t - 1),
  ];
}

function shapeDerivative(t: number): [number, number, number] {
  return [4 * t - 3, 4 - 8 * t, 4 * t - 1];
}

function interpolate(
  values: number[],
  basis: [number, number, number],
): number {
  return (
    basis[0] * values[0] +
    basis[1] * values[1] +
    basis[2] * values[2]
  );
}

function distance(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  return Math.hypot(x1 - x0, y1 - y0);
}

/**
 * Intended edge basis used by MMTL. The legacy C++ has a documented typo in
 * its second-edge branch; this evaluator uses that edge's own exponent so the
 * ideal-corner power integral remains physical and convergent.
 */
function edgeShape(
  element: FieldElement,
  t: number,
): [number, number, number] {
  const ordinary = shape(t);
  const adjusted: [number, number, number] = [...ordinary];
  const x = interpolate(element.x, ordinary);
  const y = interpolate(element.y, ordinary);
  const fullLength = Math.max(
    MIN_POSITIVE,
    distance(element.x[0], element.y[0], element.x[2], element.y[2]),
  );
  for (const edge of element.edges) {
    const endpoint = edge.end === 0 ? 0 : 2;
    const radial = Math.max(
      MIN_POSITIVE,
      distance(x, y, element.x[endpoint], element.y[endpoint]),
    );
    const exponent = edge.nu - 1;
    const endFactor = (radial / fullLength) ** exponent;
    adjusted[0] *= endFactor;
    adjusted[2] *= endFactor;
    const middleLength = Math.max(
      MIN_POSITIVE,
      distance(
        element.x[1],
        element.y[1],
        element.x[endpoint],
        element.y[endpoint],
      ),
    );
    adjusted[1] *= (radial / middleLength) ** exponent;
  }
  return adjusted;
}

function edgePower(element: FieldElement, end: 0 | 1): number {
  const edge = element.edges.find((candidate) => candidate.end === end);
  if (!edge) return 1;
  const denominator = 2 * edge.nu - 1;
  if (!(denominator > 1e-6)) {
    throw new Error(
      'An ideal conductor corner is too sharp for finite surface-current loss.',
    );
  }
  return Math.min(12, Math.max(1, 1 / denominator));
}

function quadratureParameters(
  element: FieldElement,
): Array<{ t: number; weight: number }> {
  const edge0 = element.edges.some((edge) => edge.end === 0);
  const edge1 = element.edges.some((edge) => edge.end === 1);
  const q0 = edgePower(element, 0);
  const q1 = edgePower(element, 1);
  const out: Array<{ t: number; weight: number }> = [];
  for (let index = 0; index < GL8_U.length; index++) {
    const u = GL8_U[index];
    const weight = GL8_W[index];
    if (edge0 && edge1) {
      out.push({
        t: 0.5 * u ** q0,
        weight: weight * 0.5 * q0 * u ** (q0 - 1),
      });
      out.push({
        t: 1 - 0.5 * (1 - u) ** q1,
        weight: weight * 0.5 * q1 * (1 - u) ** (q1 - 1),
      });
    } else if (edge0) {
      out.push({
        t: u ** q0,
        weight: weight * q0 * u ** (q0 - 1),
      });
    } else if (edge1) {
      out.push({
        t: 1 - (1 - u) ** q1,
        weight: weight * q1 * (1 - u) ** (q1 - 1),
      });
    } else {
      out.push({ t: u, weight });
    }
  }
  return out;
}

function pointSegmentDistance(
  x: number,
  y: number,
  start: Point,
  end: Point,
): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const denominator = dx * dx + dy * dy;
  const projection = denominator > 0
    ? Math.max(
      0,
      Math.min(1, ((x - start[0]) * dx + (y - start[1]) * dy) / denominator),
    )
    : 0;
  return distance(
    x,
    y,
    start[0] + projection * dx,
    start[1] + projection * dy,
  );
}

function polygonBoundaryDistance(
  x: number,
  y: number,
  points: Point[],
): number {
  let closest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < points.length; index++) {
    closest = Math.min(
      closest,
      pointSegmentDistance(
        x,
        y,
        points[index],
        points[(index + 1) % points.length],
      ),
    );
  }
  return closest;
}

function outwardNormalFromCenter(
  centerXM: number,
  centerYM: number,
  xM: number,
  yM: number,
  tangentXM: number,
  tangentYM: number,
): [number, number] {
  const tangentLength = Math.hypot(tangentXM, tangentYM);
  if (!(tangentLength > 0)) return [0, 0];
  let nx = -tangentYM / tangentLength;
  let ny = tangentXM / tangentLength;
  if ((xM - centerXM) * nx + (yM - centerYM) * ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  return [nx, ny];
}

function conductorThicknessM(
  conductor: ConductorItem,
  unitScaleM: number,
): number {
  if (conductor.kind === 'CircleConductors') {
    return conductor.diameter * unitScaleM;
  }
  return conductor.height * unitScaleM;
}

function planeConductivity(plane: GroundPlaneItem | undefined): number {
  return plane?.conductivity && plane.conductivity > 0
    ? plane.conductivity
    : DEFAULT_CONDUCTIVITY_S_PER_M;
}

function planeThicknessM(
  plane: GroundPlaneItem | undefined,
  unitScaleM: number,
): number {
  return plane?.thickness && plane.thickness > 0
    ? plane.thickness * unitScaleM
    : DEFAULT_PLANE_THICKNESS_M;
}

function placedComponents(
  stackup: Stackup,
): {
  components: SurfaceComponent[];
  bottomPlane: GroundPlaneItem | null;
  unitScaleM: number;
  geometryScaleM: number;
  domainXMinM: number;
  domainXMaxM: number;
} {
  const unitScaleM = UNIT_SCALE[stackup.units];
  if (!(unitScaleM > 0)) throw new Error('Unsupported stackup length unit.');
  const bindings = solverSignalBindings(stackup);
  const groundPlanes = stackup.items.flatMap((item, index) =>
    item.kind === 'GroundPlane' ? [{ item, index }] : []);
  let totalWidth = 0;
  for (const item of stackup.items) {
    if (!isConductor(item)) continue;
    const width = item.kind === 'CircleConductors'
      ? item.diameter
      : item.kind === 'RectangleConductors'
        ? item.width
        : Math.max(item.topWidth, item.bottomWidth);
    totalWidth = Math.max(
      totalWidth,
      item.xOffset + (item.number - 1) * item.pitch + width,
    );
  }
  totalWidth = Math.max(totalWidth, 1);

  const components: SurfaceComponent[] = [];
  let y = 0;
  let signalOrdinal = 0;
  for (let itemIndex = 0; itemIndex < stackup.items.length; itemIndex++) {
    const item = stackup.items[itemIndex];
    if (item.kind === 'DielectricLayer') {
      y += item.thickness;
      continue;
    }
    if (!isConductor(item)) continue;
    const baseY = y + item.yOffset;
    for (let member = 0; member < item.number; member++) {
      const baseX = item.xOffset + member * item.pitch;
      const role = item.isGround ? 'ground' : 'signal';
      const binding = role === 'signal' ? bindings[signalOrdinal] : undefined;
      const width = item.kind === 'CircleConductors'
        ? item.diameter
        : item.kind === 'RectangleConductors'
          ? item.width
          : Math.max(item.topWidth, item.bottomWidth);
      const centerXM = (baseX + width / 2) * unitScaleM;
      const centerYM = (
        baseY + (
          item.kind === 'CircleConductors'
            ? item.diameter / 2
            : item.height / 2
        )
      ) * unitScaleM;
      const common = {
        key: `item:${itemIndex}:member:${member}`,
        id: item.number > 1 ? `${item.id}[${member + 1}]` : item.id,
        role,
        kind: 'conductor' as const,
        solverName: binding?.solverName,
        signalIndex: role === 'signal' ? signalOrdinal : undefined,
        centerM: centerXM,
        widthM: width * unitScaleM,
        conductivity: item.conductivity,
        thicknessM: conductorThicknessM(item, unitScaleM),
      } satisfies Omit<SurfaceComponent, 'distanceM' | 'outwardNormal'>;
      if (item.kind === 'CircleConductors') {
        const radiusM = item.diameter * unitScaleM / 2;
        components.push({
          ...common,
          distanceM: (xM, yM) =>
            Math.abs(Math.hypot(xM - centerXM, yM - centerYM) - radiusM),
          outwardNormal: (xM, yM, tangentXM, tangentYM) =>
            outwardNormalFromCenter(
              centerXM,
              centerYM,
              xM,
              yM,
              tangentXM,
              tangentYM,
            ),
        });
      } else {
        const height = item.height;
        const maxWidth = item.kind === 'RectangleConductors'
          ? item.width
          : Math.max(item.topWidth, item.bottomWidth);
        const center = baseX + maxWidth / 2;
        const bottomWidth = item.kind === 'RectangleConductors'
          ? item.width
          : item.bottomWidth;
        const topWidth = item.kind === 'RectangleConductors'
          ? item.width
          : item.topWidth;
        const points: Point[] = [
          [(center - bottomWidth / 2) * unitScaleM, baseY * unitScaleM],
          [(center + bottomWidth / 2) * unitScaleM, baseY * unitScaleM],
          [(center + topWidth / 2) * unitScaleM, (baseY + height) * unitScaleM],
          [(center - topWidth / 2) * unitScaleM, (baseY + height) * unitScaleM],
        ];
        components.push({
          ...common,
          distanceM: (xM, yM) =>
            polygonBoundaryDistance(xM, yM, points),
          outwardNormal: (xM, yM, tangentXM, tangentYM) =>
            outwardNormalFromCenter(
              centerXM,
              centerYM,
              xM,
              yM,
              tangentXM,
              tangentYM,
            ),
        });
      }
      if (role === 'signal') signalOrdinal++;
    }
  }

  if (groundPlanes.length >= 2) {
    const { item: upper, index: upperIndex } = groundPlanes[1];
    const topYM = y * unitScaleM;
    const lowXM = -totalWidth * unitScaleM;
    const highXM = 2 * totalWidth * unitScaleM;
    components.push({
      key: `plane:${upperIndex}`,
      id: upper.id,
      role: 'ground',
      kind: 'top-plane',
      centerM: (lowXM + highXM) / 2,
      widthM: highXM - lowXM,
      conductivity: planeConductivity(upper),
      thicknessM: planeThicknessM(upper, unitScaleM),
      distanceM: (xM, yM) => {
        const dx = xM < lowXM
          ? lowXM - xM
          : xM > highXM
            ? xM - highXM
            : 0;
        return Math.hypot(dx, yM - topYM);
      },
      outwardNormal: () => [0, -1],
    });
  }

  return {
    components,
    bottomPlane: groundPlanes[0]?.item ?? null,
    unitScaleM,
    geometryScaleM: Math.max(totalWidth * unitScaleM, y * unitScaleM),
    domainXMinM: -totalWidth * unitScaleM,
    domainXMaxM: 2 * totalWidth * unitScaleM,
  };
}

function bindExplicitReferenceComponents(
  components: SurfaceComponent[],
  preparation: ExplicitReferencePreparation,
): Map<string, string> {
  const conductorComponents = components.filter(
    (component) => component.kind === 'conductor',
  );
  if (preparation.members.length !== conductorComponents.length) {
    throw new Error(
      'The explicit-reference adapter does not cover every physical conductor member.',
    );
  }
  const activeSolverNames = preparation.members.map(
    (member) => member.internalSolverName,
  );
  if (
    new Set(activeSolverNames).size !== activeSolverNames.length ||
    new Set(preparation.signalNames).size !== preparation.signalNames.length
  ) {
    throw new Error('The explicit-reference adapter contains duplicate solver names.');
  }

  const componentByKey = new Map<string, SurfaceComponent>();
  for (const component of conductorComponents) {
    if (componentByKey.has(component.key)) {
      throw new Error(
        `The physical conductor key ${component.key} is not unique.`,
      );
    }
    componentByKey.set(component.key, component);
  }

  const activeNameByComponentKey = new Map<string, string>();
  const physicalSignalMembers = new Set<number>();
  for (let index = 0; index < preparation.members.length; index++) {
    const member = preparation.members[index];
    if (member.memberIndex !== index) {
      throw new Error(
        'The explicit-reference members are not in physical-member order.',
      );
    }
    const component = componentByKey.get(
      `item:${member.originalItemIndex}:member:${member.originalMemberIndex}`,
    );
    if (!component || activeNameByComponentKey.has(component.key)) {
      throw new Error(
        `The explicit-reference member ${member.originalMemberName} does not map uniquely to the physical geometry.`,
      );
    }
    // The editor intentionally leaves both members of a floating pair marked
    // as signals. Electrically there is one loop, so preparation designates
    // member 0 as driven and member 1 as its return for loss/current analysis.
    if (preparation.floatingPair) component.role = member.role;
    if (
      component.id !== member.originalMemberName ||
      component.role !== member.role
    ) {
      throw new Error(
        `The explicit-reference mapping for ${member.originalMemberName} does not match the physical stackup.`,
      );
    }
    activeNameByComponentKey.set(component.key, member.internalSolverName);

    if (member.role === 'signal') {
      const signalIndex = member.originalSignalIndex;
      if (
        signalIndex == null ||
        !Number.isInteger(signalIndex) ||
        signalIndex < 0 ||
        signalIndex >= preparation.signalNames.length ||
        physicalSignalMembers.has(signalIndex) ||
        member.originalSignalName !== preparation.signalNames[signalIndex]
      ) {
        throw new Error(
          `The explicit-reference signal mapping for ${member.originalMemberName} is invalid.`,
        );
      }
      physicalSignalMembers.add(signalIndex);
      component.solverName = member.originalSignalName;
      component.signalIndex = signalIndex;
    } else {
      component.solverName = undefined;
      component.signalIndex = undefined;
    }
  }
  if (
    physicalSignalMembers.size !== preparation.signalNames.length ||
    preparation.signalMemberIndices.length !== preparation.signalNames.length ||
    preparation.signalMemberIndices.some((memberIndex, signalIndex) =>
      preparation.members[memberIndex]?.originalSignalIndex !== signalIndex)
  ) {
    throw new Error(
      'The explicit-reference adapter does not map every physical signal.',
    );
  }
  return activeNameByComponentKey;
}

function matchingComponent(
  element: FieldElement,
  components: SurfaceComponent[],
  toleranceM: number,
  verticalOffsetM = 0,
): SurfaceComponent {
  const xM = element.x[1];
  const yM = element.y[1] - verticalOffsetM;
  let best: SurfaceComponent | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const component of components) {
    const candidate = component.distanceM(xM, yM);
    if (candidate < bestDistance) {
      best = component;
      bestDistance = candidate;
    }
  }
  if (!best || bestDistance > toleranceM) {
    throw new Error(
      `Could not map a free-space mesh element at (${xM}, ${yM}) to a conductor.`,
    );
  }
  return best;
}

function conductorElements(solution: FieldSolution): FieldElement[] {
  return solution.elements.filter((element) => element.type === 'conductor');
}

function validateSolutionGeometry(
  reference: FieldElement[],
  candidate: FieldElement[],
  toleranceM: number,
): void {
  if (candidate.length !== reference.length) {
    throw new Error('Free-space current bases use different conductor meshes.');
  }
  for (let element = 0; element < reference.length; element++) {
    for (let point = 0; point < 3; point++) {
      if (
        Math.abs(reference[element].x[point] - candidate[element].x[point]) >
          toleranceM ||
        Math.abs(reference[element].y[point] - candidate[element].y[point]) >
          toleranceM
      ) {
        throw new Error('Free-space current bases use different conductor meshes.');
      }
    }
  }
}

function rawQuadrature(
  elementsBySolution: FieldElement[][],
  components: SurfaceComponent[],
  toleranceM: number,
  verticalOffsetM = 0,
): RawQuadraturePoint[] {
  const out: RawQuadraturePoint[] = [];
  for (
    let elementIndex = 0;
    elementIndex < elementsBySolution[0].length;
    elementIndex++
  ) {
    const element = elementsBySolution[0][elementIndex];
    const component = matchingComponent(
      element,
      components,
      toleranceM,
      verticalOffsetM,
    );
    const samples = quadratureParameters(element)
      .sort((left, right) => left.t - right.t);
    for (const sample of samples) {
      const ordinary = shape(sample.t);
      const derivative = shapeDerivative(sample.t);
      const adjusted = edgeShape(element, sample.t);
      const xM = interpolate(element.x, ordinary);
      const yM = interpolate(element.y, ordinary) - verticalOffsetM;
      const dx = interpolate(element.x, derivative);
      const dy = interpolate(element.y, derivative);
      const jacobianM = Math.hypot(dx, dy);
      const [nx, ny] = component.outwardNormal(xM, yM, dx, dy);
      const rawSigma = elementsBySolution.map((solutionElements) =>
        interpolate(solutionElements[elementIndex].sigma, adjusted));
      if (
        !(jacobianM > 0) ||
        rawSigma.some((value) => !Number.isFinite(value))
      ) {
        throw new Error('The free-space mesh contains invalid element data.');
      }
      out.push({
        elementIndex,
        t: sample.t,
        xM,
        yM,
        nx,
        ny,
        weightM: sample.weight * jacobianM,
        rawSigma,
        component,
      });
    }
  }
  return out;
}

function currentNormalization(
  points: RawQuadraturePoint[],
  signalNames: string[],
): number[][] {
  const size = signalNames.length;
  const codeMatrix = zeroMatrix(size);
  const signalIndex = new Map(
    signalNames.map((name, index) => [name, index]),
  );
  for (const point of points) {
    if (point.component.role !== 'signal' || !point.component.solverName) {
      continue;
    }
    const measured = signalIndex.get(point.component.solverName);
    if (measured == null) {
      throw new Error(
        `The free-space mesh signal ${point.component.solverName} is not in the result.`,
      );
    }
    for (let drive = 0; drive < size; drive++) {
      codeMatrix[drive][measured] +=
        point.weightM * point.rawSigma[drive];
    }
  }
  return invert(transpose(codeMatrix));
}

function explicitActiveNormalization(
  points: RawQuadraturePoint[],
  activeSolverNames: readonly string[],
  activeNameByComponentKey: ReadonlyMap<string, string>,
): number[][] {
  const size = activeSolverNames.length;
  const codeMatrix = zeroMatrix(size);
  const activeIndex = new Map(
    activeSolverNames.map((name, index) => [name, index]),
  );
  for (const point of points) {
    const activeName = activeNameByComponentKey.get(point.component.key);
    if (!activeName) {
      throw new Error(
        `The explicit-reference mesh component ${point.component.id} has no active solver binding.`,
      );
    }
    const measured = activeIndex.get(activeName);
    if (measured == null) {
      throw new Error(
        `The explicit-reference mesh conductor ${activeName} is not in the active result.`,
      );
    }
    for (let drive = 0; drive < size; drive++) {
      codeMatrix[drive][measured] +=
        point.weightM * point.rawSigma[drive];
    }
  }
  return invert(transpose(codeMatrix));
}

function explicitGroundTerms(
  points: CurrentQuadraturePoint[],
  size: number,
): ReferencePlaneLossTerm[] {
  const byComponent = new Map<
    string,
    { component: SurfaceComponent; matrix: number[][] }
  >();
  for (const point of points) {
    if (point.component.role !== 'ground') continue;
    let entry = byComponent.get(point.component.key);
    if (!entry) {
      entry = {
        component: point.component,
        matrix: zeroMatrix(size),
      };
      byComponent.set(point.component.key, entry);
    }
    for (let row = 0; row < size; row++) {
      for (let column = 0; column < size; column++) {
        entry.matrix[row][column] +=
          point.weightM *
          point.currentAPerM[row] *
          point.currentAPerM[column];
      }
    }
  }
  return [...byComponent.values()].map(({ component, matrix }) => ({
    geometryPerM: sanitizeOverlap(matrix),
    conductivity: component.conductivity,
    thicknessM: component.thicknessM,
    label: component.id,
  }));
}

/**
 * Exact overlap of two unit-area Poisson kernels. Exported for a focused
 * normalization regression and for documenting the implicit-plane recovery.
 */
export function poissonKernelOverlapPerM(
  x1M: number,
  y1M: number,
  x2M: number,
  y2M: number,
): number {
  const height = y1M + y2M;
  const offset = x1M - x2M;
  if (!(height > 0)) return 0;
  return height / (Math.PI * (offset * offset + height * height));
}

function implicitBottomOverlap(
  points: CurrentQuadraturePoint[],
  size: number,
  toleranceM: number,
): number[][] {
  const sources = points.filter((point) => point.yM > toleranceM);
  if (sources.length === 0) {
    throw new Error('The free-space mesh has no sources above the bottom plane.');
  }
  const matrix = zeroMatrix(size);
  for (const target of sources) {
    const convolved = Array(size).fill(0);
    for (const source of sources) {
      const factor =
        source.weightM *
        poissonKernelOverlapPerM(
          target.xM,
          target.yM,
          source.xM,
          source.yM,
        );
      for (let column = 0; column < size; column++) {
        convolved[column] += factor * source.currentAPerM[column];
      }
    }
    for (let row = 0; row < size; row++) {
      const left = target.weightM * target.currentAPerM[row];
      for (let column = 0; column < size; column++) {
        matrix[row][column] += left * convolved[column];
      }
    }
  }
  return sanitizeOverlap(matrix);
}

function validateUnitCurrents(
  points: CurrentQuadraturePoint[],
  signalNames: string[],
): void {
  const size = signalNames.length;
  const integrated = zeroMatrix(size);
  const signalIndex = new Map(
    signalNames.map((name, index) => [name, index]),
  );
  for (const point of points) {
    const name = point.component.solverName;
    if (point.component.role !== 'signal' || !name) continue;
    const row = signalIndex.get(name);
    if (row == null) continue;
    for (let column = 0; column < size; column++) {
      integrated[row][column] +=
        point.weightM * point.currentAPerM[column];
    }
  }
  let maxError = 0;
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      maxError = Math.max(
        maxError,
        Math.abs(integrated[row][column] - (row === column ? 1 : 0)),
      );
    }
  }
  if (maxError > 2e-5) {
    throw new Error(
      `Free-space current normalization failed (${maxError.toExponential(2)} A).`,
    );
  }
}

function validateExplicitActiveUnitCurrents(
  points: CurrentQuadraturePoint[],
  activeSolverNames: readonly string[],
  activeNameByComponentKey: ReadonlyMap<string, string>,
): void {
  const size = activeSolverNames.length;
  const integrated = zeroMatrix(size);
  const activeIndex = new Map(
    activeSolverNames.map((name, index) => [name, index]),
  );
  for (const point of points) {
    const activeName = activeNameByComponentKey.get(point.component.key);
    const row = activeName == null ? undefined : activeIndex.get(activeName);
    if (row == null) {
      throw new Error(
        `The explicit-reference mesh component ${point.component.id} has no active solver binding.`,
      );
    }
    for (let column = 0; column < size; column++) {
      integrated[row][column] +=
        point.weightM * point.currentAPerM[column];
    }
  }
  let maxError = 0;
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      maxError = Math.max(
        maxError,
        Math.abs(integrated[row][column] - (row === column ? 1 : 0)),
      );
    }
  }
  if (maxError > 2e-5) {
    throw new Error(
      `Explicit-reference active-current normalization failed (${maxError.toExponential(2)} A).`,
    );
  }
}

function validateExplicitPhysicalCurrents(
  points: CurrentQuadraturePoint[],
  physicalSignalNames: readonly string[],
): void {
  const size = physicalSignalNames.length;
  const signalCurrents = zeroMatrix(size);
  const totalCurrents = Array(size).fill(0);
  const totalAbsoluteCurrents = Array(size).fill(0);
  for (const point of points) {
    for (let basis = 0; basis < size; basis++) {
      const current = point.weightM * point.currentAPerM[basis];
      totalCurrents[basis] += current;
      totalAbsoluteCurrents[basis] += Math.abs(current);
      if (
        point.component.role === 'signal' &&
        point.component.signalIndex != null
      ) {
        signalCurrents[point.component.signalIndex][basis] += current;
      }
    }
  }

  let identityError = 0;
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      identityError = Math.max(
        identityError,
        Math.abs(
          signalCurrents[row][column] - (row === column ? 1 : 0),
        ),
      );
    }
  }
  if (identityError > 5e-5) {
    throw new Error(
      `Explicit-reference physical signal normalization failed (${identityError.toExponential(2)} A).`,
    );
  }

  let closureError = 0;
  for (let basis = 0; basis < size; basis++) {
    closureError = Math.max(
      closureError,
      Math.abs(totalCurrents[basis]) /
        Math.max(1, totalAbsoluteCurrents[basis]),
    );
  }
  if (closureError > 5e-5) {
    throw new Error(
      `Explicit-reference conductor-current closure failed (${closureError.toExponential(2)} relative).`,
    );
  }
}

function buildGroundCurrentBasis(
  components: SurfaceComponent[],
  points: CurrentQuadraturePoint[],
  signalNames: string[],
  bottomPlane: GroundPlaneItem | null,
  toleranceM: number,
  domainXMinM: number,
  domainXMaxM: number,
): MeshGroundCurrentBasis {
  const size = signalNames.length;
  const surfaceEntries = new Map<
    string,
    {
      component: SurfaceComponent;
      elements: Map<number, MeshGroundCurrentSample[]>;
      netCurrentBasisA: number[];
    }
  >();
  for (const point of points) {
    if (point.component.role !== 'ground') continue;
    let entry = surfaceEntries.get(point.component.key);
    if (!entry) {
      entry = {
        component: point.component,
        elements: new Map(),
        netCurrentBasisA: Array(size).fill(0),
      };
      surfaceEntries.set(point.component.key, entry);
    }
    let samples = entry.elements.get(point.elementIndex);
    if (!samples) {
      samples = [];
      entry.elements.set(point.elementIndex, samples);
    }
    samples.push({
      t: point.t,
      xM: point.xM,
      yM: point.yM,
      nx: point.nx,
      ny: point.ny,
      weightM: point.weightM,
      currentBasisAPerM: [...point.currentAPerM],
    });
    for (let basis = 0; basis < size; basis++) {
      entry.netCurrentBasisA[basis] +=
        point.weightM * point.currentAPerM[basis];
    }
  }
  const surfaces = [...surfaceEntries.values()].map((entry) => ({
    key: entry.component.key,
    id: entry.component.id,
    label: entry.component.id,
    kind: entry.component.kind,
    elements: [...entry.elements.entries()]
      .sort(([left], [right]) => left - right)
      .map(([elementIndex, samples]) => ({
        elementIndex,
        samples: samples.sort((left, right) => left.t - right.t),
      })),
    netCurrentBasisA: entry.netCurrentBasisA,
  } satisfies MeshGroundCurrentSurface));

  const signals = components
    .filter(
      (component): component is SurfaceComponent & {
        solverName: string;
        signalIndex: number;
      } =>
        component.role === 'signal' &&
        component.solverName != null &&
        component.signalIndex != null,
    )
    .sort((left, right) => left.signalIndex - right.signalIndex)
    .map((component) => {
      const resultIndex = signalNames.indexOf(component.solverName);
      if (resultIndex < 0) {
        throw new Error(
          `The mesh signal ${component.solverName} is not in the solver result.`,
        );
      }
      return {
        id: component.id,
        solverName: component.solverName,
        centerM: component.centerM,
        widthM: component.widthM,
        resultIndex,
      };
    });

  let implicitBottom: MeshImplicitBottomCurrent | null = null;
  if (bottomPlane) {
    const sourcePoints = points.filter((point) => point.yM > toleranceM);
    if (sourcePoints.length === 0) {
      throw new Error('The free-space mesh has no sources above the bottom plane.');
    }
    const sources: MeshGroundCurrentSource[] = sourcePoints.map((point) => ({
      xM: point.xM,
      yM: point.yM,
      weightM: point.weightM,
      currentBasisAPerM: [...point.currentAPerM],
    }));
    const bottomNetCurrentBasisA = Array(size).fill(0);
    for (const source of sources) {
      for (let basis = 0; basis < size; basis++) {
        bottomNetCurrentBasisA[basis] -=
          source.weightM * source.currentBasisAPerM[basis];
      }
    }
    implicitBottom = {
      id: bottomPlane.id,
      label: bottomPlane.id,
      yM: 0,
      xMinM: domainXMinM,
      xMaxM: domainXMaxM,
      sources,
      netCurrentBasisA: bottomNetCurrentBasisA,
    };
  }

  return {
    signalNames: [...signalNames],
    signals,
    surfaces,
    implicitBottom,
  };
}

function excitationMode(driveCurrentsA: readonly number[]): {
  mode: string;
  normalizationLabel: string;
} {
  const scale = Math.max(MIN_POSITIVE, ...driveCurrentsA.map(Math.abs));
  const active = driveCurrentsA.filter(
    (current) => Math.abs(current) > scale * 1e-12,
  );
  if (active.length === 1) {
    const amplitude = Math.abs(active[0]);
    return {
      mode: 'single-ended',
      normalizationLabel:
        Math.abs(amplitude - 1) <= 1e-12
          ? '1 A signal current'
          : `${amplitude.toPrecision(6)} A signal current`,
    };
  }
  if (
    active.length === 2 &&
    Math.abs(active[0] + active[1]) <= scale * 1e-12 &&
    Math.abs(Math.abs(active[0]) - Math.abs(active[1])) <= scale * 1e-12
  ) {
    const amplitude = Math.abs(active[0]);
    return {
      mode: 'differential odd mode',
      normalizationLabel:
        Math.abs(amplitude - 1) <= 1e-12
          ? '1 A differential current (I+ = +1 A, I- = -1 A)'
          : `${amplitude.toPrecision(6)} A differential current per conductor`,
    };
  }
  return {
    mode: 'custom excitation',
    normalizationLabel: 'Specified signal currents',
  };
}

function dot(left: readonly number[], right: readonly number[]): number {
  return left.reduce(
    (sum, value, index) => sum + value * (right[index] ?? 0),
    0,
  );
}

function implicitBottomSampleAxis(
  basis: MeshGroundCurrentBasis,
  implicitBottom: MeshImplicitBottomCurrent,
): number[] {
  const { xMinM, xMaxM, sources } = implicitBottom;
  const count = 501;
  const values = Array.from(
    { length: count },
    (_, index) => xMinM + ((xMaxM - xMinM) * index) / (count - 1),
  );
  values.push(
    ...basis.signals.flatMap((signal) => [
      signal.centerM - signal.widthM / 2,
      signal.centerM,
      signal.centerM + signal.widthM / 2,
    ]),
    ...sources.map((source) => source.xM),
  );
  values.sort((left, right) => left - right);
  const tolerance = Math.max(MIN_POSITIVE, (xMaxM - xMinM) * 1e-12);
  return values.filter(
    (value, index) =>
      value >= xMinM &&
      value <= xMaxM &&
      (index === 0 || Math.abs(value - values[index - 1]) > tolerance),
  );
}

/**
 * Evaluate signed displayed return current for a chosen current excitation.
 * Input currents use native solver/result order. Magnitude normalization is a
 * renderer concern so differential sign changes remain intact here.
 */
export function meshGroundCurrentDistribution(
  basis: MeshGroundCurrentBasis,
  driveCurrentsA: readonly number[],
): GroundCurrentDistribution {
  if (
    driveCurrentsA.length !== basis.signalNames.length ||
    driveCurrentsA.some((current) => !Number.isFinite(current))
  ) {
    throw new Error('Mesh-current excitation does not match the solver signals.');
  }
  const implicitBottom = basis.implicitBottom;
  const xM = implicitBottom
    ? implicitBottomSampleAxis(basis, implicitBottom)
    : [];
  const bottomDensity = implicitBottom
    ? xM.map((x) => {
      let physicalCurrentAPerM = 0;
      for (const source of implicitBottom.sources) {
        physicalCurrentAPerM -=
          source.weightM *
          dot(source.currentBasisAPerM, driveCurrentsA) *
          poissonKernelOverlapPerM(
            x,
            implicitBottom.yM,
            source.xM,
            source.yM,
          );
      }
      return -physicalCurrentAPerM;
    })
    : [];
  const excitation = excitationMode(driveCurrentsA);
  return {
    ...excitation,
    xM,
    planes: implicitBottom
      ? [{
        id: 'bottom',
        label: implicitBottom.label,
        netCurrentA: -dot(
          implicitBottom.netCurrentBasisA,
          driveCurrentsA,
        ),
        densityAPerM: bottomDensity,
      }]
      : [],
    surfaces: basis.surfaces.map((surface) => ({
      id: surface.id,
      label: surface.label,
      netCurrentA: -dot(surface.netCurrentBasisA, driveCurrentsA),
      elements: surface.elements.map((element) => ({
        samples: element.samples.map((sample) => ({
          xM: sample.xM,
          yM: sample.yM,
          nx: sample.nx,
          ny: sample.ny,
          densityAPerM: -dot(sample.currentBasisAPerM, driveCurrentsA),
        })),
      })),
    })),
    signals: basis.signals.map((signal) => ({
      centerM: signal.centerM,
      widthM: signal.widthM,
      currentA: driveCurrentsA[signal.resultIndex],
      label: signal.solverName,
    })),
  };
}

/**
 * Clone a stackup onto the identical conductor mesh with every dielectric
 * replaced by air. The final field output of this ordinary MMTL solve is the
 * free-space basis needed by meshReferencePlaneLossModel().
 */
export function freeSpaceStackup(stackup: Stackup): Stackup {
  const items = stackup.items.map((item): StackupItem => {
    if (item.kind === 'DielectricLayer') {
      return { ...item, permittivity: 1, lossTangent: 0 };
    }
    if (
      item.kind === 'RectangleDielectric' ||
      item.kind === 'TrapezoidDielectric' ||
      item.kind === 'CircleDielectric'
    ) {
      return { ...item, permittivity: 1, lossTangent: 0 };
    }
    return { ...item };
  });
  return { ...stackup, title: `${stackup.title}-free-space`, items };
}

/**
 * Clone a stackup with a finer conductor mesh for auxiliary current solves.
 * Dielectric segmentation and all physical geometry remain unchanged.
 */
export function refineConductorMesh(
  stackup: Stackup,
  multiplier = CPW_RETURN_CURRENT_MESH_MULTIPLIER,
): Stackup {
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    throw new Error('The conductor-mesh refinement multiplier must be positive.');
  }
  return {
    ...stackup,
    cseg: stackup.cseg * multiplier,
    items: stackup.items.map((item) => ({ ...item })),
  };
}

/**
 * Analyze the normalized longitudinal-current basis and multi-material loss
 * geometry from one all-air solve of the same conductor mesh.
 */
export function meshReferenceAnalysis(
  stackup: Stackup,
  freeSpaceOutput: SolveOutput,
): MeshReferenceAnalysis {
  const result = freeSpaceOutput.result;
  if (
    !freeSpaceOutput.ok ||
    !result ||
    !freeSpaceOutput.fieldText ||
    result.nSignals < 1 ||
    result.names.length !== result.nSignals
  ) {
    throw new Error('The free-space solve did not return a complete current basis.');
  }
  const {
    components,
    bottomPlane,
    unitScaleM,
    geometryScaleM,
    domainXMinM,
    domainXMaxM,
  } = placedComponents(stackup);
  if (!bottomPlane) {
    throw new Error('A bottom ground plane is required for mesh loss.');
  }
  const toleranceM = Math.max(1e-12, geometryScaleM * 3e-6);
  const parsed = parseFieldPlot(freeSpaceOutput.fieldText);
  const byName = new Map(parsed.map((solution) => [solution.line, solution]));
  const solutions = result.names.map((name) => byName.get(name));
  if (solutions.some((solution) => !solution)) {
    throw new Error('The free-space field data is missing a signal basis.');
  }
  const elementsBySolution = (solutions as FieldSolution[]).map(
    conductorElements,
  );
  if (elementsBySolution[0].length === 0) {
    throw new Error('The free-space field data has no conductor mesh.');
  }
  for (let index = 1; index < elementsBySolution.length; index++) {
    validateSolutionGeometry(
      elementsBySolution[0],
      elementsBySolution[index],
      toleranceM,
    );
  }

  const rawPoints = rawQuadrature(
    elementsBySolution,
    components,
    toleranceM,
  );
  const normalization = currentNormalization(rawPoints, result.names);
  const currentPoints: CurrentQuadraturePoint[] = rawPoints.map((point) => ({
    ...point,
    currentAPerM: multiplyRowByMatrix(point.rawSigma, normalization),
  }));
  validateUnitCurrents(currentPoints, result.names);

  const terms = explicitGroundTerms(currentPoints, result.nSignals);
  terms.push({
    geometryPerM: implicitBottomOverlap(
      currentPoints,
      result.nSignals,
      toleranceM,
    ),
    conductivity: planeConductivity(bottomPlane),
    thicknessM: planeThicknessM(bottomPlane, unitScaleM),
    label: bottomPlane.id,
  });
  const aggregate = zeroMatrix(result.nSignals);
  for (const term of terms) addMatrix(aggregate, term.geometryPerM);
  const first = terms[0];
  const lossModel: ReferencePlaneLossModel = {
    geometryPerM: sanitizeOverlap(aggregate),
    conductivity: first.conductivity,
    thicknessM: first.thicknessM,
    terms,
    source: 'mesh',
  };
  return {
    lossModel,
    currentBasis: buildGroundCurrentBasis(
      components,
      currentPoints,
      result.names,
      bottomPlane,
      toleranceM,
      domainXMinM,
      domainXMaxM,
    ),
  };
}

/**
 * Analyze an explicit-only physical stackup through an all-active adapter.
 * The adapter's guard plane is a numerical boundary only: its vertical shift
 * is removed before geometry matching, and no implicit-plane loss or display
 * data is emitted.
 */
export function meshExplicitReferenceAnalysis(
  physicalStackup: Stackup,
  freeSpaceOutput: SolveOutput,
  preparation: ExplicitReferencePreparation,
  reduction: ExplicitReferenceReduction,
): MeshReferenceAnalysis {
  const activeResult = freeSpaceOutput.result;
  if (
    !freeSpaceOutput.ok ||
    !activeResult ||
    !freeSpaceOutput.fieldText ||
    activeResult.nSignals < 1 ||
    activeResult.names.length !== activeResult.nSignals
  ) {
    throw new Error(
      'The explicit-reference free-space solve did not return a complete active-conductor basis.',
    );
  }
  if (!Number.isFinite(preparation.verticalOffsetM)) {
    throw new Error('The explicit-reference vertical offset is invalid.');
  }

  const activeSolverNames = preparation.members.map(
    (member) => member.internalSolverName,
  );
  if (
    activeResult.nSignals !== activeSolverNames.length ||
    activeResult.names.some((name) => !activeSolverNames.includes(name)) ||
    activeSolverNames.some((name) => !activeResult.names.includes(name))
  ) {
    throw new Error(
      'The explicit-reference field result does not match the adapter active conductors.',
    );
  }
  const physicalSignalNames = [...preparation.signalNames];
  if (
    physicalSignalNames.length < 1 ||
    reduction.result.nSignals !== physicalSignalNames.length ||
    reduction.result.names.length !== physicalSignalNames.length ||
    reduction.result.names.some(
      (name, index) => name !== physicalSignalNames[index],
    )
  ) {
    throw new Error(
      'The explicit-reference reduced result does not preserve physical signal order.',
    );
  }
  if (
    reduction.currentTransform.length !== activeSolverNames.length ||
    reduction.currentTransform.some(
      (row) =>
        row.length !== physicalSignalNames.length ||
        row.some((value) => !Number.isFinite(value)),
    )
  ) {
    throw new Error(
      'The explicit-reference current transform has incompatible dimensions.',
    );
  }
  const currentTransform = reduction.currentTransform.map((row) => [...row]);

  const {
    components,
    bottomPlane,
    geometryScaleM,
    domainXMinM,
    domainXMaxM,
  } = placedComponents(physicalStackup);
  if (bottomPlane) {
    throw new Error(
      'Explicit-reference mesh analysis requires physical return conductors rather than an implicit ground plane.',
    );
  }
  const activeNameByComponentKey = bindExplicitReferenceComponents(
    components,
    preparation,
  );
  // The legacy field-plot writer rounds translated coordinates more coarsely
  // than the ordinary near-origin solve. Allow for that text serialization
  // error after removing the remote-plane offset without relaxing the native
  // plane-backed matcher above.
  const toleranceM = Math.max(1e-12, geometryScaleM * 1e-5);
  const parsed = parseFieldPlot(freeSpaceOutput.fieldText);
  const byName = new Map(parsed.map((solution) => [solution.line, solution]));
  const solutions = activeSolverNames.map((name) => byName.get(name));
  if (solutions.some((solution) => !solution)) {
    throw new Error(
      'The explicit-reference field data is missing an active conductor basis.',
    );
  }
  const elementsBySolution = (solutions as FieldSolution[]).map(
    conductorElements,
  );
  if (elementsBySolution[0].length === 0) {
    throw new Error(
      'The explicit-reference field data has no conductor mesh.',
    );
  }
  for (let index = 1; index < elementsBySolution.length; index++) {
    validateSolutionGeometry(
      elementsBySolution[0],
      elementsBySolution[index],
      toleranceM,
    );
  }

  const rawPoints = rawQuadrature(
    elementsBySolution,
    components,
    toleranceM,
    preparation.verticalOffsetM,
  );
  const activeNormalization = explicitActiveNormalization(
    rawPoints,
    activeSolverNames,
    activeNameByComponentKey,
  );
  const activePoints: CurrentQuadraturePoint[] = rawPoints.map((point) => ({
    ...point,
    currentAPerM: multiplyRowByMatrix(
      point.rawSigma,
      activeNormalization,
    ),
  }));
  validateExplicitActiveUnitCurrents(
    activePoints,
    activeSolverNames,
    activeNameByComponentKey,
  );

  const physicalPoints: CurrentQuadraturePoint[] = activePoints.map(
    (point) => ({
      ...point,
      currentAPerM: multiplyRowByMatrix(
        point.currentAPerM,
        currentTransform,
      ),
    }),
  );
  validateExplicitPhysicalCurrents(physicalPoints, physicalSignalNames);

  const terms = explicitGroundTerms(
    physicalPoints,
    physicalSignalNames.length,
  );
  if (terms.length === 0) {
    throw new Error(
      'The explicit-reference physical stackup has no return-conductor mesh.',
    );
  }
  const aggregate = zeroMatrix(physicalSignalNames.length);
  for (const term of terms) addMatrix(aggregate, term.geometryPerM);
  const first = terms[0];
  const lossModel: ReferencePlaneLossModel = {
    geometryPerM: sanitizeOverlap(aggregate),
    conductivity: first.conductivity,
    thicknessM: first.thicknessM,
    terms,
    source: 'mesh',
  };
  return {
    lossModel,
    currentBasis: buildGroundCurrentBasis(
      components,
      physicalPoints,
      physicalSignalNames,
      null,
      toleranceM,
      domainXMinM,
      domainXMaxM,
    ),
  };
}

/** Backward-compatible loss-only wrapper. */
export function meshReferencePlaneLossModel(
  stackup: Stackup,
  freeSpaceOutput: SolveOutput,
): ReferencePlaneLossModel {
  return meshReferenceAnalysis(stackup, freeSpaceOutput).lossModel;
}
