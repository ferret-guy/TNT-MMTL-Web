import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MMTL_SPEED_OF_LIGHT_M_PER_S,
  prepareExplicitReferenceStackup,
  reduceExplicitReferenceResults,
} from '../../src/analysis/explicitReference.ts';
import {
  transformExplicitReferenceFieldText,
} from '../../src/analysis/explicitReferenceField.ts';
import { UNIT_SCALE } from '../../src/analysis/losses.ts';
import { computeGrid } from '../../src/field/potential.ts';
import { parseFieldPlot } from '../../src/solver/parseFieldPlot.mjs';
import { parseResult } from '../../src/solver/parseResult.mjs';
import { generateXsctn } from '../../src/xsctn/generate.ts';

const createBemModule = (
  await import(new URL('../../public/wasm/bem.mjs', import.meta.url).href)
).default;

function explicitCircularReferenceStackup(cseg = 24) {
  return {
    title: 'explicit circular returns in air',
    units: 'mils',
    couplingLengthM: 0.0254,
    riseTimePs: 100,
    cseg,
    dseg: 12,
    items: [
      {
        kind: 'CircleConductors',
        id: 'round-return',
        isGround: true,
        conductivity: 2.5e7,
        number: 2,
        pitch: 40,
        xOffset: 0,
        yOffset: 20,
        diameter: 8,
      },
      {
        kind: 'CircleConductors',
        id: 'signal',
        isGround: false,
        conductivity: 5e7,
        number: 1,
        pitch: 0,
        xOffset: 20,
        yOffset: 20,
        diameter: 8,
      },
    ],
  };
}

async function solve(stackup) {
  const stdout = [];
  const mod = await createBemModule({
    print: (line) => stdout.push(line),
    printErr: (line) => stdout.push(line),
  });
  mod.FS.mkdir('/work');
  mod.FS.writeFile('/work/case.xsctn', generateXsctn(stackup));
  mod.FS.chdir('/work');
  let exitCode = 0;
  try {
    exitCode = mod.callMain([
      '/work/case',
      String(stackup.cseg),
      String(stackup.dseg),
    ]);
  } catch (error) {
    exitCode = error?.status ?? 1;
  }
  let resultText = null;
  let fieldText = null;
  try {
    resultText = mod.FS.readFile('/work/case.result', { encoding: 'utf8' });
  } catch {}
  try {
    fieldText = mod.FS.readFile(
      '/work/case.result_field_plot_data',
      { encoding: 'utf8' },
    );
  } catch {}
  return {
    ok: stdout.join('\n').includes('MMTL is done'),
    exitCode,
    stdout: stdout.join('\n'),
    resultText,
    fieldText,
    elapsedMs: 0,
    result: resultText ? parseResult(resultText) : null,
  };
}

function reorderMatrix(matrix, memberNames, resultNames) {
  const order = resultNames.map((name) => memberNames.indexOf(name));
  assert.ok(order.every((index) => index >= 0));
  return order.map((row) => order.map((column) => matrix[row][column]));
}

function fakeFullActiveResult(names, capacitance) {
  const count = names.length;
  return {
    nSignals: count,
    names: [...names],
    B: capacitance.map((row) => [...row]),
    L: Array.from({ length: count }, (_, row) =>
      Array.from({ length: count }, (_, column) => row === column ? 1 : 0)),
    Rdc: Array.from({ length: count }, (_, row) =>
      Array.from({ length: count }, (_, column) => row === column ? 1 : 0)),
    z0: Array(count).fill(1),
    epsEff: Array(count).fill(1),
    velocity: Array(count).fill(MMTL_SPEED_OF_LIGHT_M_PER_S),
    delay: Array(count).fill(1 / MMTL_SPEED_OF_LIGHT_M_PER_S),
    fxt: [],
    bxt: [],
    couplingLengthM: 0.0254,
    riseTimePs: 100,
    warnings: [],
  };
}

function rawFieldText(solutionNames, elements, sigmaBySolution) {
  const lines = [];
  for (let solution = 0; solution < solutionNames.length; solution++) {
    lines.push('Start Solution Output:');
    lines.push(`Active Line: ::${solutionNames[solution]}`);
    lines.push('');
    for (let element = 0; element < elements.length; element++) {
      lines.push('Element Type: Conductor');
      lines.push(`X Points: ${elements[element].x.join(' ')}`);
      lines.push(`Y Points: ${elements[element].y.join(' ')}`);
      lines.push(`Charge Values: ${Array(3).fill(sigmaBySolution[solution][element]).join(' ')}`);
      lines.push('');
    }
    lines.push('End Solution Output:');
  }
  return `${lines.join('\n')}\n`;
}

