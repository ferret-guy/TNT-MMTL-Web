#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const {
  exportGenericSpiceSubcircuit,
  exportTouchstoneS2p,
} = await import(
  pathToFileURL(join(root, 'src/export/modelExport.ts'))
);

const FREQUENCY_HZ = 1e9;
const LADDER_SECTIONS = 64;
const ABSOLUTE_COMPLEX_TOLERANCE = 5e-5;

function interoperabilityInput() {
  return {
    title: 'Web MMTL interop line',
    flow: 'preset-se',
    result: {
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
    },
    conductors: [{
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
    }],
    unitScaleM: 1e-6,
    lengthM: 0.0254,
    designFreqHz: FREQUENCY_HZ,
    lossParams: {
      includeReferencePlaneLoss: true,
      roughnessModel: 'hammerstad',
      roughnessRqUm: 1,
      hurayRadiusUm: 0.5,
      hurayRatio: 2.2,
      // The basic ladder freezes R and G at designFreqHz. A one-point
      // Touchstone sweep at that same frequency is the exact interop contract.
      fMinHz: FREQUENCY_HZ,
      fMaxHz: FREQUENCY_HZ,
      nPoints: 1,
    },
    referencePlane: {
      source: 'analytic',
      geometryPerM: [[1200]],
      conductivity: 5.8e7,
      thicknessM: 35e-6,
    },
    tanD: 0.016,
  };
}

test('scikit-rf Touchstone and ngspice ladder agree as a complete two-port', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'web-mmtl-interop-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const input = interoperabilityInput();
  const touchstone = exportTouchstoneS2p(input);
  const ladder = exportGenericSpiceSubcircuit(input, LADDER_SECTIONS);
  const touchstonePath = join(directory, touchstone.filename);
  const ladderPath = join(directory, ladder.filename);
  await Promise.all([
    writeFile(touchstonePath, touchstone.text, 'utf8'),
    writeFile(ladderPath, ladder.text, 'utf8'),
  ]);

  const python = process.env.PYTHON || 'python';
  const helper = join(here, 'verify_touchstone_ngspice.py');
  const result = spawnSync(
    python,
    [
      helper,
      '--touchstone', touchstonePath,
      '--subcircuit', ladderPath,
      '--frequency-hz', String(FREQUENCY_HZ),
      '--absolute-tolerance', String(ABSOLUTE_COMPLEX_TOLERANCE),
    ],
    {
      cwd: directory,
      encoding: 'utf8',
      env: process.env,
      timeout: 60_000,
    },
  );

  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    [
      'The scikit-rf/ngspice interoperability check failed.',
      `stdout:\n${result.stdout}`,
      `stderr:\n${result.stderr}`,
    ].join('\n'),
  );
  const reportLine = result.stdout.trim().split(/\r?\n/).at(-1);
  assert.ok(reportLine, 'the interoperability helper returned no report');
  const report = JSON.parse(reportLine);
  assert.equal(report.points, 1);
  assert.equal(report.ports, 2);
  assert.equal(report.frequency_hz, FREQUENCY_HZ);
  assert.ok(
    report.max_complex_error <= ABSOLUTE_COMPLEX_TOLERANCE,
    `maximum complex S-parameter error was ${report.max_complex_error}`,
  );
  t.diagnostic(
    `scikit-rf ${report.scikit_rf_version}; maximum |Delta S| = ` +
      report.max_complex_error.toExponential(3),
  );
});
