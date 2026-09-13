import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
globalThis.window = { location: { hash: '' } };
globalThis.localStorage = {
  getItem: () => JSON.stringify({ v: 3, presetParams: { cseg: 400, dseg: 400, highAccuracy: true } }),
  setItem: () => {},
};
const { store, defaultState, decodeHash, currentStackup } = await import('../../src/model/store.ts');
const { FREEFORM_EXAMPLES } = await import('../../src/model/freeformExamples.ts');

test('fresh open resets saved expensive mesh settings', () => {
  const state = store.get();
  assert.equal(state.presetParams.cseg, 45);
  assert.equal(state.presetParams.dseg, 45);
  assert.equal(state.presetParams.highAccuracy, false);
  assert.equal(state.freeform.cseg, 45);
  assert.equal(state.freeform.dseg, 45);
  assert.equal(currentStackup(state).polygonEdgeSegments, undefined);
});

test('all About and cable examples start with interactive meshes', () => {
  const html = readFileSync(new URL('../../about.html', import.meta.url), 'utf8');
  const hrefs = [...html.matchAll(/href="\.\/(#[^"]+)"/g)].map(m => m[1].replaceAll('&amp;', '&'));
  hrefs.push(...FREEFORM_EXAMPLES.map(e => e.href.slice(e.href.indexOf('#'))));
  assert.ok(hrefs.length >= 7);
  for (const hash of hrefs) {
    const decoded = decodeHash(hash);
    assert.ok(decoded, hash);
    const state = { ...defaultState(), ...decoded };
    const stack = currentStackup(state);
    assert.equal(stack.cseg, 45, hash);
    assert.equal(stack.dseg, 45, hash);
    assert.equal(state.presetParams.highAccuracy, false, hash);
  }
});
