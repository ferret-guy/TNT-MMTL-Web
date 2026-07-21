#!/usr/bin/env node
/** Regression coverage for every solver example exposed by about.html. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Importing store.ts creates the browser store singleton. Supply the minimal
// browser surface used by the other state-serialization tests.
globalThis.window = { location: { hash: '' } };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const { FREEFORM_EXAMPLES_BY_ID } = await import(
  '../../src/model/freeformExamples.ts'
);
const { currentStackup, decodeHash, defaultState } = await import(
  '../../src/model/store.ts'
);
const { signalCount } = await import('../../src/model/types.ts');
const { generateXsctn, solverSignalBindings, validateStackup } = await import(
  '../../src/xsctn/generate.ts'
);
const { parseResult } = await import('../../src/solver/parseResult.mjs');
const {
  isFloatingPairStackup,
  isExplicitReferenceStackup,
  prepareExplicitReferenceStackup,
  reduceExplicitReferenceResults,
} = await import('../../src/analysis/explicitReference.ts');
const { freeSpaceStackup } = await import(
  '../../src/analysis/meshReferenceLoss.ts'
);
const {
  dielectricConductanceMatrix,
  dielectricLossModelFromPerturbation,
  dielectricParticipationPerturbation,
} = await import('../../src/analysis/dielectricLoss.ts');
const {
  perimeterM,
  presetLossTangentAtFrequency,
  UNIT_SCALE,
} = await import('../../src/analysis/losses.ts');
const {
  exportGenericSpiceSubcircuit,
  exportHspiceWElement,
  exportTouchstoneDifferentialS2p,
  exportTouchstoneNPort,
  exportTouchstoneS2p,
  exportTouchstoneS4p,
  multiconductorLineSParameters,
  supportsDifferentialTouchstone,
} = await import('../../src/export/modelExport.ts');
const createBemModule = (
  await import(new URL('../../public/wasm/bem.mjs', import.meta.url).href)
).default;

const aboutHtml = await readFile(
  new URL('../../about.html', import.meta.url),
  'utf8',
);

function decodeHtmlAttribute(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&#38;', '&')
    .replaceAll('&#x26;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

function attribute(tag, name) {
  const match = tag.match(
    new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'),
  );
  return match ? decodeHtmlAttribute(match[2]) : null;
}

function anchors(fragment) {
  return [...fragment.matchAll(/<a\b[^>]*>/gi)].map(([tag]) => ({
    tag,
    href: attribute(tag, 'href'),
    freeformId: attribute(tag, 'data-freeform-example'),
  }));
}

function assertRelativeModelHref(href, label) {
  assert.equal(typeof href, 'string', `${label} has no href`);
  assert.doesNotMatch(
    href,
    /^(?:[a-z][a-z\d+.-]*:|\/\/|\/)/i,
    `${label} must use a relative URL, received ${href}`,
  );
  assert.match(href, /#v=3(?:&|$)/, `${label} has no v3 model hash`);
}

function stateFromHref(href, label) {
  assertRelativeModelHref(href, label);
  const hashIndex = href.indexOf('#');
  const decoded = decodeHash(href.slice(hashIndex));
  assert.ok(decoded, `${label} did not decode`);

  // Mirror the production store's default merge for the fields used to build
  // and solve the linked stackup. decodeHash returns complete preset params,
  // while free-form links replace the default geometry through `items`.
  const defaults = defaultState();
  return {
    ...defaults,
    ...decoded,
    presetParams: {
      ...defaults.presetParams,
      ...(decoded.presetParams ?? {}),
    },
    freeform: {
      ...defaults.freeform,
      ...(decoded.freeform ?? {}),
    },
    lossParams: {
      ...defaults.lossParams,
      ...(decoded.lossParams ?? {}),
    },
    lastSolve: null,
    solving: false,
  };
}

function escapedRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pcbExamplesFromPage() {
  const articleMatches = [...aboutHtml.matchAll(
    /<article\b[^>]*class=["'][^"']*\babout-example\b[^"']*["'][^>]*>([\s\S]*?)<\/article>/gi,
  )];
  assert.equal(articleMatches.length, 2, 'expected both JLCPCB example cards');

  return articleMatches.flatMap(([, article], articleIndex) => {
    const heading = article.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i)?.[1]
      .replace(/<[^>]+>/g, '')
      .trim() || `JLCPCB example ${articleIndex + 1}`;
    const modelLinks = anchors(article).filter(({ href }) => href?.includes('#v='));
    assert.equal(modelLinks.length, 2, `${heading} must link both L1 and L2`);

    const linkedKinds = modelLinks.map(({ href }, linkIndex) => {
      const label = `${heading} link ${linkIndex + 1}`;
      const state = stateFromHref(href, label);
      assert.equal(state.mode, 'preset', `${label} must load preset mode`);
      return state.presetKind;
    });
    assert.deepEqual(
      [...linkedKinds].sort(),
      ['microstrip', 'stripline'],
      `${heading} must link one L1 microstrip and one L2 stripline`,
    );

    return modelLinks.map(({ href }, linkIndex) => ({
      id: `pcb-${articleIndex + 1}-${linkedKinds[linkIndex]}`,
      label: `${heading} ${linkedKinds[linkIndex] ?? `link ${linkIndex + 1}`}`,
      href,
      state: stateFromHref(href, `${heading} link ${linkIndex + 1}`),
      expectedSignals: 1,
      floatingPair: false,
      benchmarkOhms: 50,
      measuredOhms: (result) => result.z0[0],
    }));
  });
}

function freeformExamplesFromPage() {
  const linked = anchors(aboutHtml).filter(({ freeformId }) => freeformId);
  const ids = linked.map(({ freeformId }) => freeformId);
  assert.deepEqual(
    [...new Set(ids)].sort(),
    Object.keys(FREEFORM_EXAMPLES_BY_ID).sort(),
    'About-page cable cards and the shared example fixtures must stay in sync',
  );

  // A card may expose the same model through both its rendered preview and
  // its title. Validate every anchor, but solve each distinct model once.
  for (const freeformId of ids) {
    const example = FREEFORM_EXAMPLES_BY_ID[freeformId];
    assert.ok(example, `unknown free-form example ${freeformId}`);
    assertRelativeModelHref(example.href, example.title);
  }

  return [...new Set(ids)].map((freeformId) => {
    const example = FREEFORM_EXAMPLES_BY_ID[freeformId];
    assert.ok(example, `unknown free-form example ${freeformId}`);
    const state = stateFromHref(example.href, example.title);
    assert.equal(state.mode, 'freeform', `${example.title} must load free-form mode`);
    const stackup = currentStackup(state);
    const floatingPair = isFloatingPairStackup(stackup);
    const expectedSignals = floatingPair ? 1 : signalCount(stackup);
    return {
      id: freeformId,
      label: example.title,
      href: example.href,
      state,
      expectedSignals,
      floatingPair,
      benchmarkOhms: example.benchmark?.ohms,
      measuredOhms: !example.benchmark
        ? null
        : example.benchmark.quantity === 'differential Z'
          ? floatingPair
            ? (result) => result.z0[0]
            : (result) => 2 * result.zOdd
          : (result) => result.z0[0],
    };
  });
}

async function solveNative(stackup, caseName) {
  const stdout = [];
  const mod = await createBemModule({
    print: (line) => stdout.push(line),
    printErr: (line) => stdout.push(line),
  });
  mod.FS.mkdir('/work');
  mod.FS.writeFile(`/work/${caseName}.xsctn`, generateXsctn(stackup));
  mod.FS.chdir('/work');

  let exitCode = 0;
  try {
    exitCode = mod.callMain([
      `/work/${caseName}`,
      String(stackup.cseg),
      String(stackup.dseg),
    ]);
  } catch (error) {
    if (error?.name === 'ExitStatus') exitCode = error.status;
    else throw error;
  }

  const log = stdout.join('\n');
  assert.equal(exitCode ?? 0, 0, log);
  assert.match(log, /MMTL is done/, log);
  return parseResult(
    mod.FS.readFile(`/work/${caseName}.result`, { encoding: 'utf8' }),
  );
}

function capacitanceMatrixInOrder(result, expectedNames) {
  const indices = new Map(result.names.map((name, index) => [name, index]));
  assert.equal(indices.size, result.names.length, 'duplicate solver signal name');
  const order = expectedNames.map((name) => {
    const index = indices.get(name);
    assert.notEqual(index, undefined, `dielectric solve is missing ${name}`);
    return index;
  });
  return order.map((row) => order.map((column) => {
    const value = result.B[row][column];
    assert.ok(Number.isFinite(value), 'non-finite dielectric capacitance');
    return value;
  }));
}

/** Exercise the live solver's explicit-reference and dielectric-loss adapters. */
async function solveProductionStackup(stackup, caseName, withDielectricLoss) {
  const preparation = isExplicitReferenceStackup(stackup)
    ? prepareExplicitReferenceStackup(stackup)
    : null;
  const nativeStackup = preparation?.solverStackup ?? stackup;
  const primary = await solveNative(nativeStackup, `${caseName}-primary`);
  let freeSpace = null;
  let result = primary;
  if (preparation) {
    freeSpace = await solveNative(
      freeSpaceStackup(nativeStackup),
      `${caseName}-free-space`,
    );
    result = reduceExplicitReferenceResults(
      preparation,
      primary,
      freeSpace,
    ).result;
  }

  let dielectricLoss = null;
  const perturbation = withDielectricLoss
    ? dielectricParticipationPerturbation(nativeStackup)
    : null;
  if (perturbation) {
    const positive = await solveNative(
      perturbation.positiveStackup,
      `${caseName}-dielectric-plus`,
    );
    const negative = await solveNative(
      perturbation.negativeStackup,
      `${caseName}-dielectric-minus`,
    );
    const physicalCapacitance = (perturbed) => {
      const physical = preparation
        ? reduceExplicitReferenceResults(
            preparation,
            perturbed,
            freeSpace,
          ).result
        : perturbed;
      return capacitanceMatrixInOrder(physical, result.names);
    };
    dielectricLoss = dielectricLossModelFromPerturbation(
      physicalCapacitance(positive),
      physicalCapacitance(negative),
      perturbation.maxLossTangent,
      perturbation.logPermittivityStep,
      result.B,
    );
  }
  return { result, dielectricLoss };
}

