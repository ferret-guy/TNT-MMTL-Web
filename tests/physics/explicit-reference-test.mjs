import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXPLICIT_REFERENCE_CLEARANCE_MULTIPLIER,
  MMTL_SPEED_OF_LIGHT_M_PER_S,
  chargeNeutralProjection,
  exposeExplicitReferenceSolveOutput,
  isExplicitReferenceStackup,
  isFloatingPairStackup,
  prepareExplicitReferenceStackup,
  reduceExplicitReferenceResults,
} from '../../src/analysis/explicitReference.ts';
import { calculateMmtlCrosstalk } from '../../src/analysis/crosstalk.ts';
import {
  transformExplicitReferenceFieldText,
} from '../../src/analysis/explicitReferenceField.ts';
import { UNIT_SCALE } from '../../src/analysis/losses.ts';
import {
  freeSpaceStackup,
  meshExplicitReferenceAnalysis,
  meshGroundCurrentDistribution,
} from '../../src/analysis/meshReferenceLoss.ts';
import { parseFieldPlot } from '../../src/solver/parseFieldPlot.mjs';
import { parseResult } from '../../src/solver/parseResult.mjs';
import {
  generateXsctn,
  solverSignalBindings,
  validateStackup,
} from '../../src/xsctn/generate.ts';

const createBemModule = (
  await import(new URL('../../public/wasm/bem.mjs', import.meta.url).href)
).default;

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

