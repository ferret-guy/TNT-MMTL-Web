#!/usr/bin/env node
/** Analytic conductor and dielectric loss regressions (Node >= 23). */
import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const {
  lossCurve,
  lossInputsFrom,
  perimeterM,
  presetLossTangentAtFrequency,
  roughnessK,
  skinDepthM,
  striplineEffectiveLossTangent,
} = await import(pathToFileURL(join(root, 'src/analysis/losses.ts')));
const { defaultParams } = await import(pathToFileURL(join(root, 'src/model/presets.ts')));
const { JLCPCB_LAMINATES, materialAtFrequency } = await import(
  pathToFileURL(join(root, 'src/model/materials.ts'))
);

const MU0 = 4e-7 * Math.PI;
const NP_TO_DB = 8.685889638;

function assertNear(actual, expected, label, rel = 1e-12) {
  const tolerance = Math.max(1e-20, Math.abs(expected) * rel);
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} != ${expected} (tol ${tolerance})`,
  );
}

test('lossCurve follows the analytic W-element formulas', () => {
  const inputs = {
    z0: 50,
    cPerM: 100e-12,
    rdcPerM: 2,
    sigma: 5.8e7,
    tanD: 0.02,
    perimeterM: 1e-3,
  };
  const params = {
    roughnessModel: 'none',
    roughnessRqUm: 0,
    hurayRatio: 2.17,
    fMinHz: 1e6,
    fMaxHz: 1e8,
    nPoints: 3,
  };
  const curve = lossCurve(inputs, params);

  assert.deepEqual(curve.fHz, [1e6, 1e7, 1e8]);
  assert.deepEqual(curve.kRough, [1, 1, 1]);
  for (let i = 0; i < curve.fHz.length; i++) {
    const fHz = curve.fHz[i];
    const deltaM = 1 / Math.sqrt(Math.PI * fHz * MU0 * inputs.sigma);
    const rSkin = Math.sqrt(Math.PI * fHz * MU0 / inputs.sigma) / inputs.perimeterM;
    const resistance = Math.hypot(inputs.rdcPerM, rSkin);
    const conductance = 2 * Math.PI * fHz * inputs.cPerM * inputs.tanD;
    const alphaC = (resistance / (2 * inputs.z0)) * NP_TO_DB;
    const alphaD = ((conductance * inputs.z0) / 2) * NP_TO_DB;

    assertNear(curve.skinDepthUm[i], deltaM * 1e6, `skin depth ${i}`);
    assertNear(curve.rOhmPerM[i], resistance, `resistance ${i}`);
    assertNear(curve.gSPerM[i], conductance, `conductance ${i}`);
    assertNear(curve.alphaC[i], alphaC, `conductor attenuation ${i}`);
    assertNear(curve.alphaD[i], alphaD, `dielectric attenuation ${i}`);
    assertNear(curve.alphaTotal[i], alphaC + alphaD, `total attenuation ${i}`);
  }
});

test('lossCurve evaluates frequency-dependent loss tangent at every curve point', () => {
  const seen = [];
  const inputs = {
    z0: 50,
    cPerM: 100e-12,
    rdcPerM: 0,
    sigma: 5.8e7,
    tanD: 0.99,
    tanDAtHz: (fHz) => {
      seen.push(fHz);
      return 0.001 * (Math.log10(fHz) - 5);
    },
    perimeterM: 1e-3,
  };
  const curve = lossCurve(inputs, {
    roughnessModel: 'none',
    roughnessRqUm: 0,
    hurayRatio: 2.17,
    fMinHz: 1e6,
    fMaxHz: 1e8,
    nPoints: 3,
  });

  assert.deepEqual(curve.fHz, [1e6, 1e7, 1e8]);
  assert.deepEqual(seen, curve.fHz);
  for (let i = 0; i < curve.fHz.length; i++) {
    const fHz = curve.fHz[i];
    const tanD = 0.001 * (i + 1);
    const conductance = 2 * Math.PI * fHz * inputs.cPerM * tanD;
    const alphaD = ((conductance * inputs.z0) / 2) * NP_TO_DB;
    assertNear(curve.gSPerM[i], conductance, `dispersive conductance ${i}`);
    assertNear(curve.alphaD[i], alphaD, `dispersive dielectric attenuation ${i}`);
  }
});

test('preset material interpolation drives the plotted IL loss-tangent callback', () => {
  const [np155f, s1000] = JLCPCB_LAMINATES;
  const p = {
    ...defaultParams('microstrip', 'se'),
    laminateId: np155f.id,
  };
  assert.equal(presetLossTangentAtFrequency('microstrip', p, 1e9), 0.014);
  assert.equal(presetLossTangentAtFrequency('microstrip', p, 5e9), 0.016);
  assert.equal(presetLossTangentAtFrequency('microstrip', p, 100e9), 0.017);

  const split = {
    ...defaultParams('stripline', 'se'),
    striplineSeparateMaterials: true,
    laminateId: np155f.id,
    laminateId2: s1000.id,
    h: 10,
    h2: 6,
  };
  const lower = materialAtFrequency(np155f.id, 5e9);
  const upper = materialAtFrequency(s1000.id, 5e9);
  const expected = striplineEffectiveLossTangent(
    lower.er, split.h, lower.tanD,
    upper.er, split.h2, upper.tanD,
  );
  assertNear(
    presetLossTangentAtFrequency('stripline', split, 5e9),
    expected,
    'split-stripline dispersive tanD',
  );
});

test('surface roughness multipliers and skin depth retain their closed forms', () => {
  const fHz = 10e9;
  const sigma = 5.8e7;
  const rqM = 2e-6;
  const hurayRatio = 2.17;
  const deltaM = skinDepthM(fHz, sigma);

  assertNear(deltaM, 1 / Math.sqrt(Math.PI * fHz * MU0 * sigma), 'skin depth');
  assert.equal(roughnessK('none', rqM, deltaM, hurayRatio), 1);
  assert.equal(roughnessK('hammerstad', 0, deltaM, hurayRatio), 1);
  assertNear(
    roughnessK('hammerstad', rqM, deltaM, hurayRatio),
    1 + (2 / Math.PI) * Math.atan(1.4 * (rqM / deltaM) ** 2),
    'Hammerstad multiplier',
  );
  const radiusM = rqM / 2;
  assertNear(
    roughnessK('huray', rqM, deltaM, hurayRatio),
    1 + ((3 / 2) * hurayRatio) /
      (1 + deltaM / radiusM + (deltaM * deltaM) / (2 * radiusM * radiusM)),
    'Huray multiplier',
  );
});

test('mixed stripline loss uses upper/lower electric-energy participation', () => {
  assert.equal(striplineEffectiveLossTangent(4, 8, 0.016, 4, 8, 0.016), 0.016);
  assert.equal(striplineEffectiveLossTangent(4, 8, 0, 4, 8, 0.02), 0.01);

  const expected = ((4.27 / 10) * 0.016 + (3.0 / 6) * 0.004) / ((4.27 / 10) + (3.0 / 6));
  assertNear(
    striplineEffectiveLossTangent(4.27, 10, 0.016, 3.0, 6, 0.004),
    expected,
    'asymmetric stripline effective loss tangent',
  );
  assertNear(
    striplineEffectiveLossTangent(3.0, 6, 0.004, 4.27, 10, 0.016),
    expected,
    'upper/lower swap symmetry',
  );
});

test('perimeter and modal loss inputs use the solved conductor geometry', () => {
  const rectangle = {
    kind: 'RectangleConductors',
    width: 10,
    height: 2,
    conductivity: 5e7,
  };
  const trapezoid = {
    kind: 'TrapezoidConductors',
    bottomWidth: 10,
    topWidth: 8,
    height: 2,
    conductivity: 5e7,
  };
  const circle = {
    kind: 'CircleConductors',
    diameter: 5,
    conductivity: 5e7,
  };
  const unitScale = 1e-6;

  assertNear(perimeterM(rectangle, unitScale), 24e-6, 'rectangle perimeter');
  assertNear(
    perimeterM(trapezoid, unitScale),
    (18 + 2 * Math.hypot(2, 1)) * unitScale,
    'trapezoid perimeter',
  );
  assertNear(perimeterM(circle, unitScale), 5 * Math.PI * unitScale, 'circle perimeter');

  const result = {
    nSignals: 2,
    B: [[100e-12, -20e-12], [-20e-12, 100e-12]],
    Rdc: [[1.5, 0], [0, 1.5]],
    z0: [51, 51],
    zOdd: 43,
  };
  const single = lossInputsFrom(result, trapezoid, unitScale, 0.016, false);
  assert.equal(single.z0, 51);
  assert.equal(single.cPerM, 100e-12);
  assert.equal(single.rdcPerM, 1.5);
  assert.equal(single.sigma, 5e7);
  assert.equal(single.tanD, 0.016);
  assertNear(single.perimeterM, perimeterM(trapezoid, unitScale), 'single-ended perimeter');

  const odd = lossInputsFrom(result, trapezoid, unitScale, 0.016, true);
  assert.equal(odd.z0, 43);
  assert.equal(odd.cPerM, 120e-12);
  assert.equal(lossInputsFrom({ ...result, nSignals: 0 }, trapezoid, unitScale, 0.016, false), null);
});
