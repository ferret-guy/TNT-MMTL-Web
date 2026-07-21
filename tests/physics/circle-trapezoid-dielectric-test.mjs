#!/usr/bin/env node
/**
 * Regression for a circular signal intersecting a sloped dielectric edge.
 *
 * Requires Node >= 23 because the test imports the application's TypeScript
 * modules directly using native type stripping.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

const {
  circleDielectricBands,
  generateXsctn,
  solverSignalBindings,
  validateStackup,
} = await import(
  pathToFileURL(join(root, 'src/xsctn/generate.ts'))
);
const { computeGeometry, computeViewport } = await import(
  pathToFileURL(join(root, 'src/ui/crossSection.ts'))
);
const { parseResult } = await import(pathToFileURL(join(root, 'src/solver/parseResult.mjs')));
const { dielectricParticipationPerturbation } = await import(
  pathToFileURL(join(root, 'src/analysis/dielectricLoss.ts'))
);
const { freeSpaceStackup } = await import(
  pathToFileURL(join(root, 'src/analysis/meshReferenceLoss.ts'))
);
const createBemModule = (await import(pathToFileURL(join(root, 'public/wasm/bem.mjs')))).default;

const cat5SleevesStackup = {
  title: 'Belden Cat5e pair with individual PE insulation',
  units: 'mils',
  couplingLengthM: 1,
  riseTimePs: 100,
  cseg: 18,
  dseg: 18,
  items: [
    { kind: 'GroundPlane', id: 'remote-reference' },
    {
      kind: 'DielectricLayer', id: 'air', thickness: 800,
      permittivity: 1, lossTangent: 0,
    },
    {
      kind: 'CircleDielectric', id: 'PE', diameter: 35.03937007874016,
      number: 2, pitch: 35.03937007874016, xOffset: 0, yOffset: 0,
      permittivity: 2.34, lossTangent: 0.00002,
    },
    {
      kind: 'CircleConductors', id: 'Pair', isGround: false,
      conductivity: 5.2e7, diameter: 20.118110236220474,
      number: 2, pitch: 35.03937007874016,
      xOffset: 7.460629921259844, yOffset: 7.460629921259844,
    },
  ],
};

// The trapezoid occupies x=0..20 mil at its base and x=4..16 mil at
// its top (y=10..16 mil).  The circle occupies x=16..20, y=12..16 mil,
// so its boundary crosses the right sloped dielectric edge twice.  This is
// deliberately stronger than a merely disjoint circle/trapezoid smoke test.
const stackup = {
  title: 'circle crossing trapezoid dielectric edge',
  units: 'mils',
  couplingLengthM: 0.0254,
  riseTimePs: 100,
  cseg: 24,
  dseg: 24,
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
      kind: 'TrapezoidDielectric',
      id: 'sloped-dielectric',
      topWidth: 12,
      bottomWidth: 20,
      height: 6,
      permittivity: 3.3,
      lossTangent: 0.006,
      xOffset: 0,
      yOffset: 0,
    },
    {
      kind: 'CircleConductors',
      id: 'round-signal',
      isGround: false,
      conductivity: 5.8e7,
      diameter: 4,
      number: 1,
      pitch: 0,
      xOffset: 16,
      yOffset: 2,
    },
  ],
};

const containedCircleStackup = {
  ...stackup,
  title: 'circle contained by trapezoid dielectric',
  cseg: 18,
  dseg: 18,
  items: stackup.items.map((item) =>
    item.id === 'round-signal'
      ? { ...item, diameter: 2, xOffset: 9, yOffset: 2 }
      : item,
  ),
};

// The wider top reverses both dielectric-side slopes.  The circular ground
// wire crosses the left side, while the rectangular signal remains inside.
// This catches ground-circle handling separately from the signal-circle case.
const topWiderGroundCircleStackup = {
  ...stackup,
  title: 'top-wider trapezoid with circular ground wire',
  cseg: 18,
  dseg: 18,
  items: [
    stackup.items[0],
    stackup.items[1],
    {
      kind: 'TrapezoidDielectric',
      id: 'top-wider-dielectric',
      topWidth: 20,
      bottomWidth: 12,
      height: 6,
      permittivity: 3.3,
      lossTangent: 0.006,
      xOffset: 0,
      yOffset: 0,
    },
    {
      kind: 'CircleConductors',
      id: 'round-ground-wire',
      isGround: true,
      conductivity: 5.8e7,
      diameter: 3,
      number: 1,
      pitch: 0,
      xOffset: 0.5,
      yOffset: 2,
    },
    {
      kind: 'RectangleConductors',
      id: 'rect-signal',
      isGround: false,
      conductivity: 5.8e7,
      width: 2,
      height: 1,
      number: 1,
      pitch: 0,
      xOffset: 9,
      yOffset: 2,
    },
  ],
};

const mixedSignalSetStackup = {
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

async function solve(caseStackup) {
  const xsctn = generateXsctn(caseStackup);
  const stdout = [];
  const stderr = [];
  const mod = await createBemModule({
    print: (line) => stdout.push(line),
    printErr: (line) => stderr.push(line),
  });
  mod.FS.mkdir('/work');
  mod.FS.writeFile('/work/case.xsctn', xsctn);
  mod.FS.chdir('/work');

  let exitCode = 0;
  try {
    exitCode = mod.callMain([
      '/work/case',
      String(caseStackup.cseg),
      String(caseStackup.dseg),
    ]);
  } catch (error) {
    if (error?.name === 'ExitStatus') exitCode = error.status;
    else throw error;
  }

  let resultText = null;
  try {
    resultText = mod.FS.readFile('/work/case.result', { encoding: 'utf8' });
  } catch {
    // A rejected or failed solve does not create a result file.
  }

  return {
    exitCode,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
    resultText,
  };
}

function assertPhysicalSingleLine(out) {
  const diagnostics = [out.stderr, out.stdout].filter(Boolean).join('\n');
  assert.equal(out.exitCode, 0, diagnostics);
  assert.match(out.stdout, /MMTL is done/, diagnostics);
  assert.ok(out.resultText, diagnostics || 'solver did not create case.result');
  assert.doesNotMatch(diagnostics, /ORPHAN|ELECTRO-F-/);

  const result = parseResult(out.resultText);
  assert.equal(result.nSignals, 1);
  assert.ok(Number.isFinite(result.z0[0]) && result.z0[0] > 0, `Z0=${result.z0[0]}`);
  assert.ok(Number.isFinite(result.B[0][0]) && result.B[0][0] > 0, `B11=${result.B[0][0]}`);
  assert.ok(Number.isFinite(result.L[0][0]) && result.L[0][0] > 0, `L11=${result.L[0][0]}`);
}

test('circular conductors and trapezoid dielectrics pass validation', () => {
  assert.deepEqual(validateStackup(stackup), []);
});

test('circular dielectric sets serialize as stable octagons without shifting conductor names', () => {
  assert.deepEqual(validateStackup(cat5SleevesStackup), []);
  const dielectric = cat5SleevesStackup.items[2];
  const bands = circleDielectricBands(dielectric);
  assert.equal(bands.length, 3);
  assert.ok(
    Math.abs(bands.reduce((sum, band) => sum + band.height, 0) - dielectric.diameter) < 1e-12,
  );
  assert.equal(Math.max(...bands.flatMap((band) => [band.bottomWidth, band.topWidth])), dielectric.diameter);

  const xsctn = generateXsctn(cat5SleevesStackup);
  assert.match(xsctn, /TrapezoidDielectric B3C1/);
  assert.match(xsctn, /TrapezoidDielectric B3C2/);
  assert.match(xsctn, /TrapezoidDielectric B3C3/);
  assert.equal((xsctn.match(/-number 2/g) ?? []).length, 4);
  assert.match(xsctn, /CircleConductors Circ4/);
  assert.deepEqual(
    solverSignalBindings(cat5SleevesStackup).map(({ solverName }) => solverName),
    ['Circ4C0', 'Circ4C1'],
  );
});

test('circular dielectric loss participates in perturbation and all-air solves', () => {
  const dielectric = cat5SleevesStackup.items[2];
  const xsctn = generateXsctn(cat5SleevesStackup);
  assert.equal((xsctn.match(/-lossTangent 0\.00002/g) ?? []).length, 3);

  const perturbation = dielectricParticipationPerturbation(cat5SleevesStackup);
  assert.ok(perturbation);
  const positive = perturbation.positiveStackup.items[2];
  const negative = perturbation.negativeStackup.items[2];
  assert.equal(positive.kind, 'CircleDielectric');
  assert.equal(negative.kind, 'CircleDielectric');
  assert.ok(positive.permittivity > dielectric.permittivity);
  assert.ok(negative.permittivity < dielectric.permittivity);

  const air = freeSpaceStackup(cat5SleevesStackup).items[2];
  assert.equal(air.kind, 'CircleDielectric');
  assert.equal(air.permittivity, 1);
  assert.equal(air.lossTangent, 0);

  for (const lossTangent of [-0.001, Number.NaN, Number.POSITIVE_INFINITY]) {
    const invalid = structuredClone(cat5SleevesStackup);
    invalid.items[2].lossTangent = lossTangent;
    assert.ok(validateStackup(invalid).some((error) => /loss tangent/i.test(error)));
  }
});

test('circular dielectric geometry preserves vendor outer diameter and 1:1 display scale', () => {
  const geometry = computeGeometry(cat5SleevesStackup);
  const sleeves = geometry.polys.filter(
    (poly) => poly.item?.kind === 'CircleDielectric',
  );
  assert.equal(sleeves.length, 2);
  const diameter = cat5SleevesStackup.items[2].diameter;
  sleeves.forEach((sleeve, index) => {
    assert.ok(Math.abs(sleeve.x0 - index * diameter) < 1e-12);
    assert.ok(Math.abs((sleeve.x1 - sleeve.x0) - diameter) < 1e-12);
    assert.ok(Math.abs((sleeve.y1 - sleeve.y0) - diameter) < 1e-12);
    assert.equal(sleeve.y0, 800);
  });
  const viewport = computeViewport(geometry, 1, true);
  for (const sleeve of sleeves) {
    const widthPx = Math.abs(viewport.sx(sleeve.x1) - viewport.sx(sleeve.x0));
    const heightPx = Math.abs(viewport.sy(sleeve.y1) - viewport.sy(sleeve.y0));
    assert.ok(Math.abs(widthPx - heightPx) < 1e-9);
  }
});

test('native BEM solves source-dimensioned Cat5e individual insulation sleeves', async () => {
  const out = await solve(cat5SleevesStackup);
  const diagnostics = [out.stderr, out.stdout].filter(Boolean).join('\n');
  assert.equal(out.exitCode, 0, diagnostics);
  assert.match(out.stdout, /MMTL is done/, diagnostics);
  assert.doesNotMatch(diagnostics, /ORPHAN|ELECTRO-F-/);
  assert.ok(out.resultText, diagnostics || 'solver did not create case.result');
  const result = parseResult(out.resultText);
  assert.equal(result.nSignals, 2);
  assert.ok(result.B.flat().every(Number.isFinite));
  const differentialOhms = 2 * result.zOdd;
  assert.ok(
    differentialOhms >= 104 && differentialOhms <= 105,
    `Cat5e sleeved-pair differential Z=${differentialOhms} ohm`,
  );
});

test('every dielectric geometry validates and serializes its loss tangent', () => {
  const allDielectrics = {
    ...stackup,
    title: 'all dielectric loss-tangent forms',
    items: [
      stackup.items[0],
      { ...stackup.items[1], lossTangent: 0.011 },
      {
        kind: 'RectangleDielectric',
        id: 'lossy-block',
        width: 30,
        height: 4,
        permittivity: 2.8,
        lossTangent: 0.022,
        xOffset: -5,
        yOffset: 0,
      },
      { ...stackup.items[2], lossTangent: 0.033 },
      stackup.items[3],
    ],
  };

  assert.deepEqual(validateStackup(allDielectrics), []);
  const xsctn = generateXsctn(allDielectrics);
  const objectBlock = (start, end) => {
    const startIndex = xsctn.indexOf(start);
    const endIndex = xsctn.indexOf(end, startIndex + start.length);
    assert.ok(startIndex >= 0, `${start} was not generated`);
    assert.ok(endIndex > startIndex, `${end} did not follow ${start}`);
    return xsctn.slice(startIndex, endIndex);
  };
  assert.match(
    objectBlock('DielectricLayer D2', 'RectangleDielectric B3'),
    /-lossTangent 0\.011/,
  );
  assert.match(
    objectBlock('RectangleDielectric B3', 'TrapezoidDielectric B4'),
    /-lossTangent 0\.022/,
  );
  assert.match(
    objectBlock('TrapezoidDielectric B4', 'CircleConductors Circ5'),
    /-lossTangent 0\.033/,
  );

  for (const kind of [
    'DielectricLayer',
    'RectangleDielectric',
    'TrapezoidDielectric',
  ]) {
    for (const lossTangent of [-0.001, Number.NaN, Number.POSITIVE_INFINITY]) {
      const invalid = structuredClone(allDielectrics);
      const item = invalid.items.find((candidate) => candidate.kind === kind);
      item.lossTangent = lossTangent;
      assert.ok(
        validateStackup(invalid).some((error) => /loss tangent/i.test(error)),
        `${kind} accepted lossTangent=${lossTangent}`,
      );
    }
  }
});

test('equal-axis viewport renders circular conductors with a 1:1 scale', () => {
  const geometry = computeGeometry(stackup);
  const viewport = computeViewport(geometry, 1, true);
  const circle = geometry.polys.find(
    (poly) => poly.item?.kind === 'CircleConductors',
  );
  assert.ok(circle);

  const renderedWidth = Math.abs(viewport.sx(circle.x1) - viewport.sx(circle.x0));
  const renderedHeight = Math.abs(viewport.sy(circle.y1) - viewport.sy(circle.y0));
  assert.ok(
    Math.abs(renderedWidth - renderedHeight) < 1e-9,
    `circle rendered ${renderedWidth} px wide by ${renderedHeight} px high`,
  );
  assert.ok(viewport.H >= 220 && viewport.H <= 400);
});

test('solver signal names map back to their source conductor geometry', () => {
  assert.deepEqual(
    solverSignalBindings(stackup).map(({ solverName, userName }) => ({ solverName, userName })),
    [{ solverName: 'Circ4C0', userName: 'round-signal' }],
  );
  assert.deepEqual(
    solverSignalBindings(topWiderGroundCircleStackup).map(
      ({ solverName, userName }) => ({ solverName, userName }),
    ),
    [{ solverName: 'Cond5R0', userName: 'rect-signal' }],
  );
});

test('mixed conductor sets use the solver global signal ordinal in drawing order', () => {
  const expectedNames = ['Trap3T0', 'Cond4R1', 'Cond4R2'];
  assert.deepEqual(
    solverSignalBindings(mixedSignalSetStackup).map(({ solverName }) => solverName),
    expectedNames,
  );
  const geometry = computeGeometry(mixedSignalSetStackup);
  assert.deepEqual(geometry.signalNames, expectedNames);
  assert.deepEqual(
    geometry.polys
      .filter((poly) => poly.kind === 'conductor' && !poly.isGroundConductor)
      .map((poly) => geometry.signalNames[poly.signalIndex]),
    expectedNames,
  );
});

test('mixed conductor-set names match the native solver result', async () => {
  const out = await solve(mixedSignalSetStackup);
  const diagnostics = [out.stderr, out.stdout].filter(Boolean).join('\n');
  assert.equal(out.exitCode, 0, diagnostics);
  assert.ok(out.resultText, diagnostics || 'solver did not create case.result');
  const result = parseResult(out.resultText);
  assert.equal(result.nSignals, 3);
  assert.deepEqual(
    [...result.names].sort(),
    ['Trap3T0', 'Cond4R1', 'Cond4R2'].sort(),
  );
});

test('native BEM solves a circle crossing a sloped dielectric edge', async () => {
  const xsctn = generateXsctn(stackup);
  assert.match(xsctn, /TrapezoidDielectric B3/);
  assert.match(xsctn, /CircleConductors Circ4/);

  assertPhysicalSingleLine(await solve(stackup));
});

test('native BEM solves a circle fully contained by a trapezoid', async () => {
  assert.deepEqual(validateStackup(containedCircleStackup), []);
  assertPhysicalSingleLine(await solve(containedCircleStackup));
});

test('native BEM handles a circular ground wire crossing a top-wider trapezoid', async () => {
  assert.deepEqual(validateStackup(topWiderGroundCircleStackup), []);
  const xsctn = generateXsctn(topWiderGroundCircleStackup);
  assert.match(xsctn, /TrapezoidDielectric B3/);
  assert.match(xsctn, /CircleConductors grFlank4/);
  assert.match(xsctn, /RectangleConductors Cond5/);
  assertPhysicalSingleLine(await solve(topWiderGroundCircleStackup));
});
