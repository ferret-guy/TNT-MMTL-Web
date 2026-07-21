#!/usr/bin/env node
/** Total trace-width etch reduction and current-config regressions. */
import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.window = { location: { hash: '' } };
const storageReads = [];
globalThis.localStorage = {
  getItem: (key) => {
    storageReads.push(key);
    return null;
  },
  setItem: () => {},
};

const {
  buildPreset,
  defaultParams,
  etchReductionOf,
  referencePlaneThicknessOf,
  topWidthOf,
} = await import('../../src/model/presets.ts');
const { decodeHash, decodeSavedState, defaultState, encodeConfig } = await import('../../src/model/store.ts');
const { etchFactorIcon } = await import('../../src/ui/presetForm.ts');
const { generateXsctn } = await import('../../src/xsctn/generate.ts');

test('the store reads only the current local-storage namespace', () => {
  assert.deepEqual(storageReads, ['tnt-web-state-v3']);
});

test('reference-plane loss and linked foil weight default on', () => {
  const state = defaultState();
  assert.equal(state.lossParams.includeReferencePlaneLoss, true);
  for (const kind of ['microstrip', 'stripline', 'cpw']) {
    for (const variant of ['se', 'diff']) {
      const params = defaultParams(kind, variant);
      assert.equal(params.referencePlaneSameWeight, true);
      assert.equal(referencePlaneThicknessOf(params), params.t);
    }
  }
  const encoded = encodeConfig(state);
  assert.doesNotMatch(encoded, /(?:^|&)ref_loss=/);
  assert.doesNotMatch(encoded, /(?:^|&)ref_same_wt=/);
  assert.doesNotMatch(encoded, /(?:^|&)ref_t=/);
});

test('reference-plane controls round-trip in readable links', () => {
  const state = defaultState();
  state.lossParams = {
    ...state.lossParams,
    includeReferencePlaneLoss: false,
  };
  state.presetParams = {
    ...state.presetParams,
    referencePlaneSameWeight: false,
    referencePlaneThickness: 2.8,
  };
  const encoded = encodeConfig(state);
  assert.match(encoded, /(?:^|&)ref_loss=0(?:&|$)/);
  assert.match(encoded, /(?:^|&)ref_same_wt=0(?:&|$)/);
  assert.match(encoded, /(?:^|&)ref_t=2\.8(?:&|$)/);
  const decoded = decodeHash(`#${encoded}`);
  assert.equal(decoded?.lossParams?.includeReferencePlaneLoss, false);
  assert.equal(decoded?.presetParams?.referencePlaneSameWeight, false);
  assert.equal(decoded?.presetParams?.referencePlaneThickness, 2.8);
  assert.equal(referencePlaneThicknessOf(decoded.presetParams), 2.8);
});

test('legacy v3 state gains linked, enabled reference-plane defaults', () => {
  const legacy = {
    v: 3,
    mode: 'preset',
    presetKind: 'microstrip',
    presetVariant: 'se',
    presetParams: {
      ...defaultParams('microstrip', 'se'),
      t: 2.8,
    },
    lossParams: {
      roughnessModel: 'none',
      roughnessRqUm: 1,
      hurayRadiusUm: 0.5,
      hurayRatio: 2.2,
      fMinHz: 1e6,
      fMaxHz: 1e10,
      nPoints: 160,
    },
  };
  delete legacy.presetParams.referencePlaneSameWeight;
  delete legacy.presetParams.referencePlaneThickness;
  const decoded = decodeSavedState(JSON.stringify(legacy));
  assert.equal(decoded?.lossParams.includeReferencePlaneLoss, true);
  assert.equal(decoded?.presetParams.referencePlaneSameWeight, true);
  assert.equal(decoded?.presetParams.referencePlaneThickness, 2.8);
  assert.equal(referencePlaneThicknessOf(decoded.presetParams), 2.8);
});

test('reference foil metadata does not alter the electrostatic XSCTN geometry', () => {
  const params = defaultParams('microstrip', 'diff');
  const linked = buildPreset('microstrip', 'diff', params);
  const separate = buildPreset('microstrip', 'diff', {
    ...params,
    referencePlaneSameWeight: false,
    referencePlaneThickness: 4.2,
  });
  assert.equal(generateXsctn(linked), generateXsctn(separate));
});

test('JLC total-width reduction is the preset default and is thickness-independent', () => {
  const defaults = defaultParams('microstrip', 'se');
  assert.equal(defaults.etch, 0.5);
  assert.equal(topWidthOf(10, 0.5), 9.5);

  for (const thickness of [0.7, 2.8]) {
    const stackup = buildPreset('microstrip', 'se', {
      ...defaults,
      w: 10,
      t: thickness,
      etch: 0.5,
      cover: null,
    });
    const trace = stackup.items.find((item) => item.kind === 'TrapezoidConductors' && !item.isGround);
    assert.ok(trace);
    assert.equal(trace.bottomWidth, 10);
    assert.equal(trace.topWidth, 9.5);
  }
});

