#!/usr/bin/env node
/** Propagation velocity and delay display-unit regressions. */
import assert from 'node:assert/strict';
import test from 'node:test';

const { renderResults } = await import('../../src/ui/resultsPanel.ts');

test('results show velocity and convert seconds per meter to picoseconds per centimetre', () => {
  const summary = { innerHTML: '' };
  const matrices = { innerHTML: '' };
  renderResults(summary, matrices, {
    ok: true,
    exitCode: 0,
    stdout: '',
    resultText: '',
    fieldText: null,
    elapsedMs: 1,
    result: {
      nSignals: 1,
      names: ['line'],
      B: [[1]],
      L: [[1]],
      Rdc: [[1]],
      z0: [50],
      epsEff: [3.4],
      velocity: [1.629e8],
      delay: [6.139e-9],
      fxt: [],
      bxt: [],
      warnings: [],
    },
  });

  assert.match(summary.innerHTML, /Propagation velocity/);
  assert.match(summary.innerHTML, /1\.629e\+8 m\/s/);
  assert.match(summary.innerHTML, /Propagation delay per unit length/);
  assert.match(summary.innerHTML, /61\.39 ps\/cm/);
  assert.doesNotMatch(summary.innerHTML, /6\.14 ps\/cm/);
});
