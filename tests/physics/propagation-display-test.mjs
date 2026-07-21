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

test('floating pairs show differential impedance without inventing common mode', () => {
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
      names: ['pair[1]'],
      floatingDifferential: {
        positiveName: 'pair[1]',
        negativeName: 'pair[2]',
      },
      B: [[100e-12]],
      L: [[1e-6]],
      Rdc: [[1]],
      z0: [100],
      epsEff: [2.25],
      velocity: [2e8],
      delay: [5e-9],
      fxt: [],
      bxt: [],
      warnings: [],
    },
  });

  assert.match(summary.innerHTML, /Differential Z/);
  assert.match(summary.innerHTML, /100\.00 Ω/);
  assert.equal((summary.innerHTML.match(/100\.00 Ω/g) ?? []).length, 1);
  assert.doesNotMatch(
    summary.innerHTML,
    />Impedance<|Odd-mode Z|Odd \/ Even|Common-mode Z/,
  );
  assert.match(summary.innerHTML, /2\.000e\+8 m\/s/);
  assert.match(summary.innerHTML, /50\.00 ps\/cm/);
});

test('N-port free-form results show named forward and backward crosstalk pairs', () => {
  const summary = { innerHTML: '' };
  const matrices = { innerHTML: '' };
  const names = ['SIG[1]', 'SIG[2]', 'SIG[3]'];
  const pairs = [
    { active: names[0], passive: names[1], value: 0.01, dB: -40 },
    { active: names[0], passive: names[2], value: 0.001, dB: -60 },
    { active: names[1], passive: names[2], value: 0.0001, dB: -80 },
  ];
  renderResults(summary, matrices, {
    ok: true,
    exitCode: 0,
    stdout: '',
    resultText: '',
    fieldText: null,
    elapsedMs: 1,
    result: {
      nSignals: 3,
      names,
      B: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
      L: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
      Rdc: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
      z0: [50, 50, 50],
      epsEff: [2, 2, 2],
      velocity: [2e8, 2e8, 2e8],
      delay: [5e-9, 5e-9, 5e-9],
      fxt: pairs,
      bxt: pairs,
      warnings: [],
    },
  }, true);

  assert.match(matrices.innerHTML, /Far-end \(forward\) crosstalk/);
  assert.match(matrices.innerHTML, /Near-end \(backward\) crosstalk/);
  const forwardStart = matrices.innerHTML.indexOf('Far-end (forward) crosstalk');
  const backwardStart = matrices.innerHTML.indexOf('Near-end (backward) crosstalk');
  const forwardHtml = matrices.innerHTML.slice(forwardStart, backwardStart);
  const backwardHtml = matrices.innerHTML.slice(backwardStart);
  let previousForward = -1;
  let previousBackward = -1;
  for (const { active, passive } of pairs) {
    const pairText = `${active} to ${passive}`;
    const forwardIndex = forwardHtml.indexOf(pairText);
    const backwardIndex = backwardHtml.indexOf(pairText);
    assert.ok(forwardIndex > previousForward, `forward pair order: ${pairText}`);
    assert.ok(backwardIndex > previousBackward, `backward pair order: ${pairText}`);
    previousForward = forwardIndex;
    previousBackward = backwardIndex;
  }
  assert.match(
    forwardHtml,
    /SIG\[1\] to SIG\[2\]<\/td><td>0\.01000<\/td><td>-40\.0 dB/,
  );
  assert.doesNotMatch(matrices.innerHTML, /→|−∞/);
  assert.equal((matrices.innerHTML.match(/<tbody>/g) ?? []).length, 5);
});
