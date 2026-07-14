#!/usr/bin/env node
/** Separate upper/lower stripline laminate regressions. */
import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.window = { location: { hash: '' } };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const { buildPreset, defaultParams } = await import('../../src/model/presets.ts');
const {
  JLCPCB_LAMINATES,
  LAMINATES,
  materialAtFrequency,
} = await import('../../src/model/materials.ts');
const { decodeHash, defaultState, encodeConfig } = await import('../../src/model/store.ts');

function dielectric(stackup, id) {
  return stackup.items.find((item) => item.kind === 'DielectricLayer' && item.id === id);
}

test('laminates have stable unique IDs and JLC presets carry frequency samples', () => {
  assert.deepEqual(
    JLCPCB_LAMINATES.map(({ id }) => id),
    ['jlc-np155f', 'jlc-s1000-2m'],
  );

  const ids = LAMINATES.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length, 'laminate IDs must be unique');
  for (const laminate of LAMINATES) {
    assert.ok(typeof laminate.id === 'string' && laminate.id.length > 0, 'laminate ID is required');
    assert.doesNotMatch(laminate.id, /[&=]/, laminate.id);
  }
  for (const laminate of JLCPCB_LAMINATES) {
    assert.ok(laminate.samples.length >= 2, `${laminate.id} needs a dispersive lookup`);
    assert.equal(laminate.note, 'Interpolated from vendor data');
    for (let i = 0; i < laminate.samples.length; i++) {
      const sample = laminate.samples[i];
      assert.ok(Number.isFinite(sample.fHz) && sample.fHz > 0);
      assert.ok(Number.isFinite(sample.er) && sample.er >= 1);
      assert.ok(Number.isFinite(sample.tanD) && sample.tanD >= 0);
      if (i > 0) assert.ok(sample.fHz > laminate.samples[i - 1].fHz, 'samples must be sorted');
    }
  }
});

test('material lookup is exact at samples, log-frequency interpolated, and endpoint-clamped', () => {
  const laminate = JLCPCB_LAMINATES[0];
  const [a, b] = laminate.samples;
  const exact = materialAtFrequency(laminate.id, a.fHz);
  assert.equal(exact?.er, a.er);
  assert.equal(exact?.tanD, a.tanD);
  assert.equal(exact?.clamped, null);

  const midpointHz = Math.sqrt(a.fHz * b.fHz);
  const midpoint = materialAtFrequency(laminate.id, midpointHz);
  assert.ok(midpoint);
  assert.ok(Math.abs(midpoint.er - (a.er + b.er) / 2) < 1e-12);
  assert.ok(Math.abs(midpoint.tanD - (a.tanD + b.tanD) / 2) < 1e-12);
  assert.equal(midpoint.clamped, null);

  const first = laminate.samples[0];
  const last = laminate.samples.at(-1);
  assert.ok(last);
  const low = materialAtFrequency(laminate.id, first.fHz / 1000);
  const high = materialAtFrequency(laminate.id, last.fHz * 1000);
  assert.deepEqual([low?.er, low?.tanD, low?.clamped], [first.er, first.tanD, 'low']);
  assert.deepEqual([high?.er, high?.tanD, high?.clamped], [last.er, last.tanD, 'high']);
  assert.equal(materialAtFrequency('not-a-material', 1e9), null);
});

test('buildPreset resolves selected material properties at the design frequency', () => {
  const laminate = JLCPCB_LAMINATES[1];
  const [a, b] = laminate.samples;
  const designFreqHz = Math.sqrt(a.fHz * b.fHz);
  const expected = materialAtFrequency(laminate.id, designFreqHz);
  assert.ok(expected);
  const stackup = buildPreset('microstrip', 'se', {
    ...defaultParams('microstrip', 'se'),
    laminateId: laminate.id,
    er: 99,
    tanD: 0.99,
  }, designFreqHz);
  assert.deepEqual(
    [dielectric(stackup, 'sub')?.permittivity, dielectric(stackup, 'sub')?.lossTangent],
    [expected.er, expected.tanD],
  );
});