function assertPhysicalResult(result, example) {
  assert.equal(result.nSignals, example.expectedSignals, example.label);
  assert.equal(result.names.length, example.expectedSignals, example.label);
  assert.equal(result.B.length, example.expectedSignals, example.label);
  assert.equal(result.L.length, example.expectedSignals, example.label);
  if (example.floatingPair) {
    assert.ok(result.floatingDifferential, `${example.label} lost floating-pair metadata`);
    assert.ok(result.floatingDifferential.positiveName, example.label);
    assert.ok(result.floatingDifferential.negativeName, example.label);
    assert.notEqual(
      result.floatingDifferential.positiveName,
      result.floatingDifferential.negativeName,
      example.label,
    );
    assert.equal(result.zOdd, undefined, `${example.label} must expose one differential mode`);
    assert.equal(result.zEven, undefined, `${example.label} must not invent common mode`);
  } else {
    assert.equal(result.floatingDifferential, undefined, example.label);
  }
  for (const [quantity, values] of Object.entries({
    z0: result.z0,
    epsEff: result.epsEff,
    velocity: result.velocity,
    delay: result.delay,
  })) {
    assert.equal(values.length, example.expectedSignals, `${example.label} ${quantity}`);
    assert.ok(
      values.every((value) => Number.isFinite(value) && value > 0),
      `${example.label} has nonphysical ${quantity}: ${values.join(', ')}`,
    );
  }

  if (example.benchmarkOhms == null || !example.measuredOhms) return;
  const measured = example.measuredOhms(result);
  assert.ok(
    Number.isFinite(measured) && measured > 0,
    `${example.label} did not produce its advertised impedance`,
  );
  const errorPercent = Math.abs(measured - example.benchmarkOhms)
    / example.benchmarkOhms * 100;
  assert.ok(
    errorPercent <= 5,
    `${example.label} is ${measured.toFixed(3)} ohm, ${errorPercent.toFixed(2)}% from ${example.benchmarkOhms} ohm`,
  );
}