test('Etch Factor icon shows a trapezoid and the measured total width reduction', () => {
  const markup = etchFactorIcon();
  const points = markup.match(/data-etch-role="profile"[^>]*points="([^"]+)"/)?.[1]
    .trim().split(/\s+/).map((pair) => pair.split(',').map(Number));
  assert.deepEqual(points, [[4, 23], [42, 23], [35, 7], [11, 7]]);

  const bottomSpan = points[1][0] - points[0][0];
  const topSpan = points[2][0] - points[3][0];
  assert.equal(bottomSpan, 38);
  assert.equal(topSpan, 24);
  assert.equal((points[0][0] + points[1][0]) / 2, (points[2][0] + points[3][0]) / 2,
    'top and bottom widths are centered');
  assert(topSpan < bottomSpan * 0.8, 'the taper remains obvious at icon size');

  assert.match(markup, /data-etch-role="top-width"/);
  assert.match(markup, /data-etch-role="bottom-width"/);
  assert.match(markup, /data-etch-role="total-reduction"/);
  assert.match(markup, /\u0394W =/);
  assert.match(markup, /Wb \u2212 Wt/);
  assert.match(markup, /total width reduction, not per side/);
});

test('etch reduction can exceed one mil when the resulting top remains physical', () => {
  assert.equal(topWidthOf(10, 2), 8);
  assert.equal(etchReductionOf(10, 9), 8, 'stored reduction matches the 20% top-width safety limit');
  const state = defaultState();
  state.presetParams = { ...state.presetParams, w: 10, etch: 9 };
  const encoded = encodeConfig(state);
  assert.match(encoded, /(?:^|&)etch_delta=8(?:&|$)/);
  assert.equal(decodeHash(`#${encoded}`)?.presetParams?.etch, 8);
});

test('obsolete, unversioned, and unknown readable links are rejected', () => {
  for (const hash of [
    '#kind=microstrip&var=se&t=0.7&etch=0.7',
    '#v=1&kind=microstrip&var=se&t=0.7&etch=0.7',
    '#v=2&kind=microstrip&var=se&t=0.7&etch=0.7',
    '#v=4&kind=microstrip&var=se&etch_delta=0.7',
    '#v=3&kind=microstrip&var=se&etch=0.7',
  ]) {
    assert.equal(decodeHash(hash), null, hash);
  }

  const token = btoa(JSON.stringify({ v: 2, mode: 'preset' }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(decodeHash(`#cfg=${token}`), null);
});

test('readable links clamp nonphysical roughness inputs', () => {
  const decoded = decodeHash(
    '#v=3&kind=microstrip&var=se&rough=huray&rq_um=-2&huray_r_um=-1&huray_sr=-3',
  );
  assert.equal(decoded?.lossParams?.roughnessRqUm, 0);
  assert.equal(decoded?.lossParams?.hurayRadiusUm, 0);
  assert.equal(decoded?.lossParams?.hurayRatio, 0);
});

test('current readable links round-trip a dimensional etch delta', () => {
  const state = defaultState();
  state.presetParams = { ...state.presetParams, etch: 0.65 };
  const encoded = encodeConfig(state);
  assert.match(encoded, /(?:^|&)v=3(?:&|$)/);
  assert.match(encoded, /(?:^|&)etch_delta=0\.65(?:&|$)/);
  assert.doesNotMatch(encoded, /(?:^|&)etch=/);
  const decoded = decodeHash(`#${encoded}`);
  assert.equal(decoded?.presetParams?.etch, 0.65);
});

test('a current link with no etch override uses the current dimensional default', () => {
  assert.equal(decodeHash('#v=3&kind=microstrip&var=se')?.presetParams?.etch, 0.5);
});

test('saved state accepts exactly v3 and preserves current etch semantics', () => {
  const current = {
    v: 3,
    mode: 'preset',
    presetKind: 'microstrip',
    presetVariant: 'se',
    presetParams: { ...defaultParams('microstrip', 'se'), w: 10, etch: 0.65 },
  };
  assert.equal(decodeSavedState(JSON.stringify(current))?.presetParams.etch, 0.65);

  current.presetParams.etch = 9;
  assert.equal(decodeSavedState(JSON.stringify(current))?.presetParams.etch, 8);

  for (const v of [undefined, 1, 2, 4]) {
    const stale = { ...current };
    if (v === undefined) delete stale.v;
    else stale.v = v;
    assert.equal(decodeSavedState(JSON.stringify(stale)), null, `v=${String(v)}`);
  }
  assert.equal(decodeSavedState('{bad json'), null);
});
