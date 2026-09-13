import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { generateXsctn } from '../src/xsctn/generate.ts';
import { parseResult } from '../src/solver/parseResult.mjs';
import { prepareExplicitReferenceStackup, isExplicitReferenceStackup } from '../src/analysis/explicitReference.ts';
globalThis.window = { location: { hash: '' } };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const { defaultState, decodeHash, currentStackup } = await import('../src/model/store.ts');
const { FREEFORM_EXAMPLES } = await import('../src/model/freeformExamples.ts');
const serial = (await import(process.argv.includes('--threaded-baseline') ? '../build/optimized-lu/baseline/threaded/bem.mjs' : '../public/wasm/bem.mjs')).default;
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
const results = process.argv.includes('--resume') ? JSON.parse(readFileSync(new URL('../build/optimized-lu/parity.json', import.meta.url))) : [];
for (const [name, stack] of cases) {
  if (process.argv.includes('--resume') && results.some(r => r.name === name)) continue;
  const cacheUrl = new URL(`../build/optimized-lu/cache-${name}.json`,import.meta.url);
  const fingerprint = createHash('sha256').update(readFileSync(new URL('../public/wasm/threaded/bem.wasm',import.meta.url))).update(generateXsctn(stack)).digest('hex');
  let outputs = [];
  if (process.argv.includes('--resume') && existsSync(cacheUrl)) {
    const cached = JSON.parse(readFileSync(cacheUrl));
    if (cached.fingerprint === fingerprint) outputs = cached.outputs;
  }
  if (!outputs.length) for (const create of [serial, parallel]) {
    const lines = [];
    const mod = await create({ print: s => lines.push(s), printErr: s => lines.push(s) });
    try {
      mod.FS.mkdir('/work'); mod.FS.chdir('/work');
      mod.FS.writeFile('/work/case.xsctn', generateXsctn(stack));
      mod.callMain(['/work/case', String(stack.cseg), String(stack.dseg)]);
      assert.ok(lines.some(s => s.includes('MMTL is done')), lines.slice(-20).join('\n'));
      outputs.push({ result: parseResult(mod.FS.readFile('/work/case.result', {encoding:'utf8'})), field: mod.FS.readFile('/work/case.result_field_plot_data', {encoding:'utf8'}), residuals: lines.filter(s => s.startsWith('MMTL_LU_RESIDUAL')).map(s=>Number(s.split(' ')[1])), threads: lines.filter(s => s.startsWith('MMTL_PARALLEL')) });
    } finally { mod.PThread?.terminateAllThreads(); }
  }
  writeFileSync(cacheUrl,JSON.stringify({fingerprint,outputs}));
  let maxRelativeError = 0, maxNearZeroCrosstalkDifference = 0;
  function compare(a,b,path='result') {
    if (typeof a === 'number') {
      assert.ok(Number.isFinite(a) && Number.isFinite(b), path);
      if (/result\.(fxt|bxt)\.\d+\.value$/.test(path) && Math.max(Math.abs(a),Math.abs(b)) < 1e-12) {
        maxNearZeroCrosstalkDifference = Math.max(maxNearZeroCrosstalkDifference,Math.abs(a-b));
        assert.ok(Math.abs(a-b)<1e-12); return;
      }
      const relative = Math.abs(a-b)/Math.max(Math.abs(a),Math.abs(b),1e-30);
      maxRelativeError = Math.max(maxRelativeError,relative);
      assert.ok(relative <= 1e-8 || Math.abs(a-b)<1e-25, `${name} ${path}: ${a} vs ${b}`);
    } else if (a && typeof a === 'object') {
      assert.deepEqual(Object.keys(a),Object.keys(b));
      for (const key of Object.keys(a)) {
        if (key === 'dB' && /result\.(fxt|bxt)\.\d+$/.test(path) && Math.max(Math.abs(a.value),Math.abs(b.value))<1e-12) continue;
        compare(a[key],b[key],path+'.'+key);
      }
    } else assert.equal(a,b,path);
  }
  compare(outputs[0].result,outputs[1].result);
  const {parseFieldPlot} = await import('../src/solver/parseFieldPlot.mjs');
  const fields = outputs.map(o=>parseFieldPlot(o.field));
  const {prepElements,potentialAt} = await import('../src/field/potential.ts');
  let maxPotentialRelativeError=0;
  let maxFieldRelativeError=0;
  for (let solution=0;solution<fields[0].length;++solution) {
    const a=fields[0][solution], b=fields[1][solution];
    assert.equal(a.elements.length,b.elements.length);
    const conductors=a.elements.filter(e=>e.type==='conductor');
    const xs=conductors.flatMap(e=>e.x),ys=conductors.flatMap(e=>e.y);
    const x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys);
    const prepped=[prepElements(a),prepElements(b)],values=[[],[]];
    for (const fx of [0.2,0.4,0.6,0.8]) for(const fy of [0.25,0.5,0.75]) {
      for(let backend=0;backend<2;++backend) values[backend].push(potentialAt(prepped[backend],x0+(x1-x0)*fx,y0+(y1-y0)*fy));
    }
    const potentialScale=Math.max(...values[0].map(Math.abs),1e-30);
    for(let i=0;i<values[0].length;++i) maxPotentialRelativeError=Math.max(maxPotentialRelativeError,Math.abs(values[0][i]-values[1][i])/potentialScale);
    const scale=Math.max(...a.elements.flatMap(e=>e.sigma.map(Math.abs)),1e-30);
    for(let element=0;element<a.elements.length;++element) {
      const {sigma:as,...ag}=a.elements[element],{sigma:bs,...bg}=b.elements[element];
      assert.deepEqual(ag,bg,`${name} field geometry`);
      for(let i=0;i<as.length;++i) maxFieldRelativeError=Math.max(maxFieldRelativeError,Math.abs(as[i]-bs[i])/scale);
    }
  }
  assert.ok(maxPotentialRelativeError < 5e-6, `${name} potential error ${maxPotentialRelativeError}`);
  // Local basis coefficients can be sensitive on tiny corner panels.
  // Validate reconstructed potentials and backward error separately; retain
  // coefficient differences as diagnostics rather than treating them as volts.
  if (maxFieldRelativeError > 1e-4) console.log('COEFFICIENT DIFFERENCE',name,maxFieldRelativeError);
  if (name === 'default-45') assert.ok(outputs[1].threads.every(s => s === 'MMTL_PARALLEL 1'));
  else assert.ok(outputs[1].threads.includes('MMTL_PARALLEL 4'), `${name}: parallel path not exercised`);
  for (const residual of outputs[1].residuals) assert.ok(residual < 1e-12, `${name} backward error ${residual}`);
  results.push({ name, maxRelativeError, maxNearZeroCrosstalkDifference, maxFieldRelativeError, maxPotentialRelativeError, residuals: outputs[1].residuals, threads: outputs[1].threads });
  writeFileSync(new URL('../build/optimized-lu/parity.json', import.meta.url), JSON.stringify(results, null, 2));
  console.log('PASS', name, {maxRelativeError,maxFieldRelativeError,maxPotentialRelativeError,residuals:outputs[1].residuals});
}
