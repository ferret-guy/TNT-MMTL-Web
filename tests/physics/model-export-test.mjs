#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const {
  exportGenericSpiceSubcircuit,
  exportHspiceWElement,
  exportTouchstoneDifferentialS2p,
  exportTouchstoneNPort,
  exportTouchstoneS2p,
  exportTouchstoneS4p,
  multiconductorLineSParameters,
  supportsDifferentialTouchstone,
  uniformLineSParameters,
} = await import(pathToFileURL(join(root, 'src/export/modelExport.ts')));
const {
  lossSweepParamsForDesign,
  referencePlaneDcResistanceMatrix,
  referencePlaneModeValue,
  referencePlaneResistanceMatrix,
  referencePlaneSkinCoefficientMatrix,
} = await import(pathToFileURL(join(root, 'src/analysis/losses.ts')));

const lossParams = {
  includeReferencePlaneLoss: false,
  roughnessModel: 'hammerstad',
  roughnessRqUm: 1,
  hurayRadiusUm: 0.5,
  hurayRatio: 2.2,
  fMinHz: 1e6,
  fMaxHz: 1e9,
  nPoints: 4,
};
const MU0 = 4e-7 * Math.PI;

const referencePlaneOne = {
  geometryPerM: [[1200]],
  conductivity: 5.8e7,
  thicknessM: 35e-6,
};

const referencePlanePair = {
  geometryPerM: [
    [1200, 300],
    [300, 1200],
  ],
  conductivity: 5.8e7,
  thicknessM: 35e-6,
};

const conductor = {
  kind: 'RectangleConductors',
  id: 'signal',
  isGround: false,
  conductivity: 5.8e7,
  number: 1,
  pitch: 0,
  xOffset: 0,
  yOffset: 0,
  width: 200,
  height: 35,
};

function solveResultOne() {
  return {
    nSignals: 1,
    names: ['Cond3R0'],
    B: [[100e-12]],
    L: [[250e-9]],
    Rdc: [[2.5]],
    z0: [50],
    epsEff: [3],
    velocity: [2e8],
    delay: [5e-9],
    fxt: [],
    bxt: [],
    warnings: [],
  };
}

function solveResultPair() {
  return {
    nSignals: 2,
    names: ['Cond3R0', 'Cond3R1'],
    B: [
      [110e-12, -20e-12],
      [-20e-12, 110e-12],
    ],
    L: [
      [280e-9, 35e-9],
      [35e-9, 280e-9],
    ],
    Rdc: [
      [2.5, 0],
      [0, 2.5],
    ],
    z0: [50, 50],
    zOdd: 43.4,
    zEven: 59.1,
    epsEff: [3, 3],
    velocity: [2e8, 2e8],
    velocityOdd: 2e8,
    velocityEven: 2e8,
    delay: [5e-9, 5e-9],
    delayOdd: 5e-9,
    delayEven: 5e-9,
    fxt: [],
    bxt: [],
    warnings: [],
  };
}

function solveResultFloatingPair() {
  return {
    nSignals: 1,
    names: ['PairC0'],
    floatingDifferential: {
      positiveName: 'PairC0',
      negativeName: 'PairC1',
    },
    B: [[50e-12]],
    L: [[500e-9]],
    Rdc: [[2.5]],
    z0: [100],
    epsEff: [2.25],
    velocity: [2e8],
    delay: [5e-9],
    fxt: [],
    bxt: [],
    warnings: [],
  };
}

function solveResultSix() {
  const count = 6;
  const names = [
    'Trap3T0',
    'Cond4R1',
    'Cond4R2',
    'Cond5R3',
    'Cond5R4',
    'Trap6T5',
  ];
  const B = Array.from({ length: count }, (_, row) =>
    Array.from({ length: count }, (_, column) => {
      if (row === column) return 120e-12;
      return Math.abs(row - column) === 1 ? -10e-12 : 0;
    }));
  const L = Array.from({ length: count }, (_, row) =>
    Array.from({ length: count }, (_, column) => {
      if (row === column) return 270e-9;
      return Math.abs(row - column) === 1 ? 20e-9 : 0;
    }));
  const Rdc = Array.from({ length: count }, (_, row) =>
    Array.from({ length: count }, (_, column) =>
      row === column ? 2.5 + row * 0.1 : 0));
  return {
    nSignals: count,
    names,
    B,
    L,
    Rdc,
    z0: Array(count).fill(50),
    epsEff: Array(count).fill(3),
    velocity: Array(count).fill(2e8),
    delay: Array(count).fill(5e-9),
    fxt: [],
    bxt: [],
    warnings: [],
  };
}

function input(result, overrides = {}) {
  return {
    title: 'Example PCB Line',
    flow: result.nSignals === 1 ? 'preset-se' : 'preset-diff',
    result,
    conductors: Array.from({ length: result.nSignals }, () => ({ ...conductor })),
    unitScaleM: 1e-6,
    lengthM: 0.0254,
    designFreqHz: 1e9,
    lossParams,
    tanD: 0.016,
    ...overrides,
  };
}

function magnitude(value) {
  return Math.hypot(value.re, value.im);
}

