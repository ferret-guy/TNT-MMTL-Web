import { writeFileSync } from 'node:fs';
import { parseResult } from '../src/solver/parseResult.mjs';
import { generateXsctn } from '../src/xsctn/generate.ts';
globalThis.window = { location: { hash: '' } };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const { defaultState, decodeHash, currentStackup } = await import('../src/model/store.ts');
const hash = '#v=3&kind=microstrip&var=se&mat=jlc-np155f&w=5.93938&h=3.91339&cseg=400&dseg=400&refined_mesh=1&units=mm&f_hz=10000000000';
const stack = currentStackup({ ...defaultState(), ...decodeHash(hash) });
const rows = [];
for (const mode of ['eigen']) {
  const create = (await import(mode === 'linpack'
    ? '../build/optimized-lu/baseline/threaded/bem.mjs'
    : '../public/wasm/threaded/bem.mjs')).default;
  const started = performance.now();
  const events = [], lines = [];
  let fieldText;
  const mod = await create({ print: line => {
    lines.push(line);
    if (/MMTL_LU|MMTL_PARALLEL|MMTL_PROGRESS|Calculate LHS|MMTL is done/.test(line))
      events.push({ ms: performance.now() - started, line });
    if (/MMTL_PARALLEL|Calculate LHS|MMTL_PROGRESS factorization 0 /.test(line)) console.log(mode, line);
  }, printErr: line => console.error(line) });
  try {
    mod.FS.mkdir('/work'); mod.FS.chdir('/work');
    mod.FS.writeFile('/work/case.xsctn', generateXsctn(stack));
    mod.callMain(['/work/case', '400', '400']);
    if (!lines.some(s => s.includes('MMTL is done'))) throw Error('Solve failed');
    const result = parseResult(mod.FS.readFile('/work/case.result', { encoding: 'utf8' }));
    fieldText = mod.FS.readFile('/work/case.result_field_plot_data', {encoding:'utf8'});
    writeFileSync(new URL(`../build/optimized-lu/validation-${mode}-${rows.length}.field`, import.meta.url), fieldText);
    const row = { mode, residuals: lines.filter(s=>s.startsWith('MMTL_LU_RESIDUAL')).map(s=>Number(s.split(' ')[1])), elapsedMs: performance.now() - started, result, events };
    rows.push(row);
    writeFileSync(new URL('../build/optimized-lu/validation-400.json', import.meta.url), JSON.stringify({ hash, rows }, null, 2));
    console.log(mode, row.elapsedMs, result.z0);
  } finally { mod.PThread?.terminateAllThreads(); }
}