test('shared stripline material remains identical above and below', () => {
  const p = {
    ...defaultParams('stripline', 'se'),
    laminateId: null,
    laminateId2: null,
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
    laminateId: null,
    laminateId2: null,
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

test('split stripline resolves the upper and lower selected materials independently', () => {
  const lowerMaterial = JLCPCB_LAMINATES[0];
  const upperMaterial = JLCPCB_LAMINATES[1];
  const designFreqHz = 5e9;
  const lowerExpected = materialAtFrequency(lowerMaterial.id, designFreqHz);
  const upperExpected = materialAtFrequency(upperMaterial.id, designFreqHz);
  assert.ok(lowerExpected && upperExpected);
  const stackup = buildPreset('stripline', 'se', {
    ...defaultParams('stripline', 'se'),
    striplineSeparateMaterials: true,
    laminateId: lowerMaterial.id,
    laminateId2: upperMaterial.id,
    er: 99,
    tanD: 0.99,
    er2: 88,
    tanD2: 0.88,
  }, designFreqHz);
  assert.deepEqual(
    [dielectric(stackup, 'sub1')?.permittivity, dielectric(stackup, 'sub1')?.lossTangent],
    [lowerExpected.er, lowerExpected.tanD],
  );
  assert.deepEqual(
    [dielectric(stackup, 'sub2')?.permittivity, dielectric(stackup, 'sub2')?.lossTangent],
    [upperExpected.er, upperExpected.tanD],
  );
});

test('split stripline material survives a readable-link round trip', () => {
  const state = defaultState();
  state.presetKind = 'stripline';
  state.presetParams = {
    ...defaultParams('stripline', 'se'),
    laminateId: null,
    laminateId2: null,
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

test('selected shared and split material IDs survive readable-link round trips', () => {
  const shared = defaultState();
  shared.presetKind = 'microstrip';
  shared.presetParams = {
    ...defaultParams('microstrip', 'se'),
    laminateId: JLCPCB_LAMINATES[0].id,
  };
  let encoded = encodeConfig(shared);
  assert.equal(new URLSearchParams(encoded).get('mat'), JLCPCB_LAMINATES[0].id);
  let decoded = decodeHash(`#${encoded}`);
  assert.equal(decoded?.presetParams?.laminateId, JLCPCB_LAMINATES[0].id);

  const split = defaultState();
  split.presetKind = 'stripline';
  split.presetParams = {
    ...defaultParams('stripline', 'se'),
    striplineSeparateMaterials: true,
    laminateId: JLCPCB_LAMINATES[0].id,
    laminateId2: JLCPCB_LAMINATES[1].id,
  };
  encoded = encodeConfig(split);
  const query = new URLSearchParams(encoded);
  assert.equal(query.get('mat'), JLCPCB_LAMINATES[0].id);
  assert.equal(query.get('mat2'), JLCPCB_LAMINATES[1].id);
  decoded = decodeHash(`#${encoded}`);
  assert.equal(decoded?.presetParams?.laminateId, JLCPCB_LAMINATES[0].id);
  assert.equal(decoded?.presetParams?.laminateId2, JLCPCB_LAMINATES[1].id);
});

test('a split link preserves a custom upper material independently of a selected lower material', () => {
  const state = defaultState();
  state.presetKind = 'stripline';
  state.presetParams = {
    ...defaultParams('stripline', 'se'),
    striplineSeparateMaterials: true,
    laminateId: JLCPCB_LAMINATES[0].id,
    laminateId2: null,
    er2: 3.48,
    tanD2: 0.0037,
  };
  const encoded = encodeConfig(state);
  const query = new URLSearchParams(encoded);
  assert.equal(query.get('mat'), JLCPCB_LAMINATES[0].id);
  assert.equal(query.get('mat2'), null);
  assert.equal(query.get('er2'), '3.48');
  assert.equal(query.get('tand2'), '0.0037');

  const decoded = decodeHash(`#${encoded}`);
  assert.equal(decoded?.presetParams?.laminateId, JLCPCB_LAMINATES[0].id);
  assert.equal(decoded?.presetParams?.laminateId2, null);
  assert.equal(decoded?.presetParams?.er2, 3.48);
  assert.equal(decoded?.presetParams?.tanD2, 0.0037);
});

test('custom and unknown material IDs decode as editable custom values', () => {
  const custom = defaultState();
  custom.presetParams = {
    ...defaultParams('microstrip', 'se'),
    laminateId: null,
    er: 3.33,
    tanD: 0.0123,
  };
  const customDecoded = decodeHash(`#${encodeConfig(custom)}`);
  assert.equal(customDecoded?.presetParams?.laminateId, null);
  assert.equal(customDecoded?.presetParams?.er, 3.33);
  assert.equal(customDecoded?.presetParams?.tanD, 0.0123);

  const unknown = decodeHash('#v=3&kind=microstrip&var=se&mat=retired-material&er=3.21&tand=0.009');
  assert.equal(unknown?.presetParams?.laminateId, null);
  assert.equal(unknown?.presetParams?.er, 3.21);
  assert.equal(unknown?.presetParams?.tanD, 0.009);
});

test('existing links stay shared and concise split links inherit the common material', () => {
  const shared = decodeHash('#v=3&kind=stripline&var=se&er=3.5&tand=0.01');
  assert.equal(shared?.presetParams?.striplineSeparateMaterials, false);
  assert.equal(shared?.presetParams?.laminateId, null);
  const stackup = buildPreset('stripline', 'se', shared.presetParams);
  assert.equal(dielectric(stackup, 'sub2')?.permittivity, 3.5);
  assert.equal(dielectric(stackup, 'sub2')?.lossTangent, 0.01);

  const inherited = decodeHash('#v=3&kind=stripline&var=se&split_lam=1&er=3.5&tand=0.01');
  assert.equal(inherited?.presetParams?.laminateId, null);
  assert.equal(inherited?.presetParams?.laminateId2, null);
  assert.equal(inherited?.presetParams?.er2, 3.5);
  assert.equal(inherited?.presetParams?.tanD2, 0.01);
});