function assertNear(actual, expected, label, rel = 1e-10) {
  const tolerance = Math.max(1e-20, Math.abs(expected) * rel);
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} != ${expected} (tol ${tolerance})`,
  );
}

function smoothSignalResistanceAt(modelInput, conductorIndex, frequencyHz) {
  const signal = modelInput.conductors[conductorIndex];
  const perimeterM = signal.kind === 'CircleConductors'
    ? Math.PI * signal.diameter * modelInput.unitScaleM
    : signal.kind === 'TrapezoidConductors'
      ? (
          signal.topWidth + signal.bottomWidth +
          2 * Math.hypot(signal.height, (signal.bottomWidth - signal.topWidth) / 2)
        ) * modelInput.unitScaleM
      : 2 * (signal.width + signal.height) * modelInput.unitScaleM;
  const skinCoefficient =
    Math.sqrt(Math.PI * MU0 / signal.conductivity) / perimeterM;
  return Math.hypot(
    modelInput.result.Rdc[conductorIndex][conductorIndex],
    skinCoefficient * Math.sqrt(frequencyHz),
  );
}

test('uniform-line two-port is matched and reciprocal for an ideal 50-ohm line', () => {
  const frequencyHz = 1e9;
  const lengthM = 0.01;
  const inductance = 250e-9;
  const capacitance = 100e-12;
  const s = uniformLineSParameters(
    0,
    inductance,
    0,
    capacitance,
    frequencyHz,
    lengthM,
  );
  const expectedPhase = -2 * Math.PI * frequencyHz *
    Math.sqrt(inductance * capacitance) * lengthM;
  assert.ok(magnitude(s[0][0]) < 1e-12);
  assert.ok(magnitude(s[1][1]) < 1e-12);
  assertNear(magnitude(s[1][0]), 1, '|S21|');
  assertNear(s[1][0].re, Math.cos(expectedPhase), 'Re(S21)');
  assertNear(s[1][0].im, Math.sin(expectedPhase), 'Im(S21)');
  assertNear(s[0][1].re, s[1][0].re, 'S12 reciprocal real');
  assertNear(s[0][1].im, s[1][0].im, 'S12 reciprocal imaginary');
});

test('one-conductor matrix line agrees with the scalar uniform-line calculation', () => {
  const resistance = 3.2;
  const inductance = 270e-9;
  const conductance = 1.1e-4;
  const capacitance = 105e-12;
  const frequencyHz = 2.4e9;
  const lengthM = 0.037;
  const scalar = uniformLineSParameters(
    resistance,
    inductance,
    conductance,
    capacitance,
    frequencyHz,
    lengthM,
  );
  const matrix = multiconductorLineSParameters(
    [[resistance]],
    [[inductance]],
    [[conductance]],
    [[capacitance]],
    frequencyHz,
    lengthM,
  );
  for (let row = 0; row < 2; row++) {
    for (let column = 0; column < 2; column++) {
      assertNear(
        matrix[row][column].re,
        scalar[row][column].re,
        `matrix S${row + 1}${column + 1} real`,
        1e-8,
      );
      assertNear(
        matrix[row][column].im,
        scalar[row][column].im,
        `matrix S${row + 1}${column + 1} imaginary`,
        1e-8,
      );
    }
  }
});

test('Touchstone .s2p uses conservative v1 header, sweep, and two-port rows', () => {
  const file = exportTouchstoneS2p(input(solveResultOne()));
  assert.equal(file.filename, 'Example-PCB-Line.s2p');
  assert.match(file.text, /^! Web-MMTL/m);
  assert.match(file.text, /^# Hz S RI R 50$/m);
  assert.match(file.text, /Port 1 = input \/ near end/);
  assert.match(file.text, /reference-plane loss is excluded/i);
  const dataRows = file.text
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('!') && !line.startsWith('#'));
  assert.equal(dataRows.length, lossParams.nPoints);
  const frequencies = dataRows.map((line) => {
    const tokens = line.trim().split(/\s+/).map(Number);
    assert.equal(tokens.length, 9);
    assert.ok(tokens.every(Number.isFinite));
    return tokens[0];
  });
  for (let index = 1; index < frequencies.length; index++) {
    assert.ok(frequencies[index] > frequencies[index - 1]);
  }
});

test('Touchstone .s2p uses BEM dielectric participation instead of a global tan(delta)', () => {
  const frequencyHz = 2e9;
  const lossCapacitance = 4.7e-12;
  const modelInput = input(solveResultOne(), {
    tanD: 0,
    dielectricLoss: {
      source: 'bem-participation',
      lossCapacitancePerM: [[lossCapacitance]],
    },
    lossParams: {
      ...lossParams,
      roughnessModel: 'none',
      fMinHz: frequencyHz,
      fMaxHz: frequencyHz,
      nPoints: 2,
    },
  });
  const file = exportTouchstoneS2p(modelInput);
  const row = file.text
    .split(/\r?\n/)
    .find((line) => line && !line.startsWith('!') && !line.startsWith('#'));
  assert.ok(row);
  const tokens = row.trim().split(/\s+/).map(Number);
  const actual = [
    [
      { re: tokens[1], im: tokens[2] },
      { re: tokens[5], im: tokens[6] },
    ],
    [
      { re: tokens[3], im: tokens[4] },
      { re: tokens[7], im: tokens[8] },
    ],
  ];
  const expected = uniformLineSParameters(
    smoothSignalResistanceAt(modelInput, 0, frequencyHz),
    modelInput.result.L[0][0],
    2 * Math.PI * frequencyHz * lossCapacitance,
    modelInput.result.B[0][0],
    frequencyHz,
    modelInput.lengthM,
  );
  const scalarFallback = uniformLineSParameters(
    smoothSignalResistanceAt(modelInput, 0, frequencyHz),
    modelInput.result.L[0][0],
    0,
    modelInput.result.B[0][0],
    frequencyHz,
    modelInput.lengthM,
  );
  for (let response = 0; response < 2; response++) {
    for (let stimulus = 0; stimulus < 2; stimulus++) {
      assertNear(
        actual[response][stimulus].re,
        expected[response][stimulus].re,
        `participation S${response + 1}${stimulus + 1} real`,
        1e-9,
      );
      assertNear(
        actual[response][stimulus].im,
        expected[response][stimulus].im,
        `participation S${response + 1}${stimulus + 1} imaginary`,
        1e-9,
      );
    }
  }
  assert.ok(
    Math.abs(magnitude(actual[1][0]) - magnitude(scalarFallback[1][0])) > 1e-5,
    'the matrix participation loss must not fall back to tanD=0',
  );
});

test('arbitrary Touchstone uses the full heterogeneous dielectric-loss matrix', () => {
  const frequencyHz = 1.5e9;
  const result = solveResultPair();
  const lossCapacitancePerM = [
    [5.2e-12, -1.1e-12],
    [-1.1e-12, 2.9e-12],
  ];
  const modelInput = input(result, {
    flow: 'arbitrary',
    tanD: 0,
    dielectricLoss: {
      source: 'bem-participation',
      lossCapacitancePerM,
    },
    lossParams: {
      ...lossParams,
      roughnessModel: 'none',
      fMinHz: frequencyHz,
      fMaxHz: frequencyHz,
      nPoints: 2,
    },
  });
  const file = exportTouchstoneNPort(modelInput);
  const rows = file.text
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('!') && !line.startsWith('#'));
  assert.equal(rows.length, 4);
  const actual = rows.map((line, rowIndex) => {
    const tokens = line.trim().split(/\s+/).map(Number);
    const offset = rowIndex === 0 ? 1 : 0;
    return Array.from({ length: 4 }, (_, column) => ({
      re: tokens[offset + 2 * column],
      im: tokens[offset + 2 * column + 1],
    }));
  });
  const resistance = [
    [smoothSignalResistanceAt(modelInput, 0, frequencyHz), 0],
    [0, smoothSignalResistanceAt(modelInput, 1, frequencyHz)],
  ];
  const conductance = lossCapacitancePerM.map((row) =>
    row.map((value) => 2 * Math.PI * frequencyHz * value));
  const expected = multiconductorLineSParameters(
    resistance,
    result.L,
    conductance,
    result.B,
    frequencyHz,
    modelInput.lengthM,
  );

  for (let response = 0; response < 4; response++) {
    for (let stimulus = 0; stimulus < 4; stimulus++) {
      assertNear(
        actual[response][stimulus].re,
        expected[response][stimulus].re,
        `heterogeneous S${response + 1}${stimulus + 1} real`,
        1e-8,
      );
      assertNear(
        actual[response][stimulus].im,
        expected[response][stimulus].im,
        `heterogeneous S${response + 1}${stimulus + 1} imaginary`,
        1e-8,
      );
    }
  }
});

test('Touchstone S2P and arbitrary SNP sweeps end one decade above 10 GHz', () => {
  const designFreqHz = 10e9;
  const sweep = {
    ...lossSweepParamsForDesign(lossParams, designFreqHz),
    nPoints: 6,
  };
  const leadingFrequencies = (text) => text
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('!') && !line.startsWith('#'))
    .map((line) => line.trim().split(/\s+/).map(Number))
    // Touchstone data records have one frequency followed by complex pairs.
    // Continuation rows in an N-port matrix contain only the pairs.
    .filter((tokens) => tokens.length % 2 === 1)
    .map((tokens) => tokens[0]);

  const s2p = exportTouchstoneS2p(input(solveResultOne(), {
    designFreqHz,
    lossParams: sweep,
  }));
  const snp = exportTouchstoneNPort(input(solveResultPair(), {
    flow: 'arbitrary',
    designFreqHz,
    lossParams: sweep,
  }));

  const s2pFrequencies = leadingFrequencies(s2p.text);
  const snpFrequencies = leadingFrequencies(snp.text);
  assert.equal(s2pFrequencies.length, sweep.nPoints);
  assert.equal(snpFrequencies.length, sweep.nPoints);
  assert.equal(s2pFrequencies.at(-1), 100e9);
  assert.equal(snpFrequencies.at(-1), 100e9);
});

test('Touchstone .s2p includes the analytic reference-plane resistance', () => {
  const frequencyHz = 1e9;
  const params = {
    ...lossParams,
    includeReferencePlaneLoss: true,
    roughnessModel: 'none',
    fMinHz: frequencyHz,
    fMaxHz: frequencyHz,
    nPoints: 2,
  };
  const modelInput = input(solveResultOne(), {
    tanD: 0,
    referencePlane: referencePlaneOne,
    lossParams: params,
  });
  const file = exportTouchstoneS2p(modelInput);
  assert.match(file.text, /Includes analytic finite-thickness reference-plane loss/);

  const row = file.text
    .split(/\r?\n/)
    .find((line) => line && !line.startsWith('!') && !line.startsWith('#'));
  assert.ok(row);
  const tokens = row.trim().split(/\s+/).map(Number);
  const perimeterM =
    2 * (conductor.width + conductor.height) * modelInput.unitScaleM;
  const signalSkinCoefficient =
    Math.sqrt(Math.PI * MU0 / conductor.conductivity) / perimeterM;
  const signalResistance = Math.hypot(
    modelInput.result.Rdc[0][0],
    signalSkinCoefficient * Math.sqrt(frequencyHz),
  );
  const referenceResistance =
    referencePlaneResistanceMatrix(referencePlaneOne, params, frequencyHz)[0][0];
  const expected = uniformLineSParameters(
    signalResistance + referenceResistance,
    modelInput.result.L[0][0],
    0,
    modelInput.result.B[0][0],
    frequencyHz,
    modelInput.lengthM,
  );
  const actual = [
    [
      { re: tokens[1], im: tokens[2] },
      { re: tokens[5], im: tokens[6] },
    ],
    [
      { re: tokens[3], im: tokens[4] },
      { re: tokens[7], im: tokens[8] },
    ],
  ];
  for (let response = 0; response < 2; response++) {
    for (let stimulus = 0; stimulus < 2; stimulus++) {
      assertNear(
        actual[response][stimulus].re,
        expected[response][stimulus].re,
        `reference-loss S${response + 1}${stimulus + 1} real`,
        1e-10,
      );
      assertNear(
        actual[response][stimulus].im,
        expected[response][stimulus].im,
        `reference-loss S${response + 1}${stimulus + 1} imaginary`,
        1e-10,
      );
    }
  }
});

test('mesh reference-loss terms are identified in every export format', () => {
  const meshReference = {
    source: 'mesh',
    terms: [
      {
        geometryPerM: [[900]],
        conductivity: 5.8e7,
        thicknessM: 35e-6,
        label: 'bottom plane',
      },
      {
        geometryPerM: [[240]],
        conductivity: 1.5e7,
        thicknessM: 12e-6,
        label: 'coplanar grounds',
      },
    ],
  };
  const modelInput = input(solveResultOne(), {
    referencePlane: meshReference,
    lossParams: {
      ...lossParams,
      includeReferencePlaneLoss: true,
    },
  });
  assert.match(
    exportTouchstoneS2p(modelInput).text,
    /Includes mesh-derived finite-thickness reference-plane loss/,
  );
  assert.match(
    exportHspiceWElement(modelInput).text,
    /mesh-derived reference-plane DC and high-frequency smooth asymptotes/,
  );
  assert.match(
    exportGenericSpiceSubcircuit(modelInput, 1).text,
    /Mesh-derived reference-plane loss is included/,
  );
});

test('export validation checks every mesh reference-loss term', () => {
  const base = {
    source: 'mesh',
    terms: [
      {
        geometryPerM: [[900]],
        conductivity: 5.8e7,
        thicknessM: 35e-6,
      },
    ],
  };
  const enabled = {
    ...lossParams,
    includeReferencePlaneLoss: true,
  };
  assert.throws(
    () => exportTouchstoneS2p(input(solveResultOne(), {
      referencePlane: {
        ...base,
        terms: [
          ...base.terms,
          {
            geometryPerM: [[100, 0]],
            conductivity: 5.8e7,
            thicknessM: 35e-6,
          },
        ],
      },
      lossParams: enabled,
    })),
    /Reference-plane overlap term 2 must be a complete 1 by 1 matrix/,
  );
  assert.throws(
    () => exportTouchstoneS2p(input(solveResultOne(), {
      referencePlane: {
        ...base,
        terms: [
          ...base.terms,
          {
            geometryPerM: [[100]],
            conductivity: 0,
            thicknessM: 35e-6,
          },
        ],
      },
      lossParams: enabled,
    })),
    /reference-plane material properties term 2 are invalid/i,
  );
});

test('Touchstone .s4p uses IEEE/IBIS 13-24 mapping and row-major v1 matrices', () => {
  const result = solveResultPair();
  assert.equal(supportsDifferentialTouchstone(result), true);
  const file = exportTouchstoneS4p(input(result, {
    lossParams: { ...lossParams, fMinHz: 1e9, fMaxHz: 1e9, nPoints: 2 },
  }));
  assert.equal(file.filename, 'Example-PCB-Line.s4p');
  assert.match(file.text, /Port 1 = IN\+, Port 2 = OUT\+, Port 3 = IN-, Port 4 = OUT-/);
  const rows = file.text
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('!') && !line.startsWith('#'));
  assert.equal(rows.length, 4);
  assert.equal(rows[0].trim().split(/\s+/).length, 9);
  for (let row = 1; row < 4; row++) {
    assert.equal(rows[row].trim().split(/\s+/).length, 8);
  }

  const values = rows.map((line, row) => {
    const tokens = line.trim().split(/\s+/).map(Number);
    const offset = row === 0 ? 1 : 0;
    return Array.from({ length: 4 }, (_, column) => ({
      re: tokens[offset + column * 2],
      im: tokens[offset + column * 2 + 1],
    }));
  });
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 4; column++) {
      assertNear(values[row][column].re, values[column][row].re, `S${row + 1}${column + 1} reciprocal real`, 1e-8);
      assertNear(values[row][column].im, values[column][row].im, `S${row + 1}${column + 1} reciprocal imag`, 1e-8);
    }
  }
});

test('mixed-mode SDD .s2p matches the differential block derived from .s4p', () => {
  const modelInput = input(solveResultPair(), {
    referencePlane: referencePlanePair,
    lossParams: {
      ...lossParams,
      includeReferencePlaneLoss: true,
      fMinHz: 1e9,
      fMaxHz: 1e9,
      nPoints: 2,
    },
  });
  const full = exportTouchstoneS4p(modelInput);
  const reduced = exportTouchstoneDifferentialS2p(modelInput);
  assert.equal(reduced.filename, 'Example-PCB-Line-sdd.s2p');
  assert.match(reduced.text, /^# Hz S RI R 100$/m);
  assert.match(reduced.text, /Contains SDD only; common-mode and mode-conversion terms are omitted/);

  const fullRows = full.text
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('!') && !line.startsWith('#'));
  const s4p = fullRows.map((line, row) => {
    const tokens = line.trim().split(/\s+/).map(Number);
    const offset = row === 0 ? 1 : 0;
    return Array.from({ length: 4 }, (_, column) => ({
      re: tokens[offset + column * 2],
      im: tokens[offset + column * 2 + 1],
    }));
  });

  const reducedRow = reduced.text
    .split(/\r?\n/)
    .find((line) => line && !line.startsWith('!') && !line.startsWith('#'));
  assert.ok(reducedRow);
  const tokens = reducedRow.trim().split(/\s+/).map(Number);
  assert.equal(tokens.length, 9);
  const sdd = [
    [
      { re: tokens[1], im: tokens[2] },
      { re: tokens[5], im: tokens[6] },
    ],
    [
      { re: tokens[3], im: tokens[4] },
      { re: tokens[7], im: tokens[8] },
    ],
  ];
  const positive = [0, 1];
  const negative = [2, 3];
  for (let response = 0; response < 2; response++) {
    for (let stimulus = 0; stimulus < 2; stimulus++) {
      const pp = s4p[positive[response]][positive[stimulus]];
      const pn = s4p[positive[response]][negative[stimulus]];
      const np = s4p[negative[response]][positive[stimulus]];
      const nn = s4p[negative[response]][negative[stimulus]];
      const expected = {
        re: (pp.re - pn.re - np.re + nn.re) / 2,
        im: (pp.im - pn.im - np.im + nn.im) / 2,
      };
      assertNear(sdd[response][stimulus].re, expected.re, `SDD${response + 1}${stimulus + 1} real`, 1e-9);
      assertNear(sdd[response][stimulus].im, expected.im, `SDD${response + 1}${stimulus + 1} imag`, 1e-9);
    }
  }
});

test('mixed-mode SDD uses half the odd-mode dielectric loss factor', () => {
  const frequencyHz = 2.2e9;
  const result = solveResultPair();
  const lossCapacitancePerM = [
    [6e-12, -2e-12],
    [-2e-12, 6e-12],
  ];
  const modelInput = input(result, {
    tanD: 0,
    dielectricLoss: {
      source: 'bem-participation',
      lossCapacitancePerM,
    },
    lossParams: {
      ...lossParams,
      roughnessModel: 'none',
      fMinHz: frequencyHz,
      fMaxHz: frequencyHz,
      nPoints: 2,
    },
  });
  const file = exportTouchstoneDifferentialS2p(modelInput);
  const row = file.text
    .split(/\r?\n/)
    .find((line) => line && !line.startsWith('!') && !line.startsWith('#'));
  assert.ok(row);
  const tokens = row.trim().split(/\s+/).map(Number);
  const actual = [
    [
      { re: tokens[1], im: tokens[2] },
      { re: tokens[5], im: tokens[6] },
    ],
    [
      { re: tokens[3], im: tokens[4] },
      { re: tokens[7], im: tokens[8] },
    ],
  ];
  const oddCapacitance = result.B[0][0] - result.B[0][1];
  const oddInductance = result.L[0][0] - result.L[0][1];
  const oddLossCapacitance =
    (lossCapacitancePerM[0][0] + lossCapacitancePerM[1][1] -
      lossCapacitancePerM[0][1] - lossCapacitancePerM[1][0]) / 2;
  const expected = uniformLineSParameters(
    2 * smoothSignalResistanceAt(modelInput, 0, frequencyHz),
    2 * oddInductance,
    2 * Math.PI * frequencyHz * oddLossCapacitance / 2,
    oddCapacitance / 2,
    frequencyHz,
    modelInput.lengthM,
    100,
  );
  for (let response = 0; response < 2; response++) {
    for (let stimulus = 0; stimulus < 2; stimulus++) {
      assertNear(
        actual[response][stimulus].re,
        expected[response][stimulus].re,
        `SDD participation S${response + 1}${stimulus + 1} real`,
        1e-9,
      );
      assertNear(
        actual[response][stimulus].im,
        expected[response][stimulus].im,
        `SDD participation S${response + 1}${stimulus + 1} imaginary`,
        1e-9,
      );
    }
  }
});

test('asymmetric pairs are blocked from modal .s4p export', () => {
  const result = solveResultPair();
  result.B[1][1] *= 1.2;
  assert.equal(supportsDifferentialTouchstone(result), false);
  assert.throws(
    () => exportTouchstoneS4p(input(result)),
    /symmetric two-signal differential pair/,
  );
});

test('arbitrary two-conductor models cannot enter the guided differential flow', () => {
  const modelInput = input(solveResultPair(), { flow: 'arbitrary' });
  assert.throws(
    () => exportTouchstoneS4p(modelInput),
    /guided differential-pair flow/,
  );
  assert.throws(
    () => exportTouchstoneDifferentialS2p(modelInput),
    /guided differential-pair flow/,
  );
  assert.equal(exportTouchstoneNPort(modelInput).filename, 'Example-PCB-Line.s4p');
});

test('13-24 .s4p ordering keeps each uncoupled conductor on ports 1-2 and 3-4', () => {
  const result = solveResultPair();
  result.B = [
    [100e-12, 0],
    [0, 100e-12],
  ];
  result.L = [
    [250e-9, 0],
    [0, 250e-9],
  ];
  const file = exportTouchstoneS4p(input(result, {
    tanD: 0,
    lossParams: {
      ...lossParams,
      roughnessModel: 'none',
      fMinHz: 1e9,
      fMaxHz: 1e9,
      nPoints: 2,
    },
  }));
  const rows = file.text
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('!') && !line.startsWith('#'));
  const s = rows.map((line, row) => {
    const tokens = line.trim().split(/\s+/).map(Number);
    const offset = row === 0 ? 1 : 0;
    return Array.from({ length: 4 }, (_, column) => ({
      re: tokens[offset + column * 2],
      im: tokens[offset + column * 2 + 1],
    }));
  });
  assert.ok(magnitude(s[1][0]) > 0.5, 'port 1 transmits to port 2');
  assert.ok(magnitude(s[3][2]) > 0.5, 'port 3 transmits to port 4');
  assert.ok(magnitude(s[2][0]) < 1e-12, 'port 1 has no near-end cross coupling');
  assert.ok(magnitude(s[3][0]) < 1e-12, 'port 1 has no far-end cross coupling');
});

test('six arbitrary conductors export a complete Touchstone 1.0 .s12p', () => {
  const result = solveResultSix();
  const file = exportTouchstoneNPort(input(result, {
    flow: 'arbitrary',
    lossParams: {
      ...lossParams,
      fMinHz: 1e9,
      fMaxHz: 1e9,
      nPoints: 2,
    },
  }));
  assert.equal(file.filename, 'Example-PCB-Line.s12p');
  assert.match(file.text, /Port 1 = Trap3T0_IN \(near end\)/);
  assert.match(file.text, /Port 2 = Trap3T0_OUT \(far end\)/);
  assert.match(file.text, /Port 11 = Trap6T5_IN \(near end\)/);
  assert.match(file.text, /Port 12 = Trap6T5_OUT \(far end\)/);
  assert.match(file.text, /^# Hz S RI R 50$/m);

  const rows = file.text
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('!') && !line.startsWith('#'));
  assert.equal(rows.length, 36, '12 matrix rows, wrapped into three lines each');
  assert.equal(rows[0].trim().split(/\s+/).length, 9);
  for (const row of rows.slice(1)) {
    assert.equal(row.trim().split(/\s+/).length, 8);
  }
  const numeric = rows.flatMap((line) => line.trim().split(/\s+/).map(Number));
  assert.equal(numeric.length, 1 + 2 * 12 * 12);
  assert.ok(numeric.every(Number.isFinite));
});

test('floating pair exports a differential-only 100-ohm Touchstone .s2p', () => {
  const result = solveResultFloatingPair();
  const file = exportTouchstoneNPort(input(result, { flow: 'arbitrary' }));
  assert.equal(file.filename, 'Example-PCB-Line.s2p');
  assert.match(file.text, /floating differential-pair transmission-line model/);
  assert.match(
    file.text,
    /Port 1 = differential input: PairC0_IN relative to PairC1_IN/,
  );
  assert.match(
    file.text,
    /Port 2 = differential output: PairC0_OUT relative to PairC1_OUT/,
  );
  assert.match(file.text, /common-mode behavior is not available/);
  assert.match(file.text, /^# Hz S RI R 100$/m);
  assert.match(file.text, /Re\(SDD11\).*Re\(SDD21\).*Re\(SDD12\).*Re\(SDD22\)/);
});

test('arbitrary Touchstone keeps each uncoupled conductor on its adjacent port pair', () => {
  const result = solveResultSix();
  result.B = result.B.map((row, rowIndex) =>
    row.map((_, columnIndex) => rowIndex === columnIndex ? 100e-12 : 0));
  result.L = result.L.map((row, rowIndex) =>
    row.map((_, columnIndex) => rowIndex === columnIndex ? 250e-9 : 0));
  const file = exportTouchstoneNPort(input(result, {
    flow: 'arbitrary',
    tanD: 0,
    lossParams: {
      ...lossParams,
      roughnessModel: 'none',
      fMinHz: 1e9,
      fMaxHz: 1e9,
      nPoints: 2,
    },
  }));
  const rows = file.text
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('!') && !line.startsWith('#'));
  const tokens = rows.flatMap((line) => line.trim().split(/\s+/).map(Number));
  const values = tokens.slice(1);
  const s = Array.from({ length: 12 }, (_, row) =>
    Array.from({ length: 12 }, (_, column) => ({
      re: values[2 * (row * 12 + column)],
      im: values[2 * (row * 12 + column) + 1],
    })));
  for (let conductorIndex = 0; conductorIndex < 6; conductorIndex++) {
    const near = 2 * conductorIndex;
    const far = near + 1;
    assert.ok(magnitude(s[far][near]) > 0.5);
    for (let response = 0; response < 12; response++) {
      if (response !== far && response !== near) {
        assert.ok(
          magnitude(s[response][near]) < 1e-10,
          `port ${near + 1} should not couple to port ${response + 1}`,
        );
      }
    }
  }
});

test('HSPICE W .wlc follows positional lower-triangle order and SI units', () => {
  const modelInput = input(solveResultOne());
  const file = exportHspiceWElement(modelInput);
  assert.equal(file.filename, 'Example-PCB-Line.wlc');
  assert.match(file.text, /Positional external-file order: N, L0, C0, R0, G0, Rs, Gd/);
  assert.match(file.text, /RLGCfile=Example-PCB-Line\.wlc/);
  const numeric = file.text
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('*'))
    .flatMap((line) => line.trim().split(/\s+/).map(Number));
  assert.equal(numeric.length, 7);
  assert.equal(numeric[0], 1);
  assertNear(numeric[1], modelInput.result.L[0][0], 'W L0');
  assertNear(numeric[2], modelInput.result.B[0][0], 'W C0');
  const expectedR0 =
    1 / (conductor.width * conductor.height * 1e-12 * conductor.conductivity);
  assertNear(numeric[3], expectedR0, 'W R0');
  assert.equal(numeric[4], 0);
  assert.ok(numeric[5] > 0);
  assertNear(
    numeric[6],
    2 * Math.PI * modelInput.result.B[0][0] * modelInput.tanD,
    'W Gd',
  );
});

test('HSPICE W keeps two-conductor lower triangles in solver order', () => {
  const modelInput = input(solveResultPair());
  const file = exportHspiceWElement(modelInput);
  const numeric = file.text
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('*'))
    .flatMap((line) => line.trim().split(/\s+/).map(Number));
  assert.equal(numeric.length, 19);
  assert.deepEqual(numeric.slice(0, 4), [
    2,
    modelInput.result.L[0][0],
    modelInput.result.L[1][0],
    modelInput.result.L[1][1],
  ]);
  assert.deepEqual(numeric.slice(4, 7), [
    modelInput.result.B[0][0],
    modelInput.result.B[1][0],
    modelInput.result.B[1][1],
  ]);
  assert.equal(numeric[8], 0, 'R0 mutual term is zero');
  assert.deepEqual(numeric.slice(10, 13), [0, 0, 0], 'G0 is zero');
  assert.equal(numeric[14], 0, 'Rs mutual term is zero');
});

test('HSPICE W Gd is 2*pi times the BEM dielectric loss-capacitance matrix', () => {
  const lossCapacitancePerM = [
    [4.8e-12, -1.3e-12],
    [-1.3e-12, 2.6e-12],
  ];
  const modelInput = input(solveResultPair(), {
    tanD: 0.9,
    dielectricLoss: {
      source: 'bem-participation',
      lossCapacitancePerM,
    },
  });
  const file = exportHspiceWElement(modelInput);
  const numeric = file.text
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('*'))
    .flatMap((line) => line.trim().split(/\s+/).map(Number));
  // N plus six lower-triangle matrices. For N=2, Gd occupies the final
  // three values in row-major lower-triangle order: (0,0), (1,0), (1,1).
  assert.equal(numeric.length, 19);
  assertNear(numeric[16], 2 * Math.PI * lossCapacitancePerM[0][0], 'W Gd 00');
  assertNear(numeric[17], 2 * Math.PI * lossCapacitancePerM[1][0], 'W Gd 10');
  assertNear(numeric[18], 2 * Math.PI * lossCapacitancePerM[1][1], 'W Gd 11');
  assert.notEqual(
    numeric[16],
    2 * Math.PI * modelInput.result.B[0][0] * modelInput.tanD,
    'Gd must not use the scalar fallback when a BEM model is present',
  );
});

test('HSPICE W includes full shared reference-plane R0 and Rs matrices', () => {
  const modelInput = input(solveResultPair(), {
    referencePlane: referencePlanePair,
    lossParams: {
      ...lossParams,
      includeReferencePlaneLoss: true,
    },
  });
  const file = exportHspiceWElement(modelInput);
  assert.match(
    file.text,
    /R0 and Rs include the analytic reference-plane DC and high-frequency smooth asymptotes/,
  );
  const numeric = file.text
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('*'))
    .flatMap((line) => line.trim().split(/\s+/).map(Number));
  const referenceR0 = referencePlaneDcResistanceMatrix(referencePlanePair);
  const referenceRs =
    referencePlaneSkinCoefficientMatrix(referencePlanePair);
  const signalR0 =
    1 / (conductor.width * conductor.height * 1e-12 * conductor.conductivity);
  const signalRs =
    Math.sqrt(Math.PI * MU0 / conductor.conductivity) /
    (2 * (conductor.width + conductor.height) * 1e-6);
  assertNear(numeric[7], signalR0 + referenceR0[0][0], 'W plane R0 self 1');
  assertNear(numeric[8], referenceR0[1][0], 'W plane R0 mutual');
  assertNear(numeric[9], signalR0 + referenceR0[1][1], 'W plane R0 self 2');
  assertNear(numeric[13], signalRs + referenceRs[0][0], 'W plane Rs self 1');
  assertNear(numeric[14], referenceRs[1][0], 'W plane Rs mutual');
  assertNear(numeric[15], signalRs + referenceRs[1][1], 'W plane Rs self 2');
});

test('HSPICE W supports six conductors and documents internal node names', () => {
  const result = solveResultSix();
  const file = exportHspiceWElement(input(result, { flow: 'arbitrary' }));
  assert.match(file.text, /\* Trap3T0: near=Trap3T0_IN, far=Trap3T0_OUT/);
  assert.match(file.text, /\* Trap6T5: near=Trap6T5_IN, far=Trap6T5_OUT/);
  assert.match(
    file.text,
    /\* Usage: W1 Trap3T0_IN Cond4R1_IN Cond4R2_IN Cond5R3_IN Cond5R4_IN Trap6T5_IN 0 Trap3T0_OUT Cond4R1_OUT Cond4R2_OUT Cond5R3_OUT Cond5R4_OUT Trap6T5_OUT 0 N=6 /,
  );
  const numeric = file.text
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('*'))
    .flatMap((line) => line.trim().split(/\s+/).map(Number));
  assert.equal(numeric.length, 127);
  assert.equal(numeric[0], 6);
  assert.ok(numeric.every(Number.isFinite));
});

test('floating-pair HSPICE W uses the physical negative conductor as reference', () => {
  const result = solveResultFloatingPair();
  const file = exportHspiceWElement(input(result, { flow: 'arbitrary' }));
  assert.match(file.text, /\* Differential loop: PairC0 \(\+\), PairC1 \(-\)/);
  assert.match(
    file.text,
    /\* Usage: W1 PairC0_IN PairC1_IN PairC0_OUT PairC1_OUT N=1 /,
  );
  assert.doesNotMatch(file.text, /\* Usage: W1 .*\s0\s/);
  assert.match(file.text, /N=1 contains the solved differential mode only/);
});

test('generic SPICE ladder emits only basic compatible primitives', () => {
  const file = exportGenericSpiceSubcircuit(input(solveResultOne()), 2);
  assert.equal(file.filename, 'Example-PCB-Line.cir');
  assert.match(file.text, /^\.SUBCKT EXAMPLE_PCB_LINE IN OUT REF$/m);
  assert.match(file.text, /^\.ENDS EXAMPLE_PCB_LINE$/m);
  assert.equal((file.text.match(/^R\d+[AB] /gm) ?? []).length, 4);
  assert.equal((file.text.match(/^L\d+[AB] /gm) ?? []).length, 4);
  assert.equal((file.text.match(/^C\d+ /gm) ?? []).length, 2);
  assert.doesNotMatch(file.text, /\{|\}/);
});

test('generic SPICE does not silently cap a required section count at 200', () => {
  const file = exportGenericSpiceSubcircuit(input(solveResultOne()), 201);
  assert.match(file.text, /^\* 201 symmetric T sections /m);
  assert.equal((file.text.match(/^C\d+ /gm) ?? []).length, 201);
});

test('single-ended generic SPICE folds reference-plane loss into its series R', () => {
  const excludedInput = input(solveResultOne());
  const includedInput = input(solveResultOne(), {
    referencePlane: referencePlaneOne,
    lossParams: {
      ...lossParams,
      includeReferencePlaneLoss: true,
    },
  });
  const excluded = exportGenericSpiceSubcircuit(excludedInput, 1);
  const included = exportGenericSpiceSubcircuit(includedInput, 1);
  const resistor = (text) => Number(
    text.match(/^R1A\s+\S+\s+\S+\s+(\S+)$/m)?.[1],
  );
  const delta = resistor(included.text) - resistor(excluded.text);
  const reference = referencePlaneResistanceMatrix(
    referencePlaneOne,
    includedInput.lossParams,
    includedInput.designFreqHz,
  )[0][0];
  assertNear(
    delta,
    reference * includedInput.lengthM / 2,
    'single-ended ladder reference resistance',
  );
  assert.match(
    included.text,
    /Analytic reference-plane loss is included in the design-frequency series resistance/,
  );
});

test('differential SPICE ladder preserves pair pins and mutual L/C coupling', () => {
  const file = exportGenericSpiceSubcircuit(input(solveResultPair()), 1);
  assert.match(
    file.text,
    /^\.SUBCKT EXAMPLE_PCB_LINE IN_P IN_N OUT_P OUT_N REF$/m,
  );
  assert.match(file.text, /^K1A L1PA L1NA /m);
  assert.match(file.text, /^K1B L1PB L1NB /m);
  assert.match(file.text, /^C1PN S1PM S1NM /m);
  assert.match(file.text, /^RG1PN S1PM S1NM /m);
});

test('generic SPICE ladder decomposes the BEM dielectric-loss matrix into branches', () => {
  const lossCapacitancePerM = [
    [6e-12, -2e-12],
    [-2e-12, 8e-12],
  ];
  const modelInput = input(solveResultPair(), {
    tanD: 0,
    dielectricLoss: {
      source: 'bem-participation',
      lossCapacitancePerM,
    },
    lossParams: {
      ...lossParams,
      roughnessModel: 'none',
    },
  });
  const file = exportGenericSpiceSubcircuit(modelInput, 1);
  const resistor = (name) => {
    const value = file.text.match(
      new RegExp(`^${name}\\s+\\S+\\s+\\S+\\s+(\\S+)$`, 'm'),
    )?.[1];
    assert.ok(value, `${name} is missing`);
    return Number(value);
  };
  const scale = 2 * Math.PI * modelInput.designFreqHz * modelInput.lengthM;
  const groundP = lossCapacitancePerM[0][0] + lossCapacitancePerM[0][1];
  const groundN = lossCapacitancePerM[1][1] + lossCapacitancePerM[1][0];
  const mutual = -(lossCapacitancePerM[0][1] + lossCapacitancePerM[1][0]) / 2;
  assertNear(resistor('RG1P'), 1 / (scale * groundP), 'ladder positive-ground loss');
  assertNear(resistor('RG1N'), 1 / (scale * groundN), 'ladder negative-ground loss');
  assertNear(resistor('RG1PN'), 1 / (scale * mutual), 'ladder mutual loss');
});

test('differential generic SPICE fits reference loss to the odd mode', () => {
  const excludedInput = input(solveResultPair());
  const includedInput = input(solveResultPair(), {
    referencePlane: referencePlanePair,
    lossParams: {
      ...lossParams,
      includeReferencePlaneLoss: true,
    },
  });
  const excluded = exportGenericSpiceSubcircuit(excludedInput, 1);
  const included = exportGenericSpiceSubcircuit(includedInput, 1);
  const resistor = (text) => Number(
    text.match(/^R1PA\s+\S+\s+\S+\s+(\S+)$/m)?.[1],
  );
  const matrix = referencePlaneResistanceMatrix(
    referencePlanePair,
    includedInput.lossParams,
    includedInput.designFreqHz,
  );
  const expectedDelta =
    referencePlaneModeValue(matrix, 'odd') * includedInput.lengthM / 2;
  assertNear(
    resistor(included.text) - resistor(excluded.text),
    expectedDelta,
    'differential ladder odd-mode reference resistance',
  );
  assert.match(included.text, /fitted to the differential odd mode/);
});

test('generic SPICE supports six arbitrary conductors with internal port names', () => {
  const result = solveResultSix();
  const file = exportGenericSpiceSubcircuit(
    input(result, { flow: 'arbitrary' }),
    1,
  );
  const logicalLines = [];
  for (const physicalLine of file.text.split(/\r?\n/)) {
    if (physicalLine.startsWith('+ ')) {
      logicalLines[logicalLines.length - 1] += ` ${physicalLine.slice(2)}`;
    } else {
      logicalLines.push(physicalLine);
    }
  }
  const subckt = logicalLines.find((line) => line.startsWith('.SUBCKT '));
  assert.equal(
    subckt,
    '.SUBCKT EXAMPLE_PCB_LINE Trap3T0_IN Trap3T0_OUT Cond4R1_IN Cond4R1_OUT ' +
      'Cond4R2_IN Cond4R2_OUT Cond5R3_IN Cond5R3_OUT Cond5R4_IN Cond5R4_OUT ' +
      'Trap6T5_IN Trap6T5_OUT REF',
  );
  assert.match(file.text, /\* Signal order: Trap3T0, Cond4R1, Cond4R2, Cond5R3, Cond5R4, Trap6T5/);
  assert.equal((file.text.match(/^R1C\d+[AB] /gm) ?? []).length, 12);
  assert.equal((file.text.match(/^L1C\d+[AB] /gm) ?? []).length, 12);
  assert.equal((file.text.match(/^K1C\d+C\d+[AB] /gm) ?? []).length, 10);
  assert.equal((file.text.match(/^C1C\d+C\d+ /gm) ?? []).length, 5);
  assert.match(file.text, /^\.ENDS EXAMPLE_PCB_LINE$/m);
});

test('floating-pair generic SPICE exposes both physical return terminals', () => {
  const result = solveResultFloatingPair();
  const modelInput = input(result, { flow: 'arbitrary' });
  const file = exportGenericSpiceSubcircuit(modelInput, 1);
  assert.match(
    file.text,
    /^\.SUBCKT EXAMPLE_PCB_LINE PairC0_IN PairC1_IN PairC0_OUT PairC1_OUT$/m,
  );
  assert.doesNotMatch(file.text, /^\.SUBCKT .*\sREF$/m);
  assert.match(file.text, /^C1PN S1PM S1NM /m);
  assert.match(file.text, /^R1PA PairC0_IN /m);
  assert.match(file.text, /^R1NA PairC1_IN /m);
  assert.match(file.text, /^R1PB .* PairC0_OUT /m);
  assert.match(file.text, /^R1NB .* PairC1_OUT /m);
  assert.match(file.text, /only the solved differential mode; common mode is not available/);

  const branchInductance = Number(
    file.text.match(/^L1PA\s+\S+\s+\S+\s+(\S+)$/m)?.[1],
  );
  assertNear(
    branchInductance,
    modelInput.result.L[0][0] * modelInput.lengthM / 4,
    'floating ladder split branch inductance',
  );
});
