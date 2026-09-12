import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPreset, defaultParams } from '../../src/model/presets.ts';
import { generateXsctn, validateStackup } from '../../src/xsctn/generate.ts';
import { parseResult } from '../../src/solver/parseResult.mjs';
import { parseFieldPlot } from '../../src/solver/parseFieldPlot.mjs';
import { refineConductorMesh } from '../../src/analysis/meshReferenceLoss.ts';
import createBemModule from '../../public/wasm/bem.mjs';

globalThis.window = { location: { hash: '' } };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const { defaultState, encodeConfig, decodeHash } = await import('../../src/model/store.ts');

async function solve(stackup, source = generateXsctn(stackup)) {
  const log = [];
  const mod = await createBemModule({ print: (s) => log.push(s), printErr: (s) => log.push(s) });
  mod.FS.mkdir('/work');
  mod.FS.chdir('/work');
  mod.FS.writeFile('/work/input.xsctn', source);
  const previousExit = process.exitCode;
  try {
    mod.callMain(['/work/input', String(stackup.cseg), String(stackup.dseg)]);
  } catch (error) {
    if (error?.name !== 'ExitStatus') throw error;
  } finally {
    process.exitCode = previousExit;
  }
  const ok = log.join('\n').includes('MMTL is done');
  return {
    ok, log: log.join('\n'),
    result: ok ? parseResult(mod.FS.readFile('/work/input.result', { encoding: 'utf8' })) : null,
    field: ok ? parseFieldPlot(mod.FS.readFile('/work/input.result_field_plot_data', { encoding: 'utf8' })) : null,
  };
}

const near = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual / expected - 1) < tolerance, `${label}: ${actual} versus ${expected}`);

test('vacuum circular wire agrees with independent analytic C and L', async () => {
  const radius = 20, height = 100, c = 299792458;
  const stackup = {
    title: 'wire over plane', units: 'microns', couplingLengthM: 0.1, riseTimePs: 100,
    cseg: 160, dseg: 160,
    items: [
      { kind: 'GroundPlane', id: 'g' },
      { kind: 'DielectricLayer', id: 'air', thickness: height - radius, permittivity: 1, lossTangent: 0 },
      { kind: 'CircleConductors', id: 'wire', isGround: false, conductivity: 5.8e7,
        diameter: 2 * radius, number: 1, pitch: 0, xOffset: 300, yOffset: 0 },
    ],
  };
  const { ok, result, log } = await solve(stackup);
  assert.ok(ok, log);
  const L = 2e-7 * Math.acosh(height / radius);
  const C = 1 / (c * c * L);
  near(result.L[0][0], L, 1e-5, 'analytic inductance');
  near(result.B[0][0], C, 1e-5, 'analytic capacitance');
  near(result.velocity[0], c, 1e-12, 'vacuum propagation');
  near(result.B[0][0] * result.L[0][0], 1 / (c * c), 1e-12, 'vacuum LC identity');
});

test('graded polygon mesh is independent of horizontal origin and takes explicit edge counts', async () => {
  const params = { ...defaultParams('microstrip', 'se'), units: 'microns',
    w: 150, h: 100, t: 35, etch: 12, er: 1, laminateId: null, cover: null, cseg: 80, dseg: 40 };
  const base = buildPreset('microstrip', 'se', params);
  base.polygonEdgeSegments = [8, 32, 8, 32];
  const shifted = structuredClone(base);
  shifted.items.filter((i) => 'xOffset' in i).forEach((i) => { i.xOffset += 10000; });
  const a = await solve(base), b = await solve(shifted);
  assert.ok(a.ok, a.log);
  assert.ok(b.ok, b.log);
  near(a.result.B[0][0], b.result.B[0][0], 1e-8, 'translation C');
  near(a.result.L[0][0], b.result.L[0][0], 1e-8, 'translation L');
  const elements = a.field[0].elements.filter((e) => e.type === 'conductor' && e.y[0] > 0);
  assert.equal(elements.length, 80);
  assert.ok(elements.every((e) => [...e.x, ...e.y, ...e.sigma].every(Number.isFinite)));
  const widths = elements.map((e) => Math.hypot(e.x[2] - e.x[0], e.y[2] - e.y[0]));
  assert.ok(Math.max(...widths) / Math.min(...widths) > 100, 'corner refinement actually reaches the solver');
  const refined = await solve(refineConductorMesh(base, 2));
  assert.ok(refined.ok, refined.log);
  assert.equal(refined.field[0].elements.filter((e) => e.type === 'conductor' && e.y[0] > 0).length, 160);
});

test('invalid edge counts fail before solving', async () => {
  const stackup = buildPreset('microstrip', 'se', defaultParams('microstrip', 'se'));
  stackup.polygonEdgeSegments = [0, 32, 8, 32];
  assert.ok(validateStackup(stackup).some((s) => s.includes('edge segments')));
  const result = await solve(stackup);
  assert.equal(result.ok, false);
  assert.match(result.log, /EDGE_SEGMENTS requires four integers/);
});

test('refined settings survive a share link and remain scoped to single microstrip', () => {
  const state = defaultState();
  state.presetKind = 'microstrip'; state.presetVariant = 'se';
  state.presetParams = { ...defaultParams('microstrip', 'se'), highAccuracy: true, cseg: 400, dseg: 400 };
  const restored = decodeHash(encodeConfig(state));
  assert.equal(restored.presetParams.highAccuracy, true);
  const stackup = buildPreset('microstrip', 'se', restored.presetParams);
  assert.deepEqual(stackup.polygonEdgeSegments, [40, 160, 40, 160]);
  assert.match(generateXsctn(stackup), /set EDGE_SEGMENTS 40 160 40 160/);
  assert.equal(buildPreset('cpw', 'se', restored.presetParams).polygonEdgeSegments, undefined);
  assert.equal(buildPreset('microstrip', 'diff', restored.presetParams).polygonEdgeSegments, undefined);
});
