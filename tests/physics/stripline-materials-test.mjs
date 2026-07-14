#!/usr/bin/env node
/** Separate upper/lower stripline laminate regressions. */
import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.window = { location: { hash: '' } };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const { buildPreset, defaultParams } = await import('../../src/model/presets.ts');
const { decodeHash, defaultState, encodeConfig } = await import('../../src/model/store.ts');

function dielectric(stackup, id) {
  return stackup.items.find((item) => item.kind === 'DielectricLayer' && item.id === id);
}

test('shared stripline material remains identical above and below', () => {
  const p = {
    ...defaultParams('stripline', 'se'),
    er: 3.66,
    tanD: 0.009,
    er2: 9.9,
    tanD2: 0.2,
    striplineSeparateMaterials: false,
  };
  const stackup = buildPreset('stripline', 'se', p);
  assert.deepEqual(
    [dielectric(stackup, 'sub1')?.permittivity, dielectric(stackup, 'sub1')?.lossTangent],
    [3.66, 0.009],
  );
  assert.deepEqual(
    [dielectric(stackup, 'sub2')?.permittivity, dielectric(stackup, 'sub2')?.lossTangent],
    [3.66, 0.009],
  );
});

test('split stripline assigns independent materials and preserves both clearances', () => {
  const p = {
    ...defaultParams('stripline', 'se'),
    h: 10,
    h2: 6,
    t: 1.4,
    er: 4.27,
    tanD: 0.016,
    er2: 3.66,
    tanD2: 0.009,
    striplineSeparateMaterials: true,
  };
  const stackup = buildPreset('stripline', 'se', p);
  const lower = dielectric(stackup, 'sub1');
  const upper = dielectric(stackup, 'sub2');
  assert.deepEqual(
    [lower?.thickness, lower?.permittivity, lower?.lossTangent],
    [10, 4.27, 0.016],
  );
  // The layer starts at trace-bottom height, so its stack thickness is h2 + t.
  assert.deepEqual(
    [upper?.thickness, upper?.permittivity, upper?.lossTangent],
    [7.4, 3.66, 0.009],
  );
});

test('split stripline material survives a readable-link round trip', () => {
  const state = defaultState();
  state.presetKind = 'stripline';
  state.presetParams = {
    ...defaultParams('stripline', 'se'),
    er: 4.28,
    tanD: 0.014,
    er2: 3.48,
    tanD2: 0.0037,
    striplineSeparateMaterials: true,
  };
  const encoded = encodeConfig(state);
  assert.match(encoded, /(?:^|&)split_lam=1(?:&|$)/);
  assert.match(encoded, /(?:^|&)er2=3\.48(?:&|$)/);
  assert.match(encoded, /(?:^|&)tand2=0\.0037(?:&|$)/);

  const decoded = decodeHash(`#${encoded}`);
  assert.equal(decoded?.presetParams?.striplineSeparateMaterials, true);
  assert.equal(decoded?.presetParams?.er, 4.28);
  assert.equal(decoded?.presetParams?.tanD, 0.014);
  assert.equal(decoded?.presetParams?.er2, 3.48);
  assert.equal(decoded?.presetParams?.tanD2, 0.0037);
});

test('existing links stay shared and concise split links inherit the common material', () => {
  const shared = decodeHash('#v=3&kind=stripline&var=se&er=3.5&tand=0.01');
  assert.equal(shared?.presetParams?.striplineSeparateMaterials, false);
  const stackup = buildPreset('stripline', 'se', shared.presetParams);
  assert.equal(dielectric(stackup, 'sub2')?.permittivity, 3.5);
  assert.equal(dielectric(stackup, 'sub2')?.lossTangent, 0.01);

  const inherited = decodeHash('#v=3&kind=stripline&var=se&split_lam=1&er=3.5&tand=0.01');
  assert.equal(inherited?.presetParams?.er2, 3.5);
  assert.equal(inherited?.presetParams?.tanD2, 0.01);
});
