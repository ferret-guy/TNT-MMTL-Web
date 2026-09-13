import { writeFileSync } from 'node:fs';
import { generateXsctn } from '../src/xsctn/generate.ts';
import { parseResult } from '../src/solver/parseResult.mjs';
globalThis.window = { location: { hash: '' } };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const { decodeHash, defaultState, currentStackup } = await import('../src/model/store.ts');
const hash = '#v=3&kind=microstrip&var=se&mat=jlc-np155f&w=5.93938&h=3.91339&cseg=400&dseg=400&refined_mesh=1&units=mm&f_hz=10000000000';
const state = { ...defaultState(), ...decodeHash(hash) };
const stack = currentStackup(state);
const results = [];
for (let run = 0; run < 4; run++) {
  const factory = (await import(run === 0
    ? '../build/progress-prototype/baseline/bem.mjs'
    : '../public/wasm/bem.mjs')).default;
  const start = performance.now();
  const events = [];
  let region = 'setup';
  const mod = await factory({ print: line => {
    if (/Calculate LHS .*free space/.test(line)) region = 'free-space';
    if (/Calculate LHS .*dielectric/.test(line)) region = 'dielectric';
    if (/MMTL_PROGRESS|Calculate LHS|Calculate RHS|Integrate charge|MMTL is done/.test(line))
      events.push({ ms: performance.now() - start, region, line });
  }, printErr: () => {} });
  mod.FS.mkdir('/work'); mod.FS.chdir('/work');
  mod.FS.writeFile('/work/case.xsctn', generateXsctn(stack));
  mod.callMain(['/work/case', '400', '400']);
  const elapsedMs = performance.now() - start;
  const resultText = mod.FS.readFile('/work/case.result', { encoding: 'utf8' });
  const result = parseResult(resultText);
  const row = { run, baseline: run === 0, elapsedMs, result, resultText, events };
  results.push(row);
  writeFileSync(new URL('../build/progress-prototype/measurements.json', import.meta.url),
    JSON.stringify({ hash, results }, null, 2));
  console.log(JSON.stringify({ run, elapsedMs, z0: result.z0, eventCount: events.length }));
}