const SPEED_OF_LIGHT_M_PER_S = 299_792_458;
const MU0 = 4e-7 * Math.PI;

function relativeError(actual, expected) {
  return Math.abs(actual - expected) /
    Math.max(Number.MIN_VALUE, Math.abs(actual), Math.abs(expected));
}

function assertNear(actual, expected, label, tolerance = 2e-8) {
  assert.ok(
    relativeError(actual, expected) <= tolerance,
    `${label}: ${actual} != ${expected}`,
  );
}

function symmetricMatrix(matrix) {
  return matrix.map((row, rowIndex) => row.map(
    (_, columnIndex) =>
      (matrix[rowIndex][columnIndex] + matrix[columnIndex][rowIndex]) / 2,
  ));
}

function assertFiniteSymmetricMatrix(matrix, size, label) {
  assert.equal(matrix.length, size, `${label} row count`);
  const scale = Math.max(Number.MIN_VALUE, ...matrix.flat().map(Math.abs));
  for (let row = 0; row < size; row++) {
    assert.equal(matrix[row].length, size, `${label} column count`);
    for (let column = 0; column < size; column++) {
      assert.ok(Number.isFinite(matrix[row][column]), `${label}[${row},${column}]`);
      assert.ok(
        Math.abs(matrix[row][column] - matrix[column][row]) <= scale * 2e-8,
        `${label} is not symmetric at [${row},${column}]`,
      );
    }
  }
}

function assertPositiveDefinite(matrix, label) {
  const source = symmetricMatrix(matrix);
  const size = source.length;
  const lower = Array.from({ length: size }, () => Array(size).fill(0));
  const scale = Math.max(Number.MIN_VALUE, ...source.flat().map(Math.abs));
  for (let row = 0; row < size; row++) {
    for (let column = 0; column <= row; column++) {
      let value = source[row][column];
      for (let inner = 0; inner < column; inner++) {
        value -= lower[row][inner] * lower[column][inner];
      }
      if (row === column) {
        assert.ok(value > scale * 1e-10, `${label} is not positive definite`);
        lower[row][column] = Math.sqrt(value);
      } else {
        lower[row][column] = value / lower[column][column];
      }
    }
  }
}

function assertPositiveSemidefinite(matrix, label) {
  const source = symmetricMatrix(matrix);
  const size = source.length;
  const scale = Math.max(Number.MIN_VALUE, ...source.flat().map(Math.abs));
  const vectors = [
    ...Array.from({ length: size }, (_, active) =>
      Array.from({ length: size }, (_, index) => index === active ? 1 : 0)),
    ...Array.from({ length: size }, (_, active) =>
      Array.from({ length: size }, (_, index) => index <= active ? 1 : -1)),
    Array.from({ length: size }, (_, index) => Math.sin((index + 1) * 1.618)),
  ];
  for (const vector of vectors) {
    const quadratic = vector.reduce(
      (sum, left, row) => sum + left * source[row].reduce(
        (rowSum, value, column) => rowSum + value * vector[column],
        0,
      ),
      0,
    );
    assert.ok(quadratic >= -scale * size * 2e-7, `${label} is not passive`);
  }
}

