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

const { generateXsctn, validateStackup } = await import(
  pathToFileURL(join(root, 'src/xsctn/generate.ts'))
);
const { parseResult } = await import(pathToFileURL(join(root, 'src/solver/parseResult.mjs')));
const createBemModule = (await import(pathToFileURL(join(root, 'public/wasm/bem.mjs')))).default;

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
