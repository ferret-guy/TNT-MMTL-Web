import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { calculateMmtlCrosstalk } from '../../src/analysis/crosstalk.ts';
import { parseResult } from '../../src/solver/parseResult.mjs';

function assertNear(actual, expected, label, relative = 2e-5) {
  const tolerance = Math.max(1e-15, Math.abs(expected) * relative);
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} != ${expected} (tol ${tolerance})`,
  );
}

test('JavaScript crosstalk matches every pair in MMTL five-line output', async () => {
  const resultText = await readFile(
    new URL('../../vendor/mmtl/bem/tests/w10t2.5.result', import.meta.url),
    'utf8',
  );
  const native = parseResult(resultText);
  const calculated = calculateMmtlCrosstalk(
    native.names,
    native.B,
    native.L,
    native.velocity,
    native.couplingLengthM,
    native.riseTimePs,
  );

  assert.equal(calculated.fxt.length, 10);
  assert.equal(calculated.bxt.length, 10);
  for (const kind of ['fxt', 'bxt']) {
    assert.deepEqual(
      calculated[kind].map(({ active, passive }) => [active, passive]),
      native[kind].map(({ active, passive }) => [active, passive]),
      `${kind} active/passive ordering`,
    );
    for (let index = 0; index < native[kind].length; index++) {
      const actual = calculated[kind][index];
      const expected = native[kind][index];
      assertNear(actual.value, expected.value, `${kind} value ${index}`);
      assert.ok(actual.dB != null && expected.dB != null);
      assertNear(actual.dB, expected.dB, `${kind} dB ${index}`, 5e-6);
    }
  }
});

test('N-port crosstalk applies forward scaling and backward saturation', () => {
  const names = ['A', 'B', 'C'];
  const capacitance = [
    [100e-12, -10e-12, -5e-12],
    [-10e-12, 100e-12, 0],
    [-5e-12, 0, 100e-12],
  ];
  const inductance = [
    [250e-9, 12.5e-9, 12.5e-9],
    [12.5e-9, 250e-9, 0],
    [12.5e-9, 0, 250e-9],
  ];
  const velocity = [2e8, 2e8, 2e8];
  const short = calculateMmtlCrosstalk(
    names,
    capacitance,
    inductance,
    velocity,
    0.01,
    1000,
  );
  const long = calculateMmtlCrosstalk(
    names,
    capacitance,
    inductance,
    velocity,
    0.2,
    1000,
  );
  const fasterEdge = calculateMmtlCrosstalk(
    names,
    capacitance,
    inductance,
    velocity,
    0.01,
    500,
  );

  assert.deepEqual(
    short.fxt.map(({ active, passive }) => [active, passive]),
    [['A', 'B'], ['A', 'C'], ['B', 'C']],
  );
  assertNear(long.fxt[0].value, 20 * short.fxt[0].value, 'FXT length scaling', 1e-12);
  assertNear(fasterEdge.fxt[0].value, 2 * short.fxt[0].value, 'FXT rise-time scaling', 1e-12);
  assertNear(short.bxt[0].value, 0.00375, 'short-line BXT', 1e-12);
  assertNear(fasterEdge.bxt[0].value, 2 * short.bxt[0].value, 'BXT rise-time scaling', 1e-12);
  assertNear(long.bxt[0].value, 0.0375, 'long-line BXT saturation', 1e-12);
  assertNear(short.fxt[1].value, 0, 'balanced capacitive/inductive FXT', 1e-12);
  assert.equal(Math.abs(short.fxt[2].value), 0);
  assert.equal(short.fxt[2].dB, null);
  assert.equal(Math.abs(short.bxt[2].value), 0);
  assert.equal(short.bxt[2].dB, null);
});

test('crosstalk rejects nonphysical dimensions and timing', () => {
  const validMatrix = [[1]];
  assert.throws(
    () => calculateMmtlCrosstalk(['A'], validMatrix, validMatrix, [1], 0, 100),
    /coupling length/i,
  );
  assert.throws(
    () => calculateMmtlCrosstalk(['A'], validMatrix, validMatrix, [1], 1, 0),
    /rise time/i,
  );
  assert.throws(
    () => calculateMmtlCrosstalk(['A', 'B'], validMatrix, validMatrix, [1, 1], 1, 100),
    /2 by 2 matrix/i,
  );
});
