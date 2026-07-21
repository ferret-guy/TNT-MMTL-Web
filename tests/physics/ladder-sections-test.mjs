#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const {
  formatLadderBandwidth,
  ladderDelayPerM,
  ladderSectionRequirementText,
  recommendedLadderSections,
  requiredLadderSections,
} = await import(pathToFileURL(join(root, 'src/analysis/ladderSections.ts')));

function result(overrides = {}) {
  return {
    nSignals: 1,
    names: ['Line1'],
    B: [[100e-12]],
    L: [[250e-9]],
    Rdc: [[1]],
    z0: [50],
    epsEff: [3],
    velocity: [2e8],
    delay: [5e-9],
    fxt: [],
    bxt: [],
    warnings: [],
    ...overrides,
  };
}

test('section recommendation implements ceil(13*BW*td)', () => {
  assert.equal(requiredLadderSections(1e9, 5e-9, 0.0254), 2);
  assert.equal(requiredLadderSections(5e9, 5e-9, 0.0254), 9);
  assert.equal(requiredLadderSections(1e9, 1e-9, 1), 13);
  assert.equal(requiredLadderSections(1e9, 1.001e-9, 1), 14);
});

test('section recommendation has a one-section floor and rejects invalid inputs', () => {
  assert.equal(requiredLadderSections(1e6, 1e-12, 1e-3), 1);
  assert.equal(requiredLadderSections(0, 5e-9, 0.0254), null);
  assert.equal(requiredLadderSections(1e9, Number.NaN, 0.0254), null);
  assert.equal(requiredLadderSections(1e9, 5e-9, -1), null);
});

test('guided differential recommendation follows differential delay', () => {
  const solved = result({
    nSignals: 2,
    names: ['P', 'N'],
    delay: [4e-9, 4e-9],
    delayOdd: 6e-9,
  });
  assert.equal(ladderDelayPerM(solved, 'preset-diff'), 6e-9);
  assert.equal(recommendedLadderSections(solved, 'preset-diff', 0.1, 1e9), 8);
});

test('arbitrary recommendation uses the slowest reported line', () => {
  const solved = result({
    nSignals: 3,
    names: ['A', 'B', 'C'],
    delay: [4e-9, 7e-9, 5e-9],
  });
  assert.equal(ladderDelayPerM(solved, 'arbitrary'), 7e-9);
  assert.equal(recommendedLadderSections(solved, 'arbitrary', 0.1, 1e9), 10);
});

test('requirement text uses only the requested MHz or GHz sentence', () => {
  assert.equal(formatLadderBandwidth(125e6), '125 MHz');
  assert.equal(formatLadderBandwidth(2.45e9), '2.45 GHz');
  assert.equal(
    ladderSectionRequirementText(2, 500e6),
    '2 sections required to simulate with 1% phase error up to 500 MHz for this line length',
  );
  assert.equal(
    ladderSectionRequirementText(9, 5e9),
    '9 sections required to simulate with 1% phase error up to 5 GHz for this line length',
  );
});
