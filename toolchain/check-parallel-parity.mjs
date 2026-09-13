// Exact assembly-only comparison: build threaded with TNTWEB_OPTIMIZED_LU=0.
// For the normal Eigen asset, use check-optimized-lu-parity.mjs instead.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { generateXsctn } from '../src/xsctn/generate.ts';
import { parseResult } from '../src/solver/parseResult.mjs';
import { prepareExplicitReferenceStackup, isExplicitReferenceStackup } from '../src/analysis/explicitReference.ts';
globalThis.window = { location: { hash: '' } };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const { defaultState, decodeHash, currentStackup } = await import('../src/model/store.ts');
const { FREEFORM_EXAMPLES } = await import('../src/model/freeformExamples.ts');
const serial = (await import('../public/wasm/bem.mjs')).default;
const parallel = (await import('../public/wasm/threaded/bem.mjs')).default;
const cases = [];
for (const kind of ['microstrip', 'stripline', 'cpw']) for (const variant of ['se', 'diff']) {
  const stack = currentStackup({ ...defaultState(), ...decodeHash(`#v=3&kind=${kind}&var=${variant}&cseg=128&dseg=128&refined_mesh=0`) });
  if (kind === 'stripline') { stack.cseg = 400; stack.dseg = 400; }
  cases.push([`${kind}-${variant}`, stack]);
}
for (const example of FREEFORM_EXAMPLES.filter(e => e.id !== 'ribbon-many-port')) {
  const stack = { ...currentStackup(example.state), cseg: 128, dseg: 128 };
  cases.push([example.id, isExplicitReferenceStackup(stack) ? prepareExplicitReferenceStackup(stack).solverStackup : stack]);
}
cases.push(['default-45', currentStackup(defaultState())]);
const results = process.argv[2] ? JSON.parse(readFileSync(new URL('../build/parallel-assembly/parity.json', import.meta.url))) : [];
for (const [name, stack] of cases) {
  if (process.argv[2] && results.some(r => r.name === name)) continue;
  const outputs = [];
  for (const create of [serial, parallel]) {
    const lines = [];
    const mod = await create({ print: s => lines.push(s), printErr: s => lines.push(s) });
    try {
      mod.FS.mkdir('/work'); mod.FS.chdir('/work');
      mod.FS.writeFile('/work/case.xsctn', generateXsctn(stack));
      mod.callMain(['/work/case', String(stack.cseg), String(stack.dseg)]);
      assert.ok(!lines.some(s => s.startsWith('MMTL_LU Eigen')), 'Exact assembly-only check requires TNTWEB_OPTIMIZED_LU=0; use check-optimized-lu-parity.mjs for Eigen.');
      assert.ok(lines.some(s => s.includes('MMTL is done')), lines.slice(-20).join('\n'));
      outputs.push({ result: parseResult(mod.FS.readFile('/work/case.result', {encoding:'utf8'})), field: mod.FS.readFile('/work/case.result_field_plot_data', {encoding:'utf8'}), threads: lines.filter(s => s.startsWith('MMTL_PARALLEL')) });
    } finally { mod.PThread?.terminateAllThreads(); }
  }
  assert.deepEqual(outputs[1].result, outputs[0].result, name);
  assert.equal(outputs[1].field, outputs[0].field, `${name} field data`);
  if (name === 'default-45') assert.ok(outputs[1].threads.every(s => s === 'MMTL_PARALLEL 1'));
  else assert.ok(outputs[1].threads.includes('MMTL_PARALLEL 4'), `${name}: parallel path not exercised`);
  results.push({ name, exactResultParity: true, exactFieldParity: true, threads: outputs[1].threads });
  writeFileSync(new URL('../build/parallel-assembly/parity.json', import.meta.url), JSON.stringify(results, null, 2));
  console.log('PASS', name, outputs[1].threads.join(', '));
}