function assertNear(actual, expected, label, tolerance) {
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} != ${expected} (tol ${tolerance})`,
  );
}

test('explicit field transform maps active lines by name despite reversed solution and contour order', () => {
  const stackup = explicitCircularReferenceStackup(16);
  const preparation = prepareExplicitReferenceStackup(stackup);
  const memberNames = preparation.members.map(
    (member) => member.internalSolverName,
  );
  const resultNames = [memberNames[2], memberNames[1], memberNames[0]];
  const memberCapacitance = [
    [5, -1, -3],
    [-1, 5, -3],
    [-3, -3, 8],
  ];
  const reordered = reorderMatrix(
    memberCapacitance,
    memberNames,
    resultNames,
  );
  const result = fakeFullActiveResult(resultNames, reordered);
  const reduction = reduceExplicitReferenceResults(
    preparation,
    result,
    result,
  );
  const mil = UNIT_SCALE.mils;
  const dy = preparation.verticalOffsetM;
  // Deliberately use solver-native contour order: signal, right ground, left
  // ground. It does not match the preparation's physical-member order.
  const elements = [
    { x: [20, 24, 28].map((x) => x * mil), y: [20, 28, 20].map((y) => y * mil + dy) },
    { x: [40, 44, 48].map((x) => x * mil), y: [20, 28, 20].map((y) => y * mil + dy) },
    { x: [0, 4, 8].map((x) => x * mil), y: [20, 28, 20].map((y) => y * mil + dy) },
  ];
  // Raw solution order is signal, right ground, left ground. With the known
  // C matrix the physical excitation coefficients in member order are
  // [-0.5, -0.5, +0.5], so name-based reordering is observable here.
  const source = rawFieldText(
    resultNames,
    elements,
    [
      [31, 11, 17],
      [7, 5, 4],
      [3, 1, 6],
    ],
  );

  const transformedText = transformExplicitReferenceFieldText(
    source,
    preparation,
    reduction,
  );
  const transformed = parseFieldPlot(transformedText);

  assert.equal(transformed.length, 1);
  assert.equal(transformed[0].line, preparation.signalNames[0]);
  assert.equal(transformed[0].calibrationMode, 'isolated');
  assertNear(
    transformed[0].imagePlaneYM,
    -preparation.verticalOffsetM,
    'translated image plane',
    1e-15,
  );
  assert.equal(transformed[0].elements.length, 3);
  assert.deepEqual(
    transformed[0].elements.map((element) =>
      Math.round(element.x[1] / mil)),
    [24, 44, 4],
  );
  assert.deepEqual(
    transformed[0].elements.map((element) => element.sigma[0]),
    [10.5, 2.5, 3.5],
  );
  for (const element of transformed[0].elements) {
    assert.deepEqual(
      element.y.map((y) => Math.round(y / mil)),
      [20, 28, 20],
    );
  }
  assert.ok(!transformedText.includes('__explicit_reference_plane'));
  assert.ok(!transformedText.includes(resultNames[1]));
  assert.ok(!transformedText.includes(resultNames[2]));
});

test('native explicit-reference potential grid uses physical coordinates and 0 V / 1 V boundaries', async () => {
  const stackup = explicitCircularReferenceStackup();
  const preparation = prepareExplicitReferenceStackup(stackup);
  const raw = await solve(preparation.solverStackup);
  assert.ok(raw.ok, raw.stdout);
  assert.ok(raw.result);
  assert.ok(raw.fieldText);
  const reduction = reduceExplicitReferenceResults(
    preparation,
    raw.result,
    raw.result,
  );
  const transformedText = transformExplicitReferenceFieldText(
    raw.fieldText,
    preparation,
    reduction,
  );
  const rawSolutions = parseFieldPlot(raw.fieldText);
  const solutions = parseFieldPlot(transformedText);

  assert.equal(rawSolutions.length, preparation.members.length);
  assert.notDeepEqual(
    rawSolutions.map((solution) => solution.line),
    preparation.members.map((member) => member.internalSolverName),
    'fixture must exercise native non-member solution ordering',
  );
  assert.equal(solutions.length, 1);
  const solution = solutions[0];
  assert.equal(solution.line, preparation.signalNames[0]);
  assert.equal(solution.calibrationMode, 'isolated');
  assertNear(
    solution.imagePlaneYM,
    -preparation.verticalOffsetM,
    'physical-coordinate image plane',
    1e-15,
  );

  const mil = UNIT_SCALE.mils;
  const allX = solution.elements.flatMap((element) => element.x);
  const allY = solution.elements.flatMap((element) => element.y);
  assert.ok(allX.every(Number.isFinite));
  assert.ok(allY.every(Number.isFinite));
  assert.ok(Math.min(...allX) >= -1e-8 * mil);
  assert.ok(Math.max(...allX) <= 48.000001 * mil);
  assert.ok(Math.min(...allY) >= 19.999999 * mil);
  assert.ok(Math.max(...allY) <= 28.000001 * mil);

  const bbox = {
    x0: -4 * mil,
    y0: 16 * mil,
    x1: 52 * mil,
    y1: 32 * mil,
  };
  assert.ok(
    solution.imagePlaneYM < bbox.y0 - 10 * (bbox.y1 - bbox.y0),
    'remote numerical image plane entered the physical field viewport',
  );
  const nx = 57;
  const ny = 17;
  const grid = computeGrid(
    solution,
    bbox,
    nx,
    ny,
    [],
    [],
  );

  assert.equal(grid.nx, nx);
  assert.equal(grid.ny, ny);
  assert.equal(grid.phi.length, nx * ny);
  assert.ok([...grid.phi].every(Number.isFinite));
  assert.ok(Number.isFinite(grid.phiMin));
  assert.ok(Number.isFinite(grid.phiMax));
  assert.ok(Number.isFinite(grid.maxResidual));
  const atMils = (x, y) => grid.phi[(y - 16) * nx + (x + 4)];
  const groundLeft = atMils(4, 24);
  const signal = atMils(24, 24);
  const groundRight = atMils(44, 24);
  assertNear(groundLeft, 0, 'left ground potential', 0.025);
  assertNear(groundRight, 0, 'right ground potential', 0.025);
  assertNear(signal, 1, 'signal potential', 0.025);
  assertNear(
    signal - (groundLeft + groundRight) / 2,
    1,
    'signal-to-ground voltage',
    0.025,
  );
  assertNear(
    groundLeft,
    groundRight,
    'explicit grounds are equipotential',
    0.02,
  );
  assert.ok(grid.maxResidual < 0.05);
});
