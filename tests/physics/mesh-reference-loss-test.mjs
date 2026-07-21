import assert from 'node:assert/strict';
import test from 'node:test';

import {
  microstripReferencePlaneSelfOverlapPerM,
  UNIT_SCALE,
} from '../../src/analysis/losses.ts';
import {
  CPW_RETURN_CURRENT_MESH_MULTIPLIER,
  freeSpaceStackup,
  meshGroundCurrentDistribution,
  meshReferenceAnalysis,
  meshReferencePlaneLossModel,
  poissonKernelOverlapPerM,
  refineConductorMesh,
} from '../../src/analysis/meshReferenceLoss.ts';
import {
  buildPreset,
  defaultParams,
} from '../../src/model/presets.ts';
import { parseResult } from '../../src/solver/parseResult.mjs';
import {
  generateXsctn,
  solverSignalBindings,
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

function explicitSurfaceEnergy(surface, size) {
  const matrix = Array.from(
    { length: size },
    () => Array(size).fill(0),
  );
  for (const element of surface.elements) {
    for (let sampleIndex = 0; sampleIndex < element.samples.length; sampleIndex++) {
      const sample = element.samples[sampleIndex];
      if (sampleIndex > 0) {
        assert.ok(sample.t > element.samples[sampleIndex - 1].t);
      }
      assert.ok(
        Math.abs(Math.hypot(sample.nx, sample.ny) - 1) < 1e-12,
      );
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

function assertCurrentConservation(basis, tolerance = 5e-6) {
  for (let driven = 0; driven < basis.signalNames.length; driven++) {
    const explicitGround = basis.surfaces.reduce(
      (sum, surface) => sum + surface.netCurrentBasisA[driven],
      0,
    );
    const total =
      1 + explicitGround + basis.implicitBottom.netCurrentBasisA[driven];
    assert.ok(
      Math.abs(total) < tolerance,
      `basis ${driven} current does not close: ${total} A`,
    );
  }
}

function implicitBottomBasisDensity(basis, basisIndex, xM) {
  return -basis.implicitBottom.sources.reduce(
    (sum, source) =>
      sum +
      source.weightM *
        source.currentBasisAPerM[basisIndex] *
        poissonKernelOverlapPerM(xM, 0, source.xM, source.yM),
    0,
  );
}

function integrateTrapezoid(fn, low, high, intervals = 16000) {
  const step = (high - low) / intervals;
  let sum = 0.5 * (fn(low) + fn(high));
  for (let index = 1; index < intervals; index++) {
    sum += fn(low + index * step);
  }
  return sum * step;
}

test('implicit-plane Poisson overlap has the exact line-current limit', () => {
  const heightM = 0.8e-3;
  const self = poissonKernelOverlapPerM(0, heightM, 0, heightM);
  assert.ok(
    Math.abs(self - 1 / (2 * Math.PI * heightM)) /
      (1 / (2 * Math.PI * heightM)) <
      1e-14,
  );
  const offsetM = 1.7e-3;
  const mutual = poissonKernelOverlapPerM(
    -offsetM / 2,
    heightM,
    offsetM / 2,
    heightM,
  );
  assert.equal(
    mutual,
    poissonKernelOverlapPerM(
      offsetM / 2,
      heightM,
      -offsetM / 2,
      heightM,
    ),
  );
  assert.ok(mutual > 0 && mutual < self);
});

test('free-space clone preserves geometry and removes dielectric dependence', () => {
  const low = defaultParams('cpw', 'se');
  low.laminateId = null;
  low.er = 2.2;
  low.tanD = 0.003;
  low.cover = null;
  const high = { ...low, er: 10.2, tanD: 0.04 };
  const lowAir = freeSpaceStackup(buildPreset('cpw', 'se', low));
  const highAir = freeSpaceStackup(buildPreset('cpw', 'se', high));
  assert.equal(generateXsctn(lowAir), generateXsctn(highAir));
  for (const item of lowAir.items) {
    if (
      item.kind === 'DielectricLayer' ||
      item.kind === 'RectangleDielectric' ||
      item.kind === 'TrapezoidDielectric'
    ) {
      assert.equal(item.permittivity, 1);
    }
    if (
      item.kind === 'DielectricLayer' ||
      item.kind === 'RectangleDielectric' ||
      item.kind === 'TrapezoidDielectric'
    ) {
      assert.equal(item.lossTangent, 0);
    }
  }

  const mixed = {
    title: 'mixed dielectric free-space clone',
    units: 'mils',
    couplingLengthM: 0.0254,
    riseTimePs: 100,
    cseg: 12,
    dseg: 12,
    items: [
      { kind: 'GroundPlane', id: 'ground' },
      {
        kind: 'DielectricLayer', id: 'layer', thickness: 10,
        permittivity: 4.1, lossTangent: 0.011,
      },
      {
        kind: 'RectangleDielectric', id: 'block', width: 20, height: 3,
        permittivity: 3.2, lossTangent: 0.022, xOffset: 0, yOffset: 0,
      },
      {
        kind: 'TrapezoidDielectric', id: 'wedge', topWidth: 12,
        bottomWidth: 16, height: 2, permittivity: 2.4,
        lossTangent: 0.033, xOffset: 2, yOffset: 0,
      },
      {
        kind: 'RectangleConductors', id: 'signal', isGround: false,
        conductivity: 5.8e7, number: 1, pitch: 0, xOffset: 7,
        yOffset: 0, width: 2, height: 1,
      },
    ],
  };
  const snapshot = structuredClone(mixed);
  const mixedAir = freeSpaceStackup(mixed);
  assert.deepEqual(mixed, snapshot, 'the physical stackup is not mutated');
  assert.notEqual(mixedAir, mixed);
  assert.deepEqual(
    mixedAir.items
      .filter((item) => item.kind.includes('Dielectric'))
      .map(({ id, permittivity, lossTangent }) => ({ id, permittivity, lossTangent })),
    [
      { id: 'layer', permittivity: 1, lossTangent: 0 },
      { id: 'block', permittivity: 1, lossTangent: 0 },
      { id: 'wedge', permittivity: 1, lossTangent: 0 },
    ],
  );
});

test('return-current refinement increases only conductor segmentation', () => {
  const params = defaultParams('cpw', 'se');
  params.cseg = 17;
  params.dseg = 23;
  const stackup = buildPreset('cpw', 'se', params);
  const original = structuredClone(stackup);

  const refined = refineConductorMesh(stackup);

  assert.equal(CPW_RETURN_CURRENT_MESH_MULTIPLIER, 10);
  assert.notEqual(refined, stackup);
  assert.notEqual(refined.items, stackup.items);
  assert.equal(refined.cseg, 170);
  assert.equal(refined.dseg, 23);
  assert.deepEqual(refined.items, stackup.items);
  assert.deepEqual(stackup, original);
});

test('CPW mesh loss separates both coplanar grounds and the implicit plane', async () => {
  const params = defaultParams('cpw', 'se');
  params.cover = null;
  params.cseg = 24;
  params.dseg = 12;
  params.referencePlaneSameWeight = false;
  params.referencePlaneThickness = 2.8;
  const stackup = buildPreset('cpw', 'se', params);
  const output = await solve(freeSpaceStackup(stackup));
  assert.ok(output.ok);
  const analysis = meshReferenceAnalysis(stackup, output);
  const model = analysis.lossModel;
  assert.equal(model.source, 'mesh');
  assert.equal(model.terms.length, 3);
  const left = model.terms.find((term) => term.label === 'flank[1]');
  const right = model.terms.find((term) => term.label === 'flank[2]');
  const bottom = model.terms.find((term) => term.label === 'gnd');
  assert.ok(left && right && bottom);
  assert.ok(
    Math.abs(left.geometryPerM[0][0] - right.geometryPerM[0][0]) /
      Math.max(left.geometryPerM[0][0], right.geometryPerM[0][0]) <
      0.01,
  );
  assert.equal(left.thicknessM, params.t * UNIT_SCALE.mils);
  assert.equal(
    bottom.thicknessM,
    params.referencePlaneThickness * UNIT_SCALE.mils,
  );
  const sum = model.terms.reduce(
    (total, term) => total + term.geometryPerM[0][0],
    0,
  );
  assert.ok(Math.abs(sum - model.geometryPerM[0][0]) < sum * 1e-12);

  const basis = analysis.currentBasis;
  assert.deepEqual(basis.signalNames, output.result.names);
  assert.equal(basis.signals.length, 1);
  assert.equal(
    basis.signals[0].resultIndex,
    basis.signalNames.indexOf(basis.signals[0].solverName),
  );
  assert.deepEqual(
    basis.surfaces.map((surface) => surface.id).sort(),
    ['flank[1]', 'flank[2]'],
  );
  assertCurrentConservation(basis);
  for (const surface of basis.surfaces) {
    const energy = explicitSurfaceEnergy(surface, 1);
    const term = model.terms.find((candidate) => candidate.label === surface.id);
    assert.ok(term);
    assert.ok(
      Math.abs(energy[0][0] - term.geometryPerM[0][0]) <=
        Math.max(1e-12, term.geometryPerM[0][0] * 1e-12),
    );
  }

  const distribution = meshGroundCurrentDistribution(basis, [1]);
  assert.equal(distribution.mode, 'single-ended');
  assert.equal(distribution.surfaces.length, 2);
  assert.ok(
    distribution.surfaces.every((surface) => surface.netCurrentA > 0),
  );
  assert.ok(distribution.planes[0].netCurrentA > 0);
  const signalCenterIndex = distribution.xM.reduce(
    (closest, x, index) =>
      Math.abs(x - basis.signals[0].centerM) <
      Math.abs(distribution.xM[closest] - basis.signals[0].centerM)
        ? index
        : closest,
    0,
  );
  assert.ok(distribution.planes[0].densityAPerM[signalCenterIndex] > 0);
  const displayedReturn =
    distribution.planes[0].netCurrentA +
    distribution.surfaces.reduce(
      (total, surface) => total + surface.netCurrentA,
      0,
    );
  assert.ok(Math.abs(displayedReturn - 1) < 5e-6);
});

test('mesh microstrip return overlap agrees with the closed-form limit', async () => {
  const params = defaultParams('microstrip', 'se');
  params.cover = null;
  params.cseg = 24;
  params.dseg = 12;
  const stackup = buildPreset('microstrip', 'se', params);
  const output = await solve(freeSpaceStackup(stackup));
  const analysis = meshReferenceAnalysis(stackup, output);
  const model = analysis.lossModel;
  const analytic = microstripReferencePlaneSelfOverlapPerM(
    (params.w - params.etch / 2) * UNIT_SCALE.mils,
    (params.h + params.t / 2) * UNIT_SCALE.mils,
  );
  assert.ok(
    Math.abs(model.geometryPerM[0][0] - analytic) / analytic < 0.1,
  );
  const bottom = model.terms.find((term) => term.label === 'gnd');
  assert.ok(bottom);
  const basis = analysis.currentBasis;
  const sourceX = basis.implicitBottom.sources.map((source) => source.xM);
  const maxHeightM = Math.max(
    ...basis.implicitBottom.sources.map((source) => source.yM),
  );
  const low = Math.min(...sourceX) - 100 * maxHeightM;
  const high = Math.max(...sourceX) + 100 * maxHeightM;
  const sampledEnergy = integrateTrapezoid(
    (xM) => implicitBottomBasisDensity(basis, 0, xM) ** 2,
    low,
    high,
  );
  assert.ok(
    Math.abs(sampledEnergy - bottom.geometryPerM[0][0]) /
      bottom.geometryPerM[0][0] <
      0.01,
  );
});

test('differential CPW overlap is symmetric and positive semidefinite', async () => {
  const params = defaultParams('cpw', 'diff');
  params.cover = null;
  params.cseg = 24;
  params.dseg = 12;
  const stackup = buildPreset('cpw', 'diff', params);
  const output = await solve(freeSpaceStackup(stackup));
  const analysis = meshReferenceAnalysis(stackup, output);
  const model = analysis.lossModel;
  const q = model.geometryPerM;
  assert.equal(q.length, 2);
  assert.ok(
    Math.abs(q[0][0] - q[1][1]) / Math.max(q[0][0], q[1][1]) <
      0.015,
  );
  assert.ok(Math.abs(q[0][1] - q[1][0]) < q[0][0] * 1e-12);
  assert.ok(q[0][0] >= 0 && q[1][1] >= 0);
  assert.ok(q[0][0] * q[1][1] - q[0][1] * q[1][0] >= -1e-9);
  const odd = (q[0][0] + q[1][1] - q[0][1] - q[1][0]) / 2;
  const even = (q[0][0] + q[1][1] + q[0][1] + q[1][0]) / 2;
  assert.ok(odd > 0);
  assert.ok(even > odd);

  const basis = analysis.currentBasis;
  assertCurrentConservation(basis);
  const drawingSignals = solverSignalBindings(stackup);
  const driveByName = new Map([
    [drawingSignals[0].solverName, 1],
    [drawingSignals[1].solverName, -1],
  ]);
  const drive = basis.signalNames.map((name) => driveByName.get(name) ?? 0);
  const distribution = meshGroundCurrentDistribution(basis, drive);
  assert.equal(distribution.mode, 'differential odd mode');
  const signed = [
    ...distribution.planes[0].densityAPerM,
    ...distribution.surfaces.flatMap((surface) =>
      surface.elements.flatMap((element) =>
        element.samples.map((sample) => sample.densityAPerM)),
    ),
  ];
  const peak = Math.max(...signed.map(Math.abs));
  assert.ok(signed.some((value) => value > peak * 1e-3));
  assert.ok(signed.some((value) => value < -peak * 1e-3));
  const netReturn =
    distribution.planes[0].netCurrentA +
    distribution.surfaces.reduce(
      (sum, surface) => sum + surface.netCurrentA,
      0,
    );
  assert.ok(Math.abs(netReturn) < 5e-6);
});

test('free-form explicit ground shape receives its own material term', async () => {
  const stackup = {
    title: 'arbitrary-ground',
    units: 'mils',
    couplingLengthM: 0.0254,
    riseTimePs: 100,
    cseg: 24,
    dseg: 12,
    items: [
      {
        kind: 'GroundPlane',
        id: 'bottom',
        conductivity: 4.1e7,
        thickness: 2.1,
      },
      {
        kind: 'DielectricLayer',
        id: 'sub',
        thickness: 10,
        permittivity: 4.2,
        lossTangent: 0.01,
      },
      {
        kind: 'CircleConductors',
        id: 'round-return',
        isGround: true,
        conductivity: 2.5e7,
        number: 1,
        pitch: 0,
        xOffset: 0,
        yOffset: 0,
        diameter: 4,
      },
      {
        kind: 'RectangleConductors',
        id: 'signal',
        isGround: false,
        conductivity: 5e7,
        number: 1,
        pitch: 0,
        xOffset: 9,
        yOffset: 0,
        width: 3,
        height: 1.4,
      },
    ],
  };
  const output = await solve(freeSpaceStackup(stackup));
  assert.ok(output.ok);
  const analysis = meshReferenceAnalysis(stackup, output);
  const model = analysis.lossModel;
  const round = model.terms.find((term) => term.label === 'round-return');
  const bottom = model.terms.find((term) => term.label === 'bottom');
  assert.ok(round && bottom);
  assert.equal(round.conductivity, 2.5e7);
  assert.equal(round.thicknessM, 4 * UNIT_SCALE.mils);
  assert.equal(bottom.conductivity, 4.1e7);
  assert.equal(bottom.thicknessM, 2.1 * UNIT_SCALE.mils);
  assert.ok(round.geometryPerM[0][0] > 0);
  assert.ok(bottom.geometryPerM[0][0] > 0);

  const basis = analysis.currentBasis;
  assertCurrentConservation(basis);
  assert.equal(basis.signals[0].id, 'signal');
  assert.equal(
    basis.signals[0].resultIndex,
    basis.signalNames.indexOf(basis.signals[0].solverName),
  );
  const roundSurface = basis.surfaces.find(
    (surface) => surface.id === 'round-return',
  );
  assert.ok(roundSurface);
  const roundEnergy = explicitSurfaceEnergy(roundSurface, 1);
  assert.ok(
    Math.abs(roundEnergy[0][0] - round.geometryPerM[0][0]) <=
      round.geometryPerM[0][0] * 1e-12,
  );
  const centerXM = 2 * UNIT_SCALE.mils;
  const centerYM = 12 * UNIT_SCALE.mils;
  for (const element of roundSurface.elements) {
    for (const sample of element.samples) {
      assert.ok(
        (sample.xM - centerXM) * sample.nx +
          (sample.yM - centerYM) * sample.ny >
          0,
      );
    }
  }
  const distribution = meshGroundCurrentDistribution(basis, [1]);
  assert.equal(distribution.surfaces.length, 1);
  assert.equal(distribution.surfaces[0].id, 'round-return');
  assert.ok(distribution.surfaces[0].elements.length > 1);
});

test('arbitrary three-signal normalization preserves solver port order', async () => {
  const stackup = {
    title: 'mixed signal conductor sets',
    units: 'mils',
    couplingLengthM: 0.0254,
    riseTimePs: 100,
    cseg: 12,
    dseg: 12,
    items: [
      { kind: 'GroundPlane', id: 'bottom-ground' },
      {
        kind: 'DielectricLayer',
        id: 'substrate',
        thickness: 10,
        permittivity: 4.2,
        lossTangent: 0.02,
      },
      {
        kind: 'TrapezoidConductors',
        id: 'left-trapezoid',
        isGround: false,
        conductivity: 5.8e7,
        topWidth: 2.5,
        bottomWidth: 3,
        height: 1,
        number: 1,
        pitch: 0,
        xOffset: 0,
        yOffset: 0,
      },
      {
        kind: 'RectangleConductors',
        id: 'right-rectangles',
        isGround: false,
        conductivity: 5.8e7,
        width: 3,
        height: 1,
        number: 2,
        pitch: 6,
        xOffset: 6,
        yOffset: 0,
      },
    ],
  };
  const output = await solve(freeSpaceStackup(stackup));
  assert.deepEqual(
    output.result.names,
    ['Cond4R2', 'Cond4R1', 'Trap3T0'],
  );
  const model = meshReferencePlaneLossModel(stackup, output);
  const q = model.geometryPerM;
  assert.equal(q.length, 3);
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      assert.ok(Math.abs(q[row][column] - q[column][row]) < 1e-9);
      assert.ok(
        Math.abs(q[row][column]) <=
          Math.sqrt(q[row][row] * q[column][column]) * (1 + 1e-12),
      );
    }
  }
  for (const vector of [
    [1, 0, -1],
    [1, -2, 1],
    [1, 1, 1],
  ]) {
    const power = vector.reduce(
      (sum, left, row) =>
        sum +
        vector.reduce(
          (rowSum, right, column) =>
            rowSum + left * q[row][column] * right,
          0,
        ),
      0,
    );
    assert.ok(power >= -1e-8);
  }
});
