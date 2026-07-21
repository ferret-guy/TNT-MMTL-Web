#!/usr/bin/env node
/** Analytic conductor and dielectric loss regressions (Node >= 23). */
import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const {
  attenuationDbPerM,
  lossCurve,
  lossInputsFrom,
  lossSweepParamsForDesign,
  microstripReferencePlaneOverlapPerM,
  microstripReferencePlaneSelfOverlapPerM,
  perimeterM,
  presetLossTangentAtFrequency,
  presetReferencePlaneLossModel,
  referencePlaneDcResistanceMatrix,
  referencePlaneModeValue,
  referencePlaneResistanceMatrix,
  referencePlaneSheetResistanceOhm,
  referencePlaneSkinCoefficientMatrix,
  roughnessK,
  skinDepthM,
  striplineEffectiveLossTangent,
} = await import(pathToFileURL(join(root, 'src/analysis/losses.ts')));
const {
  dielectricConductanceMatrix,
  dielectricLossModelFromPerturbation,
  dielectricModeLossCapacitance,
  dielectricParticipationPerturbation,
} = await import(pathToFileURL(join(root, 'src/analysis/dielectricLoss.ts')));
const { defaultParams, referencePlaneThicknessOf } = await import(
  pathToFileURL(join(root, 'src/model/presets.ts'))
);
const { computeLineStats } = await import(pathToFileURL(join(root, 'src/analysis/lineStats.ts')));
const {
  CONDUCTORS,
  COPPER_CONDUCTIVITY_S_PER_M,
  JLCPCB_LAMINATES,
  materialAtFrequency,
} = await import(
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

test('conductor presets retain corrected room-temperature conductivities', () => {
  const sigma = Object.fromEntries(CONDUCTORS.map((material) => [material.name, material.sigma]));
  assert.equal(sigma.lead, 5.18e6);
  assert.equal(sigma.tin, 9.90e6);
  assert.equal(sigma.nichrome, 0.91e6);
  assert.ok(sigma.copper > sigma.tin);
  assert.ok(sigma.tin > sigma.lead);
  assert.ok(sigma.lead > sigma.nichrome);
});

test('lossCurve follows the analytic W-element formulas', () => {
  const inputs = {
    z0: 50,
    cPerM: 100e-12,
    lPerM: 250e-9,
    rdcPerM: 2,
    sigma: 5.8e7,
    tanD: 0.02,
    perimeterM: 1e-3,
  };
  const params = {
    includeReferencePlaneLoss: false,
    roughnessModel: 'none',
    roughnessRqUm: 0,
    hurayRadiusUm: 0.5,
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
    const alphaC = attenuationDbPerM(resistance, inputs.lPerM, 0, inputs.cPerM, fHz);
    const alphaD = attenuationDbPerM(0, inputs.lPerM, conductance, inputs.cPerM, fHz);
    const alphaTotal = attenuationDbPerM(
      resistance,
      inputs.lPerM,
      conductance,
      inputs.cPerM,
      fHz,
    );

    assertNear(curve.skinDepthUm[i], deltaM * 1e6, `skin depth ${i}`);
    assertNear(curve.rOhmPerM[i], resistance, `resistance ${i}`);
    assertNear(curve.gSPerM[i], conductance, `conductance ${i}`);
    assertNear(curve.alphaC[i], alphaC, `conductor attenuation ${i}`);
    assertNear(curve.alphaD[i], alphaD, `dielectric attenuation ${i}`);
    assertNear(curve.alphaTotal[i], alphaTotal, `total attenuation ${i}`);
  }
});

test('insertion-loss sweep extends exactly one decade above the design frequency', () => {
  const inputs = {
    z0: 50,
    cPerM: 100e-12,
    lPerM: 250e-9,
    rdcPerM: 2,
    sigma: 5.8e7,
    tanD: 0.016,
    perimeterM: 1e-3,
  };
  const persisted = {
    includeReferencePlaneLoss: false,
    roughnessModel: 'none',
    roughnessRqUm: 0,
    hurayRadiusUm: 0.5,
    hurayRatio: 2.17,
    fMinHz: 1e6,
    fMaxHz: 1e10,
    nPoints: 6,
  };

  const sweep = lossSweepParamsForDesign(persisted, 10e9);
  const curve = lossCurve(inputs, sweep);

  assert.equal(sweep.fMaxHz, 100e9);
  assert.equal(curve.fHz.at(-1), 100e9);
  assert.equal(persisted.fMaxHz, 10e9, 'persisted settings are not mutated');
});

test('design-frequency sweep lowers its start for targets below the stored minimum', () => {
  const persisted = {
    includeReferencePlaneLoss: false,
    roughnessModel: 'none',
    roughnessRqUm: 0,
    hurayRadiusUm: 0.5,
    hurayRatio: 2.17,
    fMinHz: 1e6,
    fMaxHz: 1e10,
    nPoints: 6,
  };

  const sweep = lossSweepParamsForDesign(persisted, 50e3);

  assert.equal(sweep.fMinHz, 50e3);
  assert.equal(sweep.fMaxHz, 500e3);
  assert.ok(sweep.fMinHz <= 50e3 && sweep.fMaxHz >= 50e3);
});

test('exact RLGC attenuation stays stable on the negative real axis', () => {
  const fHz = 10e9;
  const r = 0.8;
  const l = 250e-9;
  const g = 2e-4;
  const c = 100e-12;
  const omega = 2 * Math.PI * fHz;
  const real = r * g - omega * omega * l * c;
  const imaginary = omega * (r * c + l * g);
  const betaMagnitude = Math.sqrt((Math.hypot(real, imaginary) - real) / 2);
  const expected = Math.abs(imaginary) / (2 * betaMagnitude) * NP_TO_DB;

  assertNear(attenuationDbPerM(r, l, g, c, fHz), expected, 'stable exact attenuation');
  assert.ok(attenuationDbPerM(r, l, g, c, fHz) > 0);
});

test('line stats reject a frequency the supplied curve does not cover', () => {
  const curve = {
    fHz: [1e6, 1e9],
    alphaC: [1, 2],
    alphaD: [1, 2],
    alphaTotal: [2, 4],
    rOhmPerM: [1, 2],
    gSPerM: [1, 2],
    skinDepthUm: [1, 2],
    kRough: [1, 1],
  };
  const result = {
    velocity: [2e8],
    delay: [5e-9],
    Rdc: [[1]],
  };

  assert.equal(computeLineStats(result, curve, 0.1, 20e9, false), null);
  assert.ok(computeLineStats(result, curve, 0.1, 1e9, false));
});

test('lossCurve evaluates frequency-dependent loss tangent at every curve point', () => {
  const seen = [];
  const inputs = {
    z0: 50,
    cPerM: 100e-12,
    lPerM: 250e-9,
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
    includeReferencePlaneLoss: false,
    roughnessModel: 'none',
    roughnessRqUm: 0,
    hurayRadiusUm: 0.5,
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
    const alphaD = attenuationDbPerM(0, inputs.lPerM, conductance, inputs.cPerM, fHz);
    assertNear(curve.gSPerM[i], conductance, `dispersive conductance ${i}`);
    assertNear(curve.alphaD[i], alphaD, `dispersive dielectric attenuation ${i}`);
  }
});

test('finite-thickness reference sheet resistance has the exact thin and thick limits', () => {
  const conductivity = 5.8e7;
  const thinFrequency = 1;
  const thinThickness = 1e-9;
  const thinDepth = skinDepthM(thinFrequency, conductivity);
  const thinX = thinThickness / thinDepth;
  const thinExpected =
    (1 / (conductivity * thinThickness)) * (1 + (4 * thinX ** 4) / 45);
  assertNear(
    referencePlaneSheetResistanceOhm(
      thinFrequency,
      conductivity,
      thinThickness,
    ),
    thinExpected,
    'thin-sheet resistance',
  );

  const thickFrequency = 10e9;
  const thickThickness = 1e-3;
  const thickExpected =
    1 / (conductivity * skinDepthM(thickFrequency, conductivity));
  assertNear(
    referencePlaneSheetResistanceOhm(
      thickFrequency,
      conductivity,
      thickThickness,
    ),
    thickExpected,
    'thick-sheet resistance',
  );
});

test('microstrip return-current overlap reaches its narrow and wide trace limits', () => {
  const distance = 100e-6;
  const narrowWidth = distance * 1e-4;
  const wideWidth = distance * 1e4;
  assertNear(
    microstripReferencePlaneSelfOverlapPerM(narrowWidth, distance),
    1 / (2 * Math.PI * distance),
    'narrow-trace effective return width',
    1e-8,
  );
  assertNear(
    microstripReferencePlaneSelfOverlapPerM(wideWidth, distance),
    1 / wideWidth,
    'wide-trace effective return width',
    2e-3,
  );
});

test('guided pair reference loss is symmetric and lower in odd mode than even mode', () => {
  const p = {
    ...defaultParams('microstrip', 'diff'),
    w: 6,
    s: 6,
    h: 4,
    t: 1.4,
  };
  const model = presetReferencePlaneLossModel(
    'microstrip',
    'diff',
    p,
    25.4e-6,
  );
  assert.ok(model);
  assert.equal(model.thicknessM, referencePlaneThicknessOf(p) * 25.4e-6);
  assertNear(
    model.geometryPerM[0][0],
    model.geometryPerM[1][1],
    'pair self-overlap symmetry',
  );
  assertNear(
    model.geometryPerM[0][1],
    model.geometryPerM[1][0],
    'pair mutual-overlap symmetry',
  );
  assert.ok(model.geometryPerM[0][0] > model.geometryPerM[0][1]);

  const dc = referencePlaneDcResistanceMatrix(model);
  const odd = referencePlaneModeValue(dc, 'odd');
  const even = referencePlaneModeValue(dc, 'even');
  assert.ok(odd >= 0);
  assert.ok(even > odd);
});

test('microstrip mutual overlap stays physical at extreme aspect ratios', () => {
  const widthM = 1000 * 25.4e-6;
  const distanceM = 0.015 * 25.4e-6;
  const separationM = 1100 * 25.4e-6;
  const self = microstripReferencePlaneSelfOverlapPerM(widthM, distanceM);
  const mutual = microstripReferencePlaneOverlapPerM(
    widthM,
    distanceM,
    separationM,
  );
  assert.ok(mutual >= 0);
  assert.ok(mutual <= self);

  const params = {
    ...defaultParams('microstrip', 'diff'),
    w: 1000,
    h: 0.01,
    t: 0.01,
    s: 100,
    etch: 0,
    sigma: 0.91e6,
  };
  const model = presetReferencePlaneLossModel(
    'microstrip',
    'diff',
    params,
    25.4e-6,
  );
  assert.ok(model);
  assert.ok(model.geometryPerM[0][1] <= model.geometryPerM[0][0]);
  assert.equal(
    model.conductivity,
    COPPER_CONDUCTIVITY_S_PER_M,
    'reference-plane copper does not inherit a non-copper signal material',
  );
});

test('stripline reference geometry follows the solver upper-clearance clamp', () => {
  const base = {
    ...defaultParams('stripline', 'se'),
    t: 10,
    h2: 0,
  };
  const atClamp = presetReferencePlaneLossModel(
    'stripline',
    'se',
    base,
    25.4e-6,
  );
  const belowClamp = presetReferencePlaneLossModel(
    'stripline',
    'se',
    { ...base, h2: 0.04 * base.t },
    25.4e-6,
  );
  assert.ok(atClamp);
  assert.ok(belowClamp);
  assertNear(
    belowClamp.geometryPerM[0][0],
    atClamp.geometryPerM[0][0],
    'clamped stripline upper plane position',
  );
});

test('symmetric stripline shares a wide-trace return between both planes', () => {
  const unitScaleM = 25.4e-6;
  const microstripParams = {
    ...defaultParams('microstrip', 'se'),
    w: 4000,
    h: 4,
    t: 0.001,
    etch: 0,
  };
  const striplineParams = {
    ...defaultParams('stripline', 'se'),
    w: 4000,
    h: 4,
    h2: 4,
    t: 0.001,
    etch: 0,
  };
  const onePlane = presetReferencePlaneLossModel(
    'microstrip',
    'se',
    microstripParams,
    unitScaleM,
  );
  const twoPlanes = presetReferencePlaneLossModel(
    'stripline',
    'se',
    striplineParams,
    unitScaleM,
  );
  assert.ok(onePlane);
  assert.ok(twoPlanes);
  assertNear(
    twoPlanes.geometryPerM[0][0],
    onePlane.geometryPerM[0][0] / 2,
    'two equal stripline planes act in parallel',
    0.01,
  );
});

test('reference-plane toggle changes only conductor loss and uses foil thickness', () => {
  const inputs = {
    z0: 50,
    cPerM: 100e-12,
    lPerM: 250e-9,
    rdcPerM: 2,
    sigma: 5.8e7,
    tanD: 0.02,
    perimeterM: 1e-3,
    referencePlane: {
      geometryPerM: [[1200]],
      conductivity: 5.8e7,
      thicknessM: 35e-6,
    },
    referencePlaneMode: 'single',
  };
  const params = {
    includeReferencePlaneLoss: false,
    roughnessModel: 'hammerstad',
    roughnessRqUm: 1,
    hurayRadiusUm: 0.5,
    hurayRatio: 2.2,
    fMinHz: 1e9,
    fMaxHz: 10e9,
    nPoints: 2,
  };
  const excluded = lossCurve(inputs, params);
  const included = lossCurve(inputs, {
    ...params,
    includeReferencePlaneLoss: true,
  });

  assert.deepEqual(included.rSignalOhmPerM, excluded.rSignalOhmPerM);
  assert.deepEqual(included.gSPerM, excluded.gSPerM);
  assert.deepEqual(included.alphaD, excluded.alphaD);
  assert.ok(included.rReferenceOhmPerM.every((value) => value > 0));
  assert.ok(
    included.rOhmPerM.every(
      (value, index) => value > excluded.rOhmPerM[index],
    ),
  );
  assert.ok(
    included.alphaC.every(
      (value, index) => value > excluded.alphaC[index],
    ),
  );
  assertNear(
    included.rdcReferenceOhmPerM,
    1200 / (inputs.referencePlane.conductivity * 35e-6),
    'reference-plane DC resistance',
  );

  const thickModel = {
    ...inputs.referencePlane,
    thicknessM: 70e-6,
  };
  assertNear(
    referencePlaneDcResistanceMatrix(thickModel)[0][0],
    included.rdcReferenceOhmPerM / 2,
    'double foil thickness halves reference DC resistance',
  );
});

test('reference roughness is applied once to only the finite-sheet AC excess', () => {
  const model = {
    geometryPerM: [[900]],
    conductivity: 5.8e7,
    thicknessM: 35e-6,
  };
  const fHz = 10e9;
  const params = {
    includeReferencePlaneLoss: true,
    roughnessModel: 'hammerstad',
    roughnessRqUm: 2,
    hurayRadiusUm: 0.5,
    hurayRatio: 2.2,
    fMinHz: fHz,
    fMaxHz: fHz,
    nPoints: 2,
  };
  const dcSheet = 1 / (model.conductivity * model.thicknessM);
  const smooth = referencePlaneSheetResistanceOhm(
    fHz,
    model.conductivity,
    model.thicknessM,
  );
  const k = roughnessK(
    'hammerstad',
    2e-6,
    skinDepthM(fHz, model.conductivity),
    params.hurayRatio,
  );
  const expected = model.geometryPerM[0][0] *
    (dcSheet + k * (smooth - dcSheet));
  assertNear(
    referencePlaneResistanceMatrix(model, params, fHz)[0][0],
    expected,
    'rough reference-plane resistance',
  );
});

test('multi-material reference-loss matrices sum independently weighted terms', () => {
  const copper = {
    geometryPerM: [
      [700, 120],
      [120, 650],
    ],
    conductivity: 5.8e7,
    thicknessM: 35e-6,
    label: 'copper plane',
  };
  const platedFlanks = {
    geometryPerM: [
      [180, 45],
      [45, 210],
    ],
    conductivity: 1.5e7,
    thicknessM: 12e-6,
    label: 'plated coplanar grounds',
  };
  const model = {
    source: 'mesh',
    terms: [copper, platedFlanks],
    // A mesh model may retain an aggregate for display. It must not be
    // counted again when authoritative material terms are present.
    geometryPerM: [[1e9, 0], [0, 1e9]],
    conductivity: 1,
    thicknessM: 1,
  };
  const dc = referencePlaneDcResistanceMatrix(model);
  const skin = referencePlaneSkinCoefficientMatrix(model);
  const params = {
    includeReferencePlaneLoss: true,
    roughnessModel: 'hammerstad',
    roughnessRqUm: 1.2,
    hurayRadiusUm: 0.5,
    hurayRatio: 2.2,
    fMinHz: 5e9,
    fMaxHz: 5e9,
    nPoints: 2,
  };
  const frequencyHz = 5e9;
  const resistance = referencePlaneResistanceMatrix(
    model,
    params,
    frequencyHz,
  );

  for (let row = 0; row < 2; row++) {
    for (let column = 0; column < 2; column++) {
      let expectedDc = 0;
      let expectedSkin = 0;
      let expectedResistance = 0;
      for (const term of model.terms) {
        const geometry = term.geometryPerM[row][column];
        const dcSheet = 1 / (term.conductivity * term.thicknessM);
        const smoothSheet = referencePlaneSheetResistanceOhm(
          frequencyHz,
          term.conductivity,
          term.thicknessM,
        );
        const roughness = roughnessK(
          params.roughnessModel,
          params.roughnessRqUm * 1e-6,
          skinDepthM(frequencyHz, term.conductivity),
          params.hurayRatio,
        );
        expectedDc += geometry * dcSheet;
        expectedSkin += geometry *
          Math.sqrt(Math.PI * MU0 / term.conductivity);
        expectedResistance += geometry *
          (dcSheet + roughness * Math.max(0, smoothSheet - dcSheet));
      }
      assertNear(dc[row][column], expectedDc, `multi-material DC ${row},${column}`);
      assertNear(
        skin[row][column],
        expectedSkin,
        `multi-material skin coefficient ${row},${column}`,
      );
      assertNear(
        resistance[row][column],
        expectedResistance,
        `multi-material resistance ${row},${column}`,
      );
    }
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
    roughnessK('huray', radiusM, deltaM, hurayRatio),
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

test('dielectric perturbations scale each geometry by its tan(delta) ratio', () => {
  const stackup = {
    title: 'heterogeneous dielectric perturbation',
    units: 'mils',
    couplingLengthM: 0.0254,
    riseTimePs: 100,
    cseg: 12,
    dseg: 12,
    items: [
      { kind: 'GroundPlane', id: 'ground' },
      {
        kind: 'DielectricLayer', id: 'layer', thickness: 10,
        permittivity: 4.2, lossTangent: 0.004,
      },
      {
        kind: 'RectangleDielectric', id: 'block', width: 20, height: 3,
        permittivity: 2.8, lossTangent: 0.02, xOffset: 0, yOffset: 0,
      },
      {
        kind: 'TrapezoidDielectric', id: 'wedge', topWidth: 12,
        bottomWidth: 16, height: 2, permittivity: 3.1,
        lossTangent: 0.01, xOffset: 2, yOffset: 0,
      },
      {
        kind: 'RectangleConductors', id: 'signal', isGround: false,
        conductivity: 5.8e7, number: 1, pitch: 0, xOffset: 7,
        yOffset: 0, width: 2, height: 1,
      },
    ],
  };
  const original = structuredClone(stackup);
  const perturbation = dielectricParticipationPerturbation(stackup);
  assert.ok(perturbation);
  assert.equal(perturbation.maxLossTangent, 0.02);
  assert.equal(perturbation.logPermittivityStep, 0.02);
  assert.deepEqual(stackup, original, 'building auxiliary solves must not mutate geometry');

  for (let index = 0; index < stackup.items.length; index++) {
    const physical = stackup.items[index];
    const positive = perturbation.positiveStackup.items[index];
    const negative = perturbation.negativeStackup.items[index];
    if (!physical.kind.includes('Dielectric')) {
      assert.deepEqual(positive, physical);
      assert.deepEqual(negative, physical);
      continue;
    }
    const expectedLogRatio =
      2 * perturbation.logPermittivityStep *
      physical.lossTangent / perturbation.maxLossTangent;
    assertNear(
      Math.log(positive.permittivity / negative.permittivity),
      expectedLogRatio,
      `${physical.id} logarithmic perturbation`,
    );
    assertNear(
      Math.sqrt(positive.permittivity * negative.permittivity),
      physical.permittivity,
      `${physical.id} central geometric mean`,
    );
  }
});

test('central perturbation extracts the weighted sum of heterogeneous participation', () => {
  const layerParticipation = [
    [80e-12, -15e-12],
    [-15e-12, 50e-12],
  ];
  const blockParticipation = [
    [20e-12, -5e-12],
    [-5e-12, 70e-12],
  ];
  const layerTanD = 0.004;
  const blockTanD = 0.02;
  const maxTanD = Math.max(layerTanD, blockTanD);
  const logStep = 0.02;
  const expected = layerParticipation.map((row, rowIndex) =>
    row.map(
      (value, columnIndex) =>
        value * layerTanD +
        blockParticipation[rowIndex][columnIndex] * blockTanD,
    ),
  );
  const reference = [
    [120e-12, -20e-12],
    [-20e-12, 130e-12],
  ];
  const positive = reference.map((row, rowIndex) =>
    row.map(
      (value, columnIndex) =>
        value + (logStep / maxTanD) * expected[rowIndex][columnIndex],
    ),
  );
  const negative = reference.map((row, rowIndex) =>
    row.map(
      (value, columnIndex) =>
        value - (logStep / maxTanD) * expected[rowIndex][columnIndex],
    ),
  );

  const model = dielectricLossModelFromPerturbation(
    positive,
    negative,
    maxTanD,
    logStep,
    reference,
  );
  assert.equal(model.source, 'bem-participation');
  for (let row = 0; row < 2; row++) {
    for (let column = 0; column < 2; column++) {
      assertNear(
        model.lossCapacitancePerM[row][column],
        expected[row][column],
        `weighted K[${row}][${column}]`,
        1e-10,
      );
    }
  }
});

test('dielectric participation clips solver roundoff but rejects material non-passivity', () => {
  const reference = [[100e-12]];
  const maxTanD = 0.02;
  const logStep = 0.02;
  const matricesFor = (lossCapacitance) => ({
    positive: [[reference[0][0] + (logStep / maxTanD) * lossCapacitance]],
    negative: [[reference[0][0] - (logStep / maxTanD) * lossCapacitance]],
  });

  const roundoff = matricesFor(-1e-18);
  const clipped = dielectricLossModelFromPerturbation(
    roundoff.positive,
    roundoff.negative,
    maxTanD,
    logStep,
    reference,
  );
  assert.equal(clipped.lossCapacitancePerM[0][0], 0);

  const nonPassive = matricesFor(-1e-12);
  assert.throws(
    () => dielectricLossModelFromPerturbation(
      nonPassive.positive,
      nonPassive.negative,
      maxTanD,
      logStep,
      reference,
    ),
    /not positive semidefinite/i,
  );
});

test('a uniform dielectric loss model is exactly equivalent to C times tan(delta)', () => {
  const capacitance = [[112e-12]];
  const tanD = 0.018;
  const frequencyHz = 7.5e9;
  const model = {
    source: 'bem-participation',
    lossCapacitancePerM: [[capacitance[0][0] * tanD]],
  };

  const conductance = dielectricConductanceMatrix(model, frequencyHz);
  assertNear(
    model.lossCapacitancePerM[0][0],
    capacitance[0][0] * tanD,
    'uniform loss capacitance',
  );
  assertNear(
    conductance[0][0],
    2 * Math.PI * frequencyHz * capacitance[0][0] * tanD,
    'uniform dielectric conductance',
  );
  assertNear(
    dielectricModeLossCapacitance(model, 'single'),
    capacitance[0][0] * tanD,
    'uniform single-ended modal loss capacitance',
  );
});

test('heterogeneous dielectric participation retains a full non-proportional matrix', () => {
  // These two terms represent independently integrated field-energy regions.
  // Their different tan(delta) values deliberately make K unlike a scalar
  // multiple of the line capacitance matrix.
  const blockParticipation = [
    [50e-12, -8e-12],
    [-8e-12, 25e-12],
  ];
  const layerParticipation = [
    [30e-12, -3e-12],
    [-3e-12, 70e-12],
  ];
  const blockTanD = 0.032;
  const layerTanD = 0.004;
  const lossCapacitancePerM = blockParticipation.map((row, rowIndex) =>
    row.map(
      (value, columnIndex) =>
        value * blockTanD +
        layerParticipation[rowIndex][columnIndex] * layerTanD,
    ),
  );
  const model = { source: 'bem-participation', lossCapacitancePerM };
  const frequencyHz = 2e9;
  const conductance = dielectricConductanceMatrix(model, frequencyHz);

  for (let row = 0; row < 2; row++) {
    for (let column = 0; column < 2; column++) {
      assertNear(
        conductance[row][column],
        2 * Math.PI * frequencyHz * lossCapacitancePerM[row][column],
        `heterogeneous G[${row}][${column}]`,
      );
    }
  }

  const k00 = lossCapacitancePerM[0][0];
  const k01 = lossCapacitancePerM[0][1];
  const k10 = lossCapacitancePerM[1][0];
  const k11 = lossCapacitancePerM[1][1];
  assertNear(
    dielectricModeLossCapacitance(model, 'odd'),
    (k00 + k11 - k01 - k10) / 2,
    'odd-mode dielectric loss capacitance per line',
  );
  assertNear(
    dielectricModeLossCapacitance(model, 'even'),
    (k00 + k11 + k01 + k10) / 2,
    'even-mode dielectric loss capacitance per line',
  );
  assert.notEqual(
    dielectricModeLossCapacitance(model, 'odd'),
    dielectricModeLossCapacitance(model, 'even'),
  );
});

test('lossCurve projects the solved dielectric-loss matrix for the selected mode', () => {
  const frequencyHz = 3e9;
  const model = {
    source: 'bem-participation',
    lossCapacitancePerM: [
      [5e-12, -1.5e-12],
      [-1.5e-12, 7e-12],
    ],
  };
  const oddLossCapacitance =
    (5e-12 + 7e-12 - (-1.5e-12) - (-1.5e-12)) / 2;
  const curve = lossCurve({
    z0: 50,
    cPerM: 120e-12,
    lPerM: 250e-9,
    rdcPerM: 0,
    sigma: 5.8e7,
    tanD: 0.99,
    perimeterM: 1e-3,
    dielectricLoss: model,
    dielectricLossMode: 'odd',
  }, {
    includeReferencePlaneLoss: false,
    roughnessModel: 'none',
    roughnessRqUm: 0,
    hurayRadiusUm: 0.5,
    hurayRatio: 2.17,
    fMinHz: frequencyHz,
    fMaxHz: frequencyHz,
    nPoints: 2,
  });
  assertNear(
    curve.gSPerM[0],
    2 * Math.PI * frequencyHz * oddLossCapacitance,
    'odd-mode plotted dielectric conductance',
  );
  assert.equal(curve.gSPerM[1], curve.gSPerM[0]);
  assert.notEqual(
    curve.gSPerM[0],
    2 * Math.PI * frequencyHz * 120e-12 * 0.99,
    'matrix model takes priority over the scalar fallback',
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
    L: [[260e-9, 30e-9], [30e-9, 260e-9]],
    Rdc: [[1.5, 0], [0, 1.5]],
    z0: [51, 51],
    zOdd: 43,
  };
  const single = lossInputsFrom(result, trapezoid, unitScale, 0.016, false);
  assert.equal(single.z0, 51);
  assert.equal(single.cPerM, 100e-12);
  assert.equal(single.lPerM, 260e-9);
  assert.equal(single.rdcPerM, 1.5);
  assert.equal(single.sigma, 5e7);
  assert.equal(single.tanD, 0.016);
  assertNear(single.perimeterM, perimeterM(trapezoid, unitScale), 'single-ended perimeter');

  const odd = lossInputsFrom(result, trapezoid, unitScale, 0.016, true);
  assert.equal(odd.z0, 43);
  assert.equal(odd.cPerM, 120e-12);
  assert.equal(odd.lPerM, 230e-9);
  assert.equal(lossInputsFrom({ ...result, nSignals: 0 }, trapezoid, unitScale, 0.016, false), null);
});