function assertSolvedMath(result, label, dielectricLoss) {
  const count = result.nSignals;
  assertFiniteSymmetricMatrix(result.B, count, `${label} C`);
  assertFiniteSymmetricMatrix(result.L, count, `${label} L`);
  assertFiniteSymmetricMatrix(result.Rdc, count, `${label} Rdc`);
  assertPositiveDefinite(result.B, `${label} C`);
  assertPositiveDefinite(result.L, `${label} L`);
  const capacitanceScale = Math.max(...result.B.flat().map(Math.abs));
  for (let row = 0; row < count; row++) {
    assert.ok(result.Rdc[row][row] >= 0, `${label} has negative DC resistance`);
    for (let column = 0; column < count; column++) {
      if (row !== column) {
        assert.ok(
          result.B[row][column] <= capacitanceScale * 2e-7,
          `${label} C has a positive mutual Maxwell term`,
        );
      }
    }
    assertNear(
      result.z0[row],
      Math.sqrt(result.L[row][row] / result.B[row][row]),
      `${label} Z0 ${row + 1}`,
      3e-5,
    );
    assertNear(
      result.velocity[row] * result.delay[row],
      1,
      `${label} velocity/delay ${row + 1}`,
      3e-7,
    );
    assertNear(
      result.velocity[row] * Math.sqrt(result.epsEff[row]),
      SPEED_OF_LIGHT_M_PER_S,
      `${label} effective permittivity ${row + 1}`,
      3e-5,
    );
  }
  if (result.nSignals === 2 && result.zOdd != null && result.zEven != null) {
    const cOdd = result.B[0][0] - result.B[0][1];
    const cEven = result.B[0][0] + result.B[0][1];
    const lOdd = result.L[0][0] - result.L[0][1];
    const lEven = result.L[0][0] + result.L[0][1];
    assertNear(result.zOdd, Math.sqrt(lOdd / cOdd), `${label} odd Z`, 5e-5);
    assertNear(result.zEven, Math.sqrt(lEven / cEven), `${label} even Z`, 5e-5);
  }
  if (dielectricLoss) {
    assertFiniteSymmetricMatrix(
      dielectricLoss.lossCapacitancePerM,
      count,
      `${label} dielectric K`,
    );
    assertPositiveSemidefinite(
      dielectricLoss.lossCapacitancePerM,
      `${label} dielectric K`,
    );
  }
}

function buildExportInput(example, stackup, result, dielectricLoss) {
  const bindings = new Map(
    solverSignalBindings(stackup).map((binding) => [
      binding.solverName,
      binding.conductor,
    ]),
  );
  const conductors = result.names.map((name) => bindings.get(name));
  assert.ok(
    conductors.every(Boolean),
    `${example.label} export conductor order is incomplete`,
  );
  const flow = example.state.mode === 'freeform'
    ? 'arbitrary'
    : example.state.presetVariant === 'diff'
      ? 'preset-diff'
      : 'preset-se';
  const tanDAtHz = example.state.mode === 'preset'
    ? (frequencyHz) => presetLossTangentAtFrequency(
        example.state.presetKind,
        example.state.presetParams,
        frequencyHz,
      )
    : undefined;
  const tanD = tanDAtHz?.(example.state.designFreqHz) ?? 0;
  return {
    title: stackup.title,
    flow,
    result,
    conductors,
    unitScaleM: UNIT_SCALE[stackup.units],
    lengthM: example.state.lineLengthM,
    designFreqHz: example.state.designFreqHz,
    lossParams: {
      ...example.state.lossParams,
      // Compare every format against the same signal-conductor RLGC source.
      // Generic multiconductor SPICE cannot represent shared-return mutual R.
      includeReferencePlaneLoss: false,
      roughnessModel: 'none',
      fMinHz: example.state.designFreqHz,
      fMaxHz: example.state.designFreqHz,
      nPoints: 1,
    },
    dielectricLoss: dielectricLoss ?? undefined,
    tanD,
    tanDAtHz,
  };
}

function conductorAreaM2(conductor, unitScaleM) {
  const scale2 = unitScaleM * unitScaleM;
  if (conductor.kind === 'CircleConductors') {
    return Math.PI * conductor.diameter ** 2 * scale2 / 4;
  }
  if (conductor.kind === 'TrapezoidConductors') {
    return (conductor.topWidth + conductor.bottomWidth) *
      conductor.height * scale2 / 2;
  }
  return conductor.width * conductor.height * scale2;
}

function signalResistanceMatrix(input, frequencyHz) {
  const matrix = Array.from(
    { length: input.result.nSignals },
    () => Array(input.result.nSignals).fill(0),
  );
  for (let index = 0; index < input.result.nSignals; index++) {
    const conductor = input.conductors[index];
    const solvedRdc = input.result.Rdc[index][index];
    const geometricRdc = 1 /
      (conductorAreaM2(conductor, input.unitScaleM) * conductor.conductivity);
    const rdc = Number.isFinite(solvedRdc) && solvedRdc >= 0
      ? solvedRdc
      : geometricRdc;
    const skinCoefficient = Math.sqrt(Math.PI * MU0 / conductor.conductivity) /
      perimeterM(conductor, input.unitScaleM);
    matrix[index][index] = Math.hypot(
      rdc,
      skinCoefficient * Math.sqrt(frequencyHz),
    );
  }
  return matrix;
}

function lossFactorMatrix(input, frequencyHz) {
  if (input.dielectricLoss) {
    return input.dielectricLoss.lossCapacitancePerM.map((row) => [...row]);
  }
  const tanD = input.tanDAtHz?.(frequencyHz) ?? input.tanD;
  return input.result.B.map((row) => row.map((value) => value * tanD));
}