function explicitCircularReferenceStackup() {
  return {
    title: 'explicit circular returns in air',
    units: 'mils',
    couplingLengthM: 0.0254,
    riseTimePs: 100,
    cseg: 32,
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

function isolatedTwoWireStackup() {
  return {
    title: 'isolated two-wire line in air',
    units: 'mils',
    couplingLengthM: 0.0254,
    riseTimePs: 100,
    cseg: 48,
    dseg: 12,
    items: [
      {
        kind: 'CircleConductors',
        id: 'return',
        isGround: true,
        conductivity: 5e7,
        number: 1,
        pitch: 0,
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
        xOffset: 24,
        yOffset: 20,
        diameter: 8,
      },
    ],
  };
}

function floatingTwoWireStackup() {
  return {
    title: 'floating two-wire line in air',
    units: 'mils',
    couplingLengthM: 0.0254,
    riseTimePs: 100,
    cseg: 48,
    dseg: 12,
    items: [
      {
        kind: 'CircleConductors',
        id: 'pair',
        isGround: false,
        conductivity: 5e7,
        number: 2,
        pitch: 24,
        xOffset: 0,
        yOffset: 20,
        diameter: 8,
      },
    ],
  };
}

function splitFloatingTwoWireStackup(reverse = false) {
  const member = (id, xOffset) => ({
    kind: 'CircleConductors',
    id,
    isGround: false,
    conductivity: 5e7,
    number: 1,
    pitch: 0,
    xOffset,
    yOffset: 20,
    diameter: 8,
  });
  const left = member('left', 0);
  const right = member('right', 24);
  return {
    ...floatingTwoWireStackup(),
    title: reverse ? 'right-to-left floating pair' : 'left-to-right floating pair',
    items: reverse ? [right, left] : [left, right],
  };
}

/** Exact explicit-ground geometry shared from the Belden 9R280 example. */
function explicitRibbonCableStackup() {
  return {
    title: 'Belden 9R280 G-S-G ribbon approximation',
    units: 'mils',
    couplingLengthM: 1,
    riseTimePs: 100,
    cseg: 45,
    dseg: 45,
    items: [
      {
        kind: 'RectangleDielectric',
        id: 'PVC',
        width: 700,
        height: 36,
        permittivity: 2.89,
        lossTangent: 0.025,
        xOffset: 0,
        yOffset: 0,
      },
      {
        kind: 'CircleConductors',
        id: 'GND',
        isGround: true,
        conductivity: 5e7,
        number: 2,
        pitch: 100,
        xOffset: 268.385,
        yOffset: 11.385,
        diameter: 13.23,
      },
      {
        kind: 'CircleConductors',
        id: 'SIG',
        isGround: false,
        conductivity: 5e7,
        number: 1,
        pitch: 0,
        xOffset: 318.385,
        yOffset: 11.385,
        diameter: 13.23,
      },
    ],
  };
}

function assertNear(actual, expected, label, rel = 1e-10) {
  const tolerance = Math.max(1e-14, Math.abs(expected) * rel);
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} != ${expected} (tol ${tolerance})`,
  );
}

function assertMatrixNear(actual, expected, label, rel = 1e-10) {
  assert.equal(actual.length, expected.length, `${label} row count`);
  for (let row = 0; row < expected.length; row++) {
    assert.equal(
      actual[row].length,
      expected[row].length,
      `${label} column count row ${row}`,
    );
    for (let column = 0; column < expected[row].length; column++) {
      assertNear(
        actual[row][column],
        expected[row][column],
        `${label}[${row}][${column}]`,
        rel,
      );
    }
  }
}

function reorderMatrix(matrix, memberNames, resultNames) {
  const order = resultNames.map((name) => memberNames.indexOf(name));
  assert.ok(order.every((index) => index >= 0));
  return order.map((row) => order.map((column) => matrix[row][column]));
}

function fakeFullActiveResult(names, capacitance, resistance) {
  const count = names.length;
  return {
    nSignals: count,
    names: [...names],
    B: capacitance.map((row) => [...row]),
    L: Array.from({ length: count }, (_, row) =>
      Array.from({ length: count }, (_, column) => row === column ? 1 : 0)),
    Rdc: resistance.map((row) => [...row]),
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

function explicitSurfaceEnergy(surface, size) {
  const matrix = Array.from({ length: size }, () => Array(size).fill(0));
  for (const element of surface.elements) {
    for (let sampleIndex = 0; sampleIndex < element.samples.length; sampleIndex++) {
      const sample = element.samples[sampleIndex];
      if (sampleIndex > 0) {
        assert.ok(sample.t > element.samples[sampleIndex - 1].t);
      }
      assert.ok(Math.abs(Math.hypot(sample.nx, sample.ny) - 1) < 1e-12);
      for (let row = 0; row < size; row++) {
        for (let column = 0; column < size; column++) {
          matrix[row][column] +=
            sample.weightM *
            sample.currentBasisAPerM[row] *
            sample.currentBasisAPerM[column];
        }
      }
    }
  }
  return matrix;
}

test('explicit-reference adapter preserves physical identity and coordinates', () => {
  const stackup = explicitCircularReferenceStackup();
  const snapshot = structuredClone(stackup);

  assert.deepEqual(validateStackup(stackup), []);
  assert.equal(isExplicitReferenceStackup(stackup), true);
  assert.equal(
    stackup.items.some((item) => item.kind === 'GroundPlane'),
    false,
  );
  assert.equal(
    stackup.items.some((item) => item.kind.includes('Dielectric')),
    false,
  );

  const preparation = prepareExplicitReferenceStackup(stackup);

  assert.deepEqual(stackup, snapshot);
  assert.notEqual(preparation.solverStackup, stackup);
  assert.equal(preparation.members.length, 3);
  assert.deepEqual(preparation.signalMemberIndices, [2]);
  assert.deepEqual(
    preparation.signalNames,
    solverSignalBindings(stackup).map((binding) => binding.solverName),
  );
  assert.deepEqual(
    preparation.members.map((member) => member.role),
    ['ground', 'ground', 'signal'],
  );
  assert.deepEqual(
    preparation.members.map((member) => member.originalMemberName),
    ['round-return[1]', 'round-return[2]', 'signal'],
  );
  assert.deepEqual(
    preparation.members.map((member) => member.originalMemberIndex),
    [0, 1, 0],
  );
  assert.equal(preparation.members[2].originalSignalIndex, 0);
  assert.equal(
    preparation.members[2].originalSignalName,
    preparation.signalNames[0],
  );
  assert.equal(preparation.members[0].groundId, 'round-return');
  assert.equal(preparation.members[1].groundMemberIndex, 1);
  assert.equal(
    new Set(preparation.members.map((member) => member.internalSolverName)).size,
    3,
  );

  const spanMils = 48;
  const clearanceMils =
    EXPLICIT_REFERENCE_CLEARANCE_MULTIPLIER * spanMils;
  assertNear(
    preparation.clearanceM,
    clearanceMils * UNIT_SCALE.mils,
    'remote-plane clearance',
  );
  assertNear(
    preparation.verticalOffsetM,
    (clearanceMils - 20) * UNIT_SCALE.mils,
    'solver-to-physical vertical offset',
  );
  assert.ok(
    preparation.members.every(
      (member) => member.verticalOffsetM === preparation.verticalOffsetM,
    ),
  );

  const [guardPlane, airLayer, ...activeConductors] =
    preparation.solverStackup.items;
  assert.equal(guardPlane.kind, 'GroundPlane');
  assert.equal(guardPlane.id, '__explicit_reference_plane');
  assert.equal(airLayer.kind, 'DielectricLayer');
  assert.equal(airLayer.permittivity, 1);
  assert.equal(airLayer.lossTangent, 0);
  assertNear(
    airLayer.thickness * UNIT_SCALE.mils,
    preparation.verticalOffsetM,
    'solver coordinate translation',
  );
  assertNear(
    (airLayer.thickness + 20) * UNIT_SCALE.mils,
    preparation.clearanceM,
    'lowest physical contour clearance',
  );
  assert.equal(activeConductors.length, stackup.items.length);
  for (let index = 0; index < activeConductors.length; index++) {
    const solverItem = activeConductors[index];
    const physicalItem = stackup.items[index];
    assert.notEqual(solverItem, physicalItem);
    assert.equal(solverItem.kind, physicalItem.kind);
    assert.equal(solverItem.id, physicalItem.id);
    assert.equal(solverItem.isGround, false);
    assert.equal(solverItem.xOffset, physicalItem.xOffset);
    assert.equal(solverItem.yOffset, physicalItem.yOffset);
    assertNear(
      (
        airLayer.thickness + solverItem.yOffset - physicalItem.yOffset
      ) * UNIT_SCALE.mils,
      preparation.verticalOffsetM,
      `member-set ${index} vertical translation`,
    );
  }
});

test('only an exact unreferenced two-member signal set is a floating pair', () => {
  const pair = floatingTwoWireStackup();
  const snapshot = structuredClone(pair);

  assert.deepEqual(validateStackup(pair), []);
  assert.equal(isFloatingPairStackup(pair), true);
  assert.equal(isExplicitReferenceStackup(pair), true);

  const preparation = prepareExplicitReferenceStackup(pair);
  assert.equal(preparation.floatingPair, true);
  assert.deepEqual(preparation.signalMemberIndices, [0]);
  const originalNames = solverSignalBindings(pair).map(
    (binding) => binding.solverName,
  );
  assert.deepEqual(preparation.signalNames, [originalNames[0]]);
  assert.deepEqual(preparation.floatingPairSignalNames, originalNames);
  assert.deepEqual(
    preparation.members.map((member) => member.role),
    ['signal', 'ground'],
  );
  assert.deepEqual(
    preparation.members.map((member) => member.originalMemberName),
    ['pair[1]', 'pair[2]'],
  );
  assert.deepEqual(pair, snapshot);

  const oneWire = structuredClone(pair);
  oneWire.items[0].number = 1;
  const threeWire = structuredClone(pair);
  threeWire.items[0].number = 3;
  for (const unsupported of [oneWire, threeWire]) {
    assert.equal(isFloatingPairStackup(unsupported), false);
    assert.equal(isExplicitReferenceStackup(unsupported), false);
    assert.ok(
      validateStackup(unsupported).some((error) => /floating pair/i.test(error)),
    );
  }

  const malformed = splitFloatingTwoWireStackup();
  malformed.items[0].number = 2;
  malformed.items[1].number = 0;
  assert.equal(isFloatingPairStackup(malformed), false);
  assert.equal(isExplicitReferenceStackup(malformed), false);
  assert.ok(
    validateStackup(malformed).some(
      (error) => /conductor count must be a positive integer/i.test(error),
    ),
  );

  const explicitGround = isolatedTwoWireStackup();
  assert.equal(isFloatingPairStackup(explicitGround), false);
  assert.equal(isExplicitReferenceStackup(explicitGround), true);
  assert.equal(prepareExplicitReferenceStackup(explicitGround).floatingPair, false);
});

test('explicit-reference adapter preserves embedded dielectric geometry', () => {
  const stackup = explicitRibbonCableStackup();
  const snapshot = structuredClone(stackup);

  assert.deepEqual(validateStackup(stackup), []);
  assert.equal(isExplicitReferenceStackup(stackup), true);

  const preparation = prepareExplicitReferenceStackup(stackup);
  assert.deepEqual(stackup, snapshot);
  assert.deepEqual(preparation.signalNames, ['Circ3C0']);
  assert.deepEqual(
    preparation.members.map((member) => member.originalMemberName),
    ['GND[1]', 'GND[2]', 'SIG'],
  );

  const helperAir = preparation.solverStackup.items.find(
    (item) => item.id === '__explicit_reference_air',
  );
  assert.equal(helperAir?.kind, 'DielectricLayer');
  const transformedPvc = preparation.solverStackup.items.find(
    (item) => item.id === 'PVC',
  );
  assert.equal(transformedPvc?.kind, 'RectangleDielectric');
  assert.deepEqual(
    {
      id: transformedPvc.id,
      width: transformedPvc.width,
      height: transformedPvc.height,
      permittivity: transformedPvc.permittivity,
      lossTangent: transformedPvc.lossTangent,
      xOffset: transformedPvc.xOffset,
      yOffset: transformedPvc.yOffset,
    },
    {
      id: 'PVC',
      width: 700,
      height: 36,
      permittivity: 2.89,
      lossTangent: 0.025,
      xOffset: 0,
      yOffset: 0,
    },
  );
  assertNear(
    (
      helperAir.thickness + transformedPvc.yOffset -
      stackup.items[0].yOffset
    ) * UNIT_SCALE.mils,
    preparation.verticalOffsetM,
    'PVC vertical translation',
  );

  for (const id of ['GND', 'SIG']) {
    const original = stackup.items.find((item) => item.id === id);
    const transformed = preparation.solverStackup.items.find(
      (item) => item.id === id,
    );
    assert.equal(original?.kind, 'CircleConductors');
    assert.equal(transformed?.kind, 'CircleConductors');
    assert.equal(transformed.isGround, false);
    assert.equal(transformed.xOffset, original.xOffset);
    assert.equal(transformed.yOffset, original.yOffset);
    assert.equal(transformed.diameter, original.diameter);
    assertNear(
      (
        helperAir.thickness + transformed.yOffset - original.yOffset
      ) * UNIT_SCALE.mils,
      preparation.verticalOffsetM,
      `${id} vertical translation`,
    );
  }
});

test('charge-neutral projection removes only helper-plane common mode', () => {
  const matrix = [
    [5, -1, -3],
    [-1, 5, -3],
    [-3, -3, 8],
  ];
  const snapshot = structuredClone(matrix);
  const expected = [
    [4.75, -1.25, -3.5],
    [-1.25, 4.75, -3.5],
    [-3.5, -3.5, 7],
  ];

  const neutral = chargeNeutralProjection(matrix);

  assertMatrixNear(neutral, expected, 'neutral capacitance');
  assert.deepEqual(matrix, snapshot);
  for (let index = 0; index < neutral.length; index++) {
    assertNear(
      neutral[index].reduce((sum, value) => sum + value, 0),
      0,
      `neutral row ${index}`,
    );
    assertNear(
      neutral.reduce((sum, row) => sum + row[index], 0),
      0,
      `neutral column ${index}`,
    );
  }
});

test('floating-pair reduction publishes only the physical differential mode', () => {
  const preparation = prepareExplicitReferenceStackup(
    floatingTwoWireStackup(),
  );
  const memberNames = preparation.members.map(
    (member) => member.internalSolverName,
  );
  const resistance = [
    [10, 0],
    [0, 20],
  ];
  const primary = fakeFullActiveResult(
    memberNames,
    [
      [10, -2],
      [-2, 10],
    ],
    resistance,
  );
  const freeSpace = fakeFullActiveResult(
    memberNames,
    [
      [5, -1],
      [-1, 5],
    ],
    resistance,
  );

  const reduction = reduceExplicitReferenceResults(
    preparation,
    primary,
    freeSpace,
  );

  assertMatrixNear(
    reduction.capacitance,
    [[6]],
    'floating-pair capacitance',
  );
  assertMatrixNear(
    reduction.freeSpaceCapacitance,
    [[3]],
    'floating-pair free-space capacitance',
  );
  const differentialInductance =
    1 /
    (
      3 *
      MMTL_SPEED_OF_LIGHT_M_PER_S *
      MMTL_SPEED_OF_LIGHT_M_PER_S
    );
  assertMatrixNear(
    reduction.inductance,
    [[differentialInductance]],
    'floating-pair differential inductance',
  );
  assertMatrixNear(
    reduction.currentTransform,
    [[1], [-1]],
    'opposite-conductor return transform',
  );
  assertMatrixNear(reduction.signalRdc, [[10]], 'driven-conductor Rdc');
  assert.equal(reduction.result.nSignals, 1);
  assert.deepEqual(reduction.result.names, preparation.signalNames);
  assert.deepEqual(reduction.result.floatingDifferential, {
    positiveName: preparation.floatingPairSignalNames[0],
    negativeName: preparation.floatingPairSignalNames[1],
  });
  assert.equal(reduction.result.zOdd, undefined);
  assert.equal(reduction.result.zEven, undefined);
  assert.equal(reduction.result.z0.length, 1);
  assert.ok(Number.isFinite(reduction.result.z0[0]));
  assertNear(reduction.result.epsEff[0], 2, 'floating-pair epsilon');
  assertNear(
    reduction.result.velocity[0],
    MMTL_SPEED_OF_LIGHT_M_PER_S / Math.sqrt(2),
    'floating-pair differential velocity',
  );
});

test('reversing the floating-pair drive preserves the mode and reverses current', () => {
  const cases = [false, true].map((reverse) => {
    const preparation = prepareExplicitReferenceStackup(
      splitFloatingTwoWireStackup(reverse),
    );
    const names = preparation.members.map(
      (member) => member.internalSolverName,
    );
    const resistance = [[10, 0], [0, 10]];
    const freeSpace = fakeFullActiveResult(
      names,
      [[5, -1], [-1, 5]],
      resistance,
    );
    const primary = fakeFullActiveResult(
      names,
      [[10, -2], [-2, 10]],
      resistance,
    );
    const reduction = reduceExplicitReferenceResults(
      preparation,
      primary,
      freeSpace,
    );
    return {
      preparation,
      reduction,
      currentByPhysicalMember: Object.fromEntries(
        preparation.members.map((member, index) => [
          member.originalMemberName,
          reduction.currentTransform[index][0],
        ]),
      ),
    };
  });

  assertNear(
    cases[0].reduction.result.z0[0],
    cases[1].reduction.result.z0[0],
    'reversed floating-pair impedance',
  );
  assertNear(
    cases[0].reduction.result.epsEff[0],
    cases[1].reduction.result.epsEff[0],
    'reversed floating-pair effective permittivity',
  );
  assert.deepEqual(cases[0].currentByPhysicalMember, { left: 1, right: -1 });
  assert.deepEqual(cases[1].currentByPhysicalMember, { right: 1, left: -1 });
  assert.deepEqual(
    cases.map(({ preparation }) => preparation.members.map((member) => member.role)),
    [['signal', 'ground'], ['signal', 'ground']],
  );
});

test('explicit-reference reduction preserves signal current and closes return columns', () => {
  const preparation = prepareExplicitReferenceStackup(
    explicitCircularReferenceStackup(),
  );
  const memberNames = preparation.members.map(
    (member) => member.internalSolverName,
  );
  const resultNames = [memberNames[2], memberNames[0], memberNames[1]];
  const freeMemberCapacitance = [
    [5, -1, -3],
    [-1, 5, -3],
    [-3, -3, 8],
  ];
  const primaryMemberCapacitance = freeMemberCapacitance.map((row) =>
    row.map((value) => 2 * value));
  const memberResistance = [
    [10, 0, 0],
    [0, 20, 0],
    [0, 0, 30],
  ];
  const primary = fakeFullActiveResult(
    resultNames,
    reorderMatrix(primaryMemberCapacitance, memberNames, resultNames),
    reorderMatrix(memberResistance, memberNames, resultNames),
  );
  const freeSpace = fakeFullActiveResult(
    resultNames,
    reorderMatrix(freeMemberCapacitance, memberNames, resultNames),
    reorderMatrix(memberResistance, memberNames, resultNames),
  );
  const preparationSnapshot = structuredClone(preparation);
  const primarySnapshot = structuredClone(primary);
  const freeSpaceSnapshot = structuredClone(freeSpace);

  const reduction = reduceExplicitReferenceResults(
    preparation,
    primary,
    freeSpace,
  );

  const expectedNeutralFreeSpace = [
    [4.75, -1.25, -3.5],
    [-1.25, 4.75, -3.5],
    [-3.5, -3.5, 7],
  ];
  assertMatrixNear(
    reduction.memberCapacitance,
    primaryMemberCapacitance,
    'reordered primary capacitance',
  );
  assertMatrixNear(
    reduction.memberFreeSpaceCapacitance,
    freeMemberCapacitance,
    'reordered free-space capacitance',
  );
  assertMatrixNear(
    reduction.neutralFreeSpaceCapacitance,
    expectedNeutralFreeSpace,
    'neutral free-space capacitance',
  );
  assertMatrixNear(
    reduction.neutralCapacitance,
    expectedNeutralFreeSpace.map((row) => row.map((value) => 2 * value)),
    'neutral primary capacitance',
  );
  assertMatrixNear(reduction.capacitance, [[14]], 'reduced capacitance');
  assertMatrixNear(
    reduction.freeSpaceCapacitance,
    [[7]],
    'reduced free-space capacitance',
  );
  assertMatrixNear(
    reduction.currentTransform,
    [[-0.5], [-0.5], [1]],
    'member-current transform',
  );
  assertMatrixNear(reduction.signalRdc, [[30]], 'signal Rdc');
  assert.equal(reduction.currentTransform[2][0], 1);
  assertNear(
    reduction.currentTransform.reduce((sum, row) => sum + row[0], 0),
    0,
    'current-transform column closure',
  );

  const expectedInductance =
    1 /
    (
      MMTL_SPEED_OF_LIGHT_M_PER_S *
      MMTL_SPEED_OF_LIGHT_M_PER_S *
      7
    );
  assertNear(
    reduction.inductance[0][0],
    expectedInductance,
    'reduced inductance',
  );
  assert.equal(reduction.result.nSignals, 1);
  assert.deepEqual(reduction.result.names, preparation.signalNames);
  assertMatrixNear(reduction.result.B, [[14]], 'result capacitance');
  assertMatrixNear(
    reduction.result.L,
    [[expectedInductance]],
    'result inductance',
  );
  assertMatrixNear(reduction.result.Rdc, [[30]], 'result Rdc');
  assertNear(reduction.result.epsEff[0], 2, 'effective permittivity');
  assertNear(
    reduction.result.velocity[0],
    MMTL_SPEED_OF_LIGHT_M_PER_S / Math.sqrt(2),
    'reduced velocity',
  );
  assert.ok(Number.isFinite(reduction.result.z0[0]));
  assert.ok(reduction.result.z0[0] > 0);
  assert.ok(reduction.capacitance[0][0] > 0);
  assert.ok(reduction.inductance[0][0] > 0);
  assert.deepEqual(preparation, preparationSnapshot);
  assert.deepEqual(primary, primarySnapshot);
  assert.deepEqual(freeSpace, freeSpaceSnapshot);
});

test('explicit-reference crosstalk uses exact configured length and rise time', () => {
  const configuredLengthM = 1.234567e-6;
  const configuredRiseTimePs = 0.123456;
  const stackup = {
    title: 'two-signal explicit-reference timing fixture',
    units: 'mils',
    couplingLengthM: configuredLengthM,
    riseTimePs: configuredRiseTimePs,
    cseg: 12,
    dseg: 12,
    items: [
      {
        kind: 'CircleConductors',
        id: 'return',
        isGround: true,
        conductivity: 5e7,
        number: 1,
        pitch: 0,
        xOffset: 0,
        yOffset: 20,
        diameter: 8,
      },
      {
        kind: 'CircleConductors',
        id: 'signal',
        isGround: false,
        conductivity: 5e7,
        number: 2,
        pitch: 24,
        xOffset: 20,
        yOffset: 20,
        diameter: 8,
      },
    ],
  };
  const preparation = prepareExplicitReferenceStackup(stackup);
  const names = preparation.members.map((member) => member.internalSolverName);
  const freeSpaceCapacitance = [
    [5, -1, -3],
    [-1, 5, -3],
    [-3, -3, 8],
  ];
  const primaryCapacitance = freeSpaceCapacitance.map((row) =>
    row.map((value) => 2 * value));
  const resistance = [
    [10, 0, 0],
    [0, 10, 0],
    [0, 0, 10],
  ];
  const primary = fakeFullActiveResult(names, primaryCapacitance, resistance);
  const freeSpace = fakeFullActiveResult(names, freeSpaceCapacitance, resistance);
  // Simulate the native report's rounded metadata, including a length that
  // prints as zero. Neither value may replace the exact stackup settings.
  primary.couplingLengthM = 0;
  primary.riseTimePs = 0.1235;

  const reduction = reduceExplicitReferenceResults(
    preparation,
    primary,
    freeSpace,
  );
  const expected = calculateMmtlCrosstalk(
    reduction.result.names,
    reduction.result.B,
    reduction.result.L,
    reduction.result.velocity,
    configuredLengthM,
    configuredRiseTimePs,
  );

  assert.equal(reduction.result.couplingLengthM, configuredLengthM);
  assert.equal(reduction.result.riseTimePs, configuredRiseTimePs);
  assert.deepEqual(reduction.result.fxt, expected.fxt);
  assert.deepEqual(reduction.result.bxt, expected.bxt);
  assert.equal(reduction.result.fxt.length, 1);
  assert.equal(reduction.result.bxt.length, 1);
});

test('explicit-reference return-current transform uses the all-air capacitance basis', () => {
  const preparation = prepareExplicitReferenceStackup(
    explicitCircularReferenceStackup(),
  );
  const memberNames = preparation.members.map(
    (member) => member.internalSolverName,
  );
  // Each raw matrix is a charge-neutral physical matrix plus a helper-plane
  // common-mode term. The deliberately non-proportional dielectric matrix
  // would partition the two return currents as -7/11 and -4/11. The all-air
  // field basis instead requires -3/5 and -2/5.
  const primaryMemberCapacitance = [
    [10, 1, -5],
    [1, 7, -2],
    [-5, -2, 13],
  ];
  const freeSpaceMemberCapacitance = [
    [5, 0, -2],
    [0, 4, -1],
    [-2, -1, 6],
  ];
  const resistance = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const primary = fakeFullActiveResult(
    memberNames,
    primaryMemberCapacitance,
    resistance,
  );
  const freeSpace = fakeFullActiveResult(
    memberNames,
    freeSpaceMemberCapacitance,
    resistance,
  );

  const reduction = reduceExplicitReferenceResults(
    preparation,
    primary,
    freeSpace,
  );

  assertMatrixNear(
    reduction.neutralCapacitance,
    [
      [8, -1, -7],
      [-1, 5, -4],
      [-7, -4, 11],
    ],
    'non-proportional dielectric capacitance',
  );
  assertMatrixNear(
    reduction.neutralFreeSpaceCapacitance,
    [
      [4, -1, -3],
      [-1, 3, -2],
      [-3, -2, 5],
    ],
    'all-air capacitance basis',
  );
  assertMatrixNear(
    reduction.currentTransform,
    [[-3 / 5], [-2 / 5], [1]],
    'all-air return-current transform',
  );
  assert.ok(
    Math.abs(reduction.currentTransform[0][0] - (-7 / 11)) > 0.03,
    'transform must not use the dielectric capacitance partition',
  );
});

test('native explicit-reference reduction agrees with the isolated two-wire solution', async () => {
  const physicalStackup = isolatedTwoWireStackup();
  const preparation = prepareExplicitReferenceStackup(physicalStackup);
  const output = await solve(preparation.solverStackup);
  assert.ok(output.ok, output.stdout);
  assert.ok(output.result);

  const reduction = reduceExplicitReferenceResults(
    preparation,
    output.result,
    output.result,
  );
  const radiusM = 4 * UNIT_SCALE.mils;
  const centerSpacingM = 24 * UNIT_SCALE.mils;
  const acosh = Math.acosh(centerSpacingM / (2 * radiusM));
  const mu0 = 4 * Math.PI * 1e-7;
  const epsilon0 =
    1 /
    (
      mu0 *
      MMTL_SPEED_OF_LIGHT_M_PER_S *
      MMTL_SPEED_OF_LIGHT_M_PER_S
    );
  const analyticCapacitancePerM = Math.PI * epsilon0 / acosh;
  const analyticImpedance =
    Math.sqrt(mu0 / epsilon0) * acosh / Math.PI;

  assert.ok(
    Math.abs(
      reduction.capacitance[0][0] - analyticCapacitancePerM,
    ) / analyticCapacitancePerM < 0.015,
    `two-wire capacitance ${reduction.capacitance[0][0]} vs ${analyticCapacitancePerM}`,
  );
  assert.ok(
    Math.abs(reduction.result.z0[0] - analyticImpedance) /
      analyticImpedance < 0.015,
    `two-wire Z0 ${reduction.result.z0[0]} vs ${analyticImpedance}`,
  );
  assertNear(reduction.result.epsEff[0], 1, 'two-wire effective permittivity');
  assertMatrixNear(
    reduction.currentTransform,
    [[-1], [1]],
    'two-wire current transform',
    2e-6,
  );
});

test('native floating pair grounds each wire through the opposite wire', async () => {
  const physicalStackup = floatingTwoWireStackup();
  const preparation = prepareExplicitReferenceStackup(physicalStackup);
  const output = await solve(preparation.solverStackup);
  assert.ok(output.ok, output.stdout);
  assert.ok(output.result);
  assert.ok(output.fieldText);

  const reduction = reduceExplicitReferenceResults(
    preparation,
    output.result,
    output.result,
  );
  const radiusM = 4 * UNIT_SCALE.mils;
  const centerSpacingM = 24 * UNIT_SCALE.mils;
  const acosh = Math.acosh(centerSpacingM / (2 * radiusM));
  const mu0 = 4 * Math.PI * 1e-7;
  const epsilon0 =
    1 /
    (
      mu0 *
      MMTL_SPEED_OF_LIGHT_M_PER_S *
      MMTL_SPEED_OF_LIGHT_M_PER_S
    );
  const analyticDifferentialImpedance =
    Math.sqrt(mu0 / epsilon0) * acosh / Math.PI;

  assert.equal(reduction.result.nSignals, 1);
  assert.deepEqual(reduction.result.floatingDifferential, {
    positiveName: preparation.floatingPairSignalNames[0],
    negativeName: preparation.floatingPairSignalNames[1],
  });
  assert.ok(
    Math.abs(reduction.result.z0[0] - analyticDifferentialImpedance) /
      analyticDifferentialImpedance < 0.015,
    `floating Zdiff=${reduction.result.z0[0]} vs ${analyticDifferentialImpedance}`,
  );
  assertNear(reduction.result.epsEff[0], 1, 'floating-pair epsilon');
  assertMatrixNear(
    reduction.currentTransform,
    [[1], [-1]],
    'floating-pair loop-current basis',
  );

  const physicalFields = parseFieldPlot(
    transformExplicitReferenceFieldText(
      output.fieldText,
      preparation,
      reduction,
    ),
  );
  assert.deepEqual(
    physicalFields.map((field) => field.line),
    preparation.signalNames,
  );
  assert.equal(physicalFields.length, 1);

  const analysis = meshExplicitReferenceAnalysis(
    physicalStackup,
    output,
    preparation,
    reduction,
  );
  assert.deepEqual(analysis.currentBasis.signalNames, preparation.signalNames);
  assert.equal(analysis.currentBasis.signals.length, 1);
  assert.equal(analysis.currentBasis.surfaces.length, 1);
  assert.equal(analysis.currentBasis.surfaces[0].id, 'pair[2]');
  assertNear(
    analysis.currentBasis.surfaces[0].netCurrentBasisA[0],
    -1,
    'opposite-wire return current',
    5e-5,
  );
  assert.equal(analysis.lossModel.terms.length, 1);
  assert.equal(analysis.lossModel.terms[0].label, 'pair[2]');
  assert.ok(analysis.lossModel.terms[0].geometryPerM[0][0] > 0);
});

test('native explicit-reference ribbon solve includes the PVC dielectric', async () => {
  const physicalStackup = explicitRibbonCableStackup();
  const preparation = prepareExplicitReferenceStackup(physicalStackup);
  const primaryOutput = await solve(preparation.solverStackup);
  const freeSpaceOutput = await solve(
    freeSpaceStackup(preparation.solverStackup),
  );

  assert.ok(primaryOutput.ok, primaryOutput.stdout);
  assert.ok(primaryOutput.result);
  assert.ok(primaryOutput.fieldText);
  assert.ok(freeSpaceOutput.ok, freeSpaceOutput.stdout);
  assert.ok(freeSpaceOutput.result);

  const reduction = reduceExplicitReferenceResults(
    preparation,
    primaryOutput.result,
    freeSpaceOutput.result,
  );
  assert.equal(reduction.result.nSignals, 1);
  assert.deepEqual(reduction.result.names, ['Circ3C0']);
  for (const value of [
    reduction.result.z0[0],
    reduction.result.epsEff[0],
    reduction.result.velocity[0],
    reduction.result.delay[0],
    reduction.result.B[0][0],
    reduction.result.L[0][0],
  ]) {
    assert.ok(Number.isFinite(value));
    assert.ok(value > 0);
  }
  assert.ok(
    Math.abs(reduction.result.z0[0] - 103.48) / 103.48 < 0.003,
    `ribbon Z0=${reduction.result.z0[0]} ohm`,
  );
  assert.ok(
    reduction.result.epsEff[0] > 1 && reduction.result.epsEff[0] < 2.89,
    `ribbon effective permittivity=${reduction.result.epsEff[0]}`,
  );
  assert.ok(
    reduction.result.B[0][0] > reduction.freeSpaceCapacitance[0][0],
    'PVC must increase capacitance over the all-air solve',
  );

  const rawFields = parseFieldPlot(primaryOutput.fieldText);
  const physicalFields = parseFieldPlot(
    transformExplicitReferenceFieldText(
      primaryOutput.fieldText,
      preparation,
      reduction,
    ),
  );
  assert.equal(rawFields.length, preparation.members.length);
  assert.equal(physicalFields.length, 1);
  assert.equal(physicalFields[0].line, 'Circ3C0');
  assert.equal(
    physicalFields[0].elements.length,
    rawFields[0].elements.length,
  );
  assert.ok(
    physicalFields[0].elements.some((element) => element.type === 'dielectric'),
    'transformed field must retain the PVC boundary elements',
  );
  for (let index = 0; index < physicalFields[0].elements.length; index++) {
    const rawElement = rawFields[0].elements[index];
    const physicalElement = physicalFields[0].elements[index];
    assert.equal(physicalElement.type, rawElement.type);
    assert.deepEqual(physicalElement.x, rawElement.x);
    for (let point = 0; point < physicalElement.y.length; point++) {
      assertNear(
        rawElement.y[point] - physicalElement.y[point],
        preparation.verticalOffsetM,
        `field element ${index} point ${point} vertical restoration`,
        1e-12,
      );
    }
  }
  const dielectricY = physicalFields[0].elements
    .filter((element) => element.type === 'dielectric')
    .flatMap((element) => element.y);
  assert.ok(Math.min(...dielectricY) >= -1e-8 * UNIT_SCALE.mils);
  assert.ok(Math.max(...dielectricY) <= 36.000001 * UNIT_SCALE.mils);
});

test('native explicit-reference solve uses only the two physical return surfaces', async () => {
  const physicalStackup = explicitCircularReferenceStackup();
  const preparation = prepareExplicitReferenceStackup(physicalStackup);
  const primaryOutput = await solve(preparation.solverStackup);
  const freeSpaceOutput = await solve(
    freeSpaceStackup(preparation.solverStackup),
  );

  assert.ok(primaryOutput.ok, primaryOutput.stdout);
  assert.ok(primaryOutput.result);
  assert.ok(primaryOutput.fieldText);
  assert.ok(freeSpaceOutput.ok, freeSpaceOutput.stdout);
  assert.ok(freeSpaceOutput.result);
  assert.ok(freeSpaceOutput.fieldText);

  const reduction = reduceExplicitReferenceResults(
    preparation,
    primaryOutput.result,
    freeSpaceOutput.result,
  );
  const analysis = meshExplicitReferenceAnalysis(
    physicalStackup,
    freeSpaceOutput,
    preparation,
    reduction,
  );
  const rawFieldText = primaryOutput.fieldText;
  const exposed = exposeExplicitReferenceSolveOutput(
    primaryOutput,
    reduction,
  );

  assert.notEqual(exposed, primaryOutput);
  assert.equal(exposed.result, reduction.result);
  assert.equal(exposed.fieldText, null);
  assert.equal(primaryOutput.fieldText, rawFieldText);
  assert.equal(primaryOutput.result.nSignals, 3);
  assert.equal(exposed.result.nSignals, 1);
  assert.deepEqual(exposed.result.names, preparation.signalNames);

  const basis = analysis.currentBasis;
  assert.equal(basis.implicitBottom, null);
  assert.deepEqual(basis.signalNames, preparation.signalNames);
  assert.equal(basis.signals.length, 1);
  assert.equal(basis.signals[0].solverName, preparation.signalNames[0]);
  assert.equal(basis.surfaces.length, 2);
  assert.deepEqual(
    basis.surfaces.map((surface) => surface.id).sort(),
    ['round-return[1]', 'round-return[2]'],
  );

  const returnCurrents = basis.surfaces.map(
    (surface) => surface.netCurrentBasisA[0],
  );
  assert.ok(returnCurrents.every(Number.isFinite));
  assert.ok(returnCurrents.every((current) => current < 0));
  assert.ok(
    Math.abs(returnCurrents[0] - returnCurrents[1]) < 5e-5,
    `asymmetric ground currents: ${returnCurrents.join(', ')}`,
  );
  assert.ok(
    Math.abs(1 + returnCurrents[0] + returnCurrents[1]) < 5e-5,
    `physical current does not close: ${returnCurrents.join(', ')}`,
  );

  const expectedCenters = new Map([
    ['round-return[1]', [4 * UNIT_SCALE.mils, 24 * UNIT_SCALE.mils]],
    ['round-return[2]', [44 * UNIT_SCALE.mils, 24 * UNIT_SCALE.mils]],
  ]);
  const radiusM = 4 * UNIT_SCALE.mils;
  for (const surface of basis.surfaces) {
    const center = expectedCenters.get(surface.id);
    assert.ok(center);
    assert.ok(surface.elements.length > 0);
    for (const element of surface.elements) {
      assert.ok(element.samples.length > 0);
      for (const sample of element.samples) {
        assert.ok(Number.isFinite(sample.currentBasisAPerM[0]));
        assert.ok(sample.yM < 40 * UNIT_SCALE.mils);
        const outward =
          (sample.xM - center[0]) * sample.nx +
          (sample.yM - center[1]) * sample.ny;
        assert.ok(
          outward > radiusM * 0.9,
          `${surface.id} has a non-outward physical normal`,
        );
      }
    }
  }

  const model = analysis.lossModel;
  assert.equal(model.source, 'mesh');
  assert.equal(model.terms.length, 2);
  assert.deepEqual(
    model.terms.map((term) => term.label).sort(),
    ['round-return[1]', 'round-return[2]'],
  );
  for (const term of model.terms) {
    assert.equal(term.conductivity, 2.5e7);
    assertNear(
      term.thicknessM,
      8 * UNIT_SCALE.mils,
      `${term.label} thickness`,
    );
    assert.equal(term.geometryPerM.length, 1);
    assert.equal(term.geometryPerM[0].length, 1);
    assert.ok(Number.isFinite(term.geometryPerM[0][0]));
    assert.ok(term.geometryPerM[0][0] > 0);
    const surface = basis.surfaces.find(
      (candidate) => candidate.id === term.label,
    );
    assert.ok(surface);
    assertMatrixNear(
      explicitSurfaceEnergy(surface, 1),
      term.geometryPerM,
      `${term.label} surface energy`,
      1e-12,
    );
  }
  const termSum = model.terms.reduce(
    (sum, term) => sum + term.geometryPerM[0][0],
    0,
  );
  assert.equal(model.geometryPerM.length, 1);
  assert.equal(model.geometryPerM[0].length, 1);
  assert.ok(Number.isFinite(model.geometryPerM[0][0]));
  assert.ok(model.geometryPerM[0][0] > 0);
  assertNear(
    model.geometryPerM[0][0],
    termSum,
    'aggregate explicit-reference loss geometry',
    1e-12,
  );
  assert.ok(
    Math.abs(
      model.terms[0].geometryPerM[0][0] -
      model.terms[1].geometryPerM[0][0],
    ) / Math.max(
      model.terms[0].geometryPerM[0][0],
      model.terms[1].geometryPerM[0][0],
    ) < 0.005,
    'symmetric ground loss terms disagree',
  );

  const distribution = meshGroundCurrentDistribution(basis, [1]);
  assert.deepEqual(distribution.planes, []);
  assert.deepEqual(distribution.xM, []);
  assert.equal(distribution.surfaces.length, 2);
  assert.ok(
    Math.abs(
      distribution.surfaces.reduce(
        (sum, surface) => sum + surface.netCurrentA,
        0,
      ) - 1,
    ) < 5e-5,
  );
  for (const surface of distribution.surfaces) {
    assert.ok(Number.isFinite(surface.netCurrentA));
    assert.ok(surface.netCurrentA > 0);
    assert.ok(Math.abs(surface.netCurrentA - 0.5) < 5e-5);
    const densities = surface.elements.flatMap((element) =>
      element.samples.map((sample) => sample.densityAPerM));
    assert.ok(densities.length > 0);
    assert.ok(densities.every(Number.isFinite));
    assert.ok(densities.some((density) => Math.abs(density) > 0));
  }
});