function conductanceMatrix(input, frequencyHz) {
  return input.dielectricLoss
    ? dielectricConductanceMatrix(input.dielectricLoss, frequencyHz)
    : lossFactorMatrix(input, frequencyHz).map((row) => row.map(
        (value) => 2 * Math.PI * frequencyHz * value,
      ));
}

function parseTouchstone(file) {
  const header = file.text.match(/^#\s+Hz\s+S\s+RI\s+R\s+(\S+)$/m);
  assert.ok(header, `${file.filename} has no conservative Touchstone header`);
  const portMatch = file.filename.match(/\.s(\d+)p$/i);
  assert.ok(portMatch, `${file.filename} does not encode its port count`);
  const ports = Number(portMatch[1]);
  const numeric = file.text
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/^[!#]/.test(line.trim()))
    .flatMap((line) => line.trim().split(/\s+/).map(Number));
  assert.equal(numeric.length, 1 + 2 * ports * ports, file.filename);
  assert.ok(numeric.every(Number.isFinite), `${file.filename} has non-finite data`);
  const values = numeric.slice(1);
  const matrix = Array.from({ length: ports }, () =>
    Array.from({ length: ports }, () => ({ re: 0, im: 0 })));
  let pair = 0;
  if (ports === 2) {
    for (const [row, column] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      matrix[row][column] = { re: values[2 * pair], im: values[2 * pair + 1] };
      pair++;
    }
  } else {
    for (let row = 0; row < ports; row++) {
      for (let column = 0; column < ports; column++) {
        matrix[row][column] = { re: values[2 * pair], im: values[2 * pair + 1] };
        pair++;
      }
    }
  }
  return {
    frequencyHz: numeric[0],
    referenceOhm: Number(header[1]),
    matrix,
  };
}

function assertComplexMatrixNear(actual, expected, label, tolerance = 2e-8) {
  assert.equal(actual.length, expected.length, `${label} dimensions`);
  for (let row = 0; row < actual.length; row++) {
    for (let column = 0; column < actual.length; column++) {
      assertNear(actual[row][column].re, expected[row][column].re, `${label} Re[${row},${column}]`, tolerance);
      assertNear(actual[row][column].im, expected[row][column].im, `${label} Im[${row},${column}]`, tolerance);
    }
  }
}

function assertPassiveReciprocalS(matrix, label) {
  for (let column = 0; column < matrix.length; column++) {
    let outgoingPower = 0;
    for (let row = 0; row < matrix.length; row++) {
      const value = matrix[row][column];
      outgoingPower += value.re * value.re + value.im * value.im;
      assertNear(value.re, matrix[column][row].re, `${label} reciprocal Re`, 3e-7);
      assertNear(value.im, matrix[column][row].im, `${label} reciprocal Im`, 3e-7);
    }
    assert.ok(outgoingPower <= 1 + 2e-6, `${label} creates power at port ${column + 1}`);
  }
}

function differentialSubmatrix(physical) {
  const vectors = [
    [1 / Math.sqrt(2), 0, -1 / Math.sqrt(2), 0],
    [0, 1 / Math.sqrt(2), 0, -1 / Math.sqrt(2)],
  ];
  return vectors.map((response) => vectors.map((stimulus) => {
    let re = 0;
    let im = 0;
    for (let row = 0; row < 4; row++) {
      for (let column = 0; column < 4; column++) {
        const scale = response[row] * stimulus[column];
        re += scale * physical[row][column].re;
        im += scale * physical[row][column].im;
      }
    }
    return { re, im };
  }));
}

function touchstoneFilesAndMatrices(input) {
  const frequencyHz = input.designFreqHz;
  const resistance = signalResistanceMatrix(input, frequencyHz);
  const conductance = conductanceMatrix(input, frequencyHz);
  if (input.flow === 'preset-se') {
    const file = exportTouchstoneS2p(input);
    return [{
      kind: 'single-ended',
      file,
      parsed: parseTouchstone(file),
      expected: multiconductorLineSParameters(
        resistance,
        input.result.L,
        conductance,
        input.result.B,
        frequencyHz,
        input.lengthM,
        50,
      ),
    }];
  }
  if (input.flow === 'preset-diff') {
    assert.ok(supportsDifferentialTouchstone(input.result));
    const s4p = exportTouchstoneS4p(input);
    const physical = parseTouchstone(s4p);
    const expected = multiconductorLineSParameters(
      resistance,
      input.result.L,
      conductance,
      input.result.B,
      frequencyHz,
      input.lengthM,
      50,
    );
    const sdd = exportTouchstoneDifferentialS2p(input);
    return [
      { kind: 'differential-four-port', file: s4p, parsed: physical, expected },
      {
        kind: 'differential-only',
        file: sdd,
        parsed: parseTouchstone(sdd),
        expected: differentialSubmatrix(physical.matrix),
      },
    ];
  }
  const file = exportTouchstoneNPort(input);
  const referenceOhm = input.result.floatingDifferential ? 100 : 50;
  return [{
    kind: 'arbitrary',
    file,
    parsed: parseTouchstone(file),
    expected: multiconductorLineSParameters(
      resistance,
      input.result.L,
      conductance,
      input.result.B,
      frequencyHz,
      input.lengthM,
      referenceOhm,
    ),
  }];
}

function unpackLowerTriangle(values, size) {
  const matrix = Array.from({ length: size }, () => Array(size).fill(0));
  let index = 0;
  for (let row = 0; row < size; row++) {
    for (let column = 0; column <= row; column++) {
      matrix[row][column] = values[index];
      matrix[column][row] = values[index];
      index++;
    }
  }
  return matrix;
}

function parseWElement(file) {
  const numeric = file.text
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trim().startsWith('*'))
    .flatMap((line) => line.trim().split(/\s+/).map(Number));
  assert.ok(numeric.every(Number.isFinite), `${file.filename} has non-finite data`);
  const count = numeric[0];
  assert.ok(Number.isInteger(count) && count >= 1, `${file.filename} has invalid N`);
  const triangle = count * (count + 1) / 2;
  assert.equal(numeric.length, 1 + 6 * triangle, `${file.filename} matrix layout`);
  const matrices = [];
  for (let matrixIndex = 0; matrixIndex < 6; matrixIndex++) {
    const start = 1 + matrixIndex * triangle;
    matrices.push(unpackLowerTriangle(numeric.slice(start, start + triangle), count));
  }
  const [L0, C0, R0, G0, Rs, Gd] = matrices;
  return { count, L0, C0, R0, G0, Rs, Gd };
}

function assertRealMatrixNear(actual, expected, label, tolerance = 2e-8) {
  assert.equal(actual.length, expected.length, `${label} dimensions`);
  for (let row = 0; row < actual.length; row++) {
    assert.equal(actual[row].length, expected[row].length, `${label} dimensions`);
    for (let column = 0; column < actual[row].length; column++) {
      assertNear(actual[row][column], expected[row][column], `${label}[${row},${column}]`, tolerance);
    }
  }
}

function expectedWResistanceMatrices(input) {
  const count = input.result.nSignals;
  const R0 = Array.from({ length: count }, () => Array(count).fill(0));
  const Rs = Array.from({ length: count }, () => Array(count).fill(0));
  for (let index = 0; index < count; index++) {
    const conductor = input.conductors[index];
    R0[index][index] = 1 /
      (conductorAreaM2(conductor, input.unitScaleM) * conductor.conductivity);
    Rs[index][index] = Math.sqrt(Math.PI * MU0 / conductor.conductivity) /
      perimeterM(conductor, input.unitScaleM);
  }
  return { R0, Rs };
}

function spiceElements(text) {
  const elements = new Map();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^[.*+]/.test(trimmed)) continue;
    const tokens = trimmed.split(/\s+/);
    const name = tokens[0];
    if (!/^[RCLK]/i.test(name)) continue;
    const value = Number(tokens.at(-1));
    assert.ok(Number.isFinite(value) && value >= 0, `invalid SPICE element ${name}`);
    elements.set(name, { tokens, value });
  }
  return elements;
}

function elementValue(elements, name, optional = false) {
  const element = elements.get(name);
  if (!element && optional) return 0;
  assert.ok(element, `generic SPICE is missing ${name}`);
  return element.value;
}

function branchConductance(elements, name) {
  const resistance = elementValue(elements, name, true);
  return resistance > 0 ? 1 / resistance : 0;
}

function emptyRealMatrix(size) {
  return Array.from({ length: size }, () => Array(size).fill(0));
}

/** Recover the per-metre RLGC encoded by the one-section exported ladder. */
function parseGenericSpiceRlgc(file, input) {
  const elements = spiceElements(file.text);
  const lengthM = input.lengthM;
  const count = input.result.nSignals;
  const R = emptyRealMatrix(count);
  const L = emptyRealMatrix(count);
  const G = emptyRealMatrix(count);
  const C = emptyRealMatrix(count);
  if (input.result.floatingDifferential) {
    R[0][0] = ['R1PA', 'R1NA', 'R1PB', 'R1NB']
      .reduce((sum, name) => sum + elementValue(elements, name), 0) / lengthM;
    L[0][0] = ['L1PA', 'L1NA', 'L1PB', 'L1NB']
      .reduce((sum, name) => sum + elementValue(elements, name), 0) / lengthM;
    C[0][0] = elementValue(elements, 'C1PN') / lengthM;
    G[0][0] = branchConductance(elements, 'RG1PN') / lengthM;
    return { R, L, G, C };
  }
  if (input.flow === 'preset-se') {
    R[0][0] = (elementValue(elements, 'R1A') + elementValue(elements, 'R1B')) /
      lengthM;
    L[0][0] = (elementValue(elements, 'L1A') + elementValue(elements, 'L1B')) /
      lengthM;
    C[0][0] = elementValue(elements, 'C1') / lengthM;
    G[0][0] = branchConductance(elements, 'RG1') / lengthM;
    return { R, L, G, C };
  }
  if (input.flow === 'preset-diff') {
    for (const [index, suffix] of ['P', 'N'].entries()) {
      R[index][index] = (
        elementValue(elements, `R1${suffix}A`) +
        elementValue(elements, `R1${suffix}B`)
      ) / lengthM;
      L[index][index] = (
        elementValue(elements, `L1${suffix}A`) +
        elementValue(elements, `L1${suffix}B`)
      ) / lengthM;
    }
    const mutual = ['A', 'B'].reduce((sum, half) => {
      const coupling = elementValue(elements, `K1${half}`);
      return sum + coupling * Math.sqrt(
        elementValue(elements, `L1P${half}`) *
        elementValue(elements, `L1N${half}`),
      );
    }, 0) / lengthM;
    L[0][1] = mutual;
    L[1][0] = mutual;
    const mutualC = elementValue(elements, 'C1PN', true) / lengthM;
    C[0][0] = elementValue(elements, 'C1PG', true) / lengthM + mutualC;
    C[1][1] = elementValue(elements, 'C1NG', true) / lengthM + mutualC;
    C[0][1] = -mutualC;
    C[1][0] = -mutualC;
    const mutualG = branchConductance(elements, 'RG1PN') / lengthM;
    G[0][0] = branchConductance(elements, 'RG1P') / lengthM + mutualG;
    G[1][1] = branchConductance(elements, 'RG1N') / lengthM + mutualG;
    G[0][1] = -mutualG;
    G[1][0] = -mutualG;
    return { R, L, G, C };
  }

  for (let conductor = 0; conductor < count; conductor++) {
    const number = conductor + 1;
    R[conductor][conductor] = (
      elementValue(elements, `R1C${number}A`) +
      elementValue(elements, `R1C${number}B`)
    ) / lengthM;
    L[conductor][conductor] = (
      elementValue(elements, `L1C${number}A`) +
      elementValue(elements, `L1C${number}B`)
    ) / lengthM;
    C[conductor][conductor] =
      elementValue(elements, `C1C${number}G`, true) / lengthM;
    G[conductor][conductor] =
      branchConductance(elements, `RG1C${number}G`) / lengthM;
  }
  for (let left = 0; left < count; left++) {
    for (let right = left + 1; right < count; right++) {
      const leftNumber = left + 1;
      const rightNumber = right + 1;
      let mutualL = 0;
      for (const half of ['A', 'B']) {
        const coupling = elementValue(
          elements,
          `K1C${leftNumber}C${rightNumber}${half}`,
          true,
        );
        mutualL += coupling * Math.sqrt(
          elementValue(elements, `L1C${leftNumber}${half}`) *
          elementValue(elements, `L1C${rightNumber}${half}`),
        );
      }
      L[left][right] = mutualL / lengthM;
      L[right][left] = L[left][right];
      const mutualC = elementValue(
        elements,
        `C1C${leftNumber}C${rightNumber}`,
        true,
      ) / lengthM;
      C[left][left] += mutualC;
      C[right][right] += mutualC;
      C[left][right] = -mutualC;
      C[right][left] = -mutualC;
      const mutualG = branchConductance(
        elements,
        `RG1C${leftNumber}C${rightNumber}`,
      ) / lengthM;
      G[left][left] += mutualG;
      G[right][right] += mutualG;
      G[left][right] = -mutualG;
      G[right][left] = -mutualG;
    }
  }
  return { R, L, G, C };
}

function assertExportConsistency(input, label) {
  const frequencyHz = input.designFreqHz;
  const expectedR = signalResistanceMatrix(input, frequencyHz);
  const expectedL = symmetricMatrix(input.result.L);
  const expectedC = symmetricMatrix(input.result.B);
  const expectedG = symmetricMatrix(conductanceMatrix(input, frequencyHz));

  const touchstones = touchstoneFilesAndMatrices(input);
  for (const exported of touchstones) {
    assertNear(exported.parsed.frequencyHz, frequencyHz, `${label} Touchstone f`);
    assertComplexMatrixNear(
      exported.parsed.matrix,
      exported.expected,
      `${label} ${exported.kind}`,
      input.flow === 'preset-diff' ? 5e-5 : 3e-9,
    );
    assertPassiveReciprocalS(exported.parsed.matrix, `${label} ${exported.kind}`);
    assert.equal(
      exported.file.filename.endsWith(`.s${exported.parsed.matrix.length}p`),
      true,
      `${label} Touchstone extension`,
    );
  }

  const wFile = exportHspiceWElement(input);
  assert.ok(wFile.filename.endsWith('.wlc'), `${label} W-element extension`);
  const w = parseWElement(wFile);
  assert.equal(w.count, input.result.nSignals, `${label} W N`);
  assertRealMatrixNear(w.L0, expectedL, `${label} W L0`);
  assertRealMatrixNear(w.C0, expectedC, `${label} W C0`);
  const expectedW = expectedWResistanceMatrices(input);
  assertRealMatrixNear(w.R0, expectedW.R0, `${label} W R0`);
  assertRealMatrixNear(w.Rs, expectedW.Rs, `${label} W Rs`);
  assertRealMatrixNear(w.G0, emptyRealMatrix(w.count), `${label} W G0`);
  const expectedGd = symmetricMatrix(lossFactorMatrix(input, frequencyHz)).map(
    (row) => row.map((value) => 2 * Math.PI * value),
  );
  assertRealMatrixNear(w.Gd, expectedGd, `${label} W Gd`);
  assertRealMatrixNear(
    w.Gd.map((row) => row.map((value) => value * frequencyHz)),
    expectedG,
    `${label} W G at design frequency`,
  );

  const spiceFile = exportGenericSpiceSubcircuit(input, 1);
  assert.ok(spiceFile.filename.endsWith('.cir'), `${label} SPICE extension`);
  assert.match(spiceFile.text, /^\.SUBCKT\s+/m, `${label} SPICE .SUBCKT`);
  assert.match(spiceFile.text, /^\.ENDS\s+/m, `${label} SPICE .ENDS`);
  const spice = parseGenericSpiceRlgc(spiceFile, input);
  assertRealMatrixNear(spice.R, expectedR, `${label} SPICE R`, 4e-8);
  assertRealMatrixNear(spice.L, expectedL, `${label} SPICE L`, 4e-8);
  assertRealMatrixNear(spice.C, expectedC, `${label} SPICE C`, 4e-8);
  assertRealMatrixNear(spice.G, expectedG, `${label} SPICE G`, 4e-8);

  // Recovered SPICE primitives must predict the exact distributed response
  // written by Touchstone when evaluated as the same RLGC source model.
  const referenceOhm = input.result.floatingDifferential ? 100 : 50;
  const recoveredResponse = multiconductorLineSParameters(
    spice.R,
    spice.L,
    spice.G,
    spice.C,
    frequencyHz,
    input.lengthM,
    referenceOhm,
  );
  if (input.flow !== 'preset-diff') {
    assertComplexMatrixNear(
      touchstones[0].parsed.matrix,
      recoveredResponse,
      `${label} Touchstone/SPICE RLGC`,
      2e-7,
    );
  }

  const documentedNames = input.result.floatingDifferential
    ? [
        input.result.floatingDifferential.positiveName,
        input.result.floatingDifferential.negativeName,
      ]
    : input.result.names;
  for (const name of documentedNames) {
    const namePattern = new RegExp(escapedRegExp(name));
    assert.match(wFile.text, namePattern, `${label} W name ${name}`);
    if (input.flow === 'arbitrary') {
      assert.match(spiceFile.text, namePattern, `${label} SPICE name ${name}`);
      assert.match(touchstones[0].file.text, namePattern, `${label} Touchstone name ${name}`);
    }
  }
  return {
    touchstonePorts: touchstones[0].parsed.matrix.length,
    filenames: [touchstones[0].file.filename, wFile.filename, spiceFile.filename],
  };
}

test('all About model links are relative, loadable, and structurally valid', () => {
  const examples = [...pcbExamplesFromPage(), ...freeformExamplesFromPage()];
  assert.equal(
    examples.length,
    4 + Object.keys(FREEFORM_EXAMPLES_BY_ID).length,
    'expected four PCB examples plus every shared cable fixture',
  );

  const staticModelLinks = anchors(aboutHtml)
    .filter(({ href }) => href?.includes('#v='));
  assert.equal(
    staticModelLinks.length,
    4,
    'every static model hash must belong to one of the four PCB examples',
  );
  for (const [index, { href }] of staticModelLinks.entries()) {
    assertRelativeModelHref(href, `static About model link ${index + 1}`);
  }

  for (const example of examples) {
    assertRelativeModelHref(example.href, example.label);
    const stackup = currentStackup(example.state);
    assert.deepEqual(
      validateStackup(stackup),
      [],
      `${example.label} generated an invalid solver stackup`,
    );
  }
});

test('every About example has consistent solved math and exported models', async (t) => {
  const examples = [...pcbExamplesFromPage(), ...freeformExamplesFromPage()];
  for (const [index, example] of examples.entries()) {
    await t.test(example.label, async (caseTest) => {
      const stackup = currentStackup(example.state);
      const solved = await solveProductionStackup(
        stackup,
        `about-${index + 1}`,
        example.state.mode === 'freeform',
      );
      assertPhysicalResult(solved.result, example);
      assertSolvedMath(solved.result, example.label, solved.dielectricLoss);
      const input = buildExportInput(
        example,
        stackup,
        solved.result,
        solved.dielectricLoss,
      );
      const exports = assertExportConsistency(input, example.label);
      if (example.id === 'ribbon-many-port') {
        assert.equal(solved.result.nSignals, 5, 'wide ribbon signal count');
        assert.equal(exports.touchstonePorts, 10, 'wide ribbon Touchstone ports');
        assert.ok(exports.filenames[0].endsWith('.s10p'));
        const expectedPairs = solved.result.names.flatMap((active, activeIndex) =>
          solved.result.names.slice(activeIndex + 1).map((passive) => [active, passive]));
        for (const [label, crosstalk] of [
          ['far-end', solved.result.fxt],
          ['near-end', solved.result.bxt],
        ]) {
          assert.equal(crosstalk.length, 10, `wide ribbon ${label} pair count`);
          assert.deepEqual(
            crosstalk.map(({ active, passive }) => [active, passive]),
            expectedPairs,
            `wide ribbon ${label} pair order`,
          );
          assert.ok(
            crosstalk.every(({ value, dB }) =>
              Number.isFinite(value) && (dB == null || Number.isFinite(dB))),
            `wide ribbon ${label} values must be finite`,
          );
        }
        for (const [name, matrix] of Object.entries({
          B: solved.result.B,
          L: solved.result.L,
          Rdc: solved.result.Rdc,
        })) {
          assert.deepEqual(
            matrix,
            matrix.map((_, column) => matrix.map((row) => row[column])),
            `wide ribbon ${name} must be exactly reciprocal`,
          );
        }
      }
      caseTest.diagnostic(
        `${solved.result.nSignals} signal(s); ${exports.touchstonePorts} Touchstone ports; ` +
          exports.filenames.join(', '),
      );
    });
  }
});
