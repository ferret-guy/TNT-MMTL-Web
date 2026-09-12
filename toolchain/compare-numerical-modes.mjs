/** Local before/after evidence and reproducible inputs for native parity checks. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildPreset, defaultParams } from '../src/model/presets.ts';
import { generateXsctn } from '../src/xsctn/generate.ts';
import { parseResult } from '../src/solver/parseResult.mjs';
import { freeSpaceStackup } from '../src/analysis/meshReferenceLoss.ts';
import { prepareExplicitReferenceStackup, reduceExplicitReferenceResults } from '../src/analysis/explicitReference.ts';

globalThis.window = { location: { hash: '' } };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const { RIBBON_CABLE_EXAMPLE_STATE, CAT5E_PAIR_EXAMPLE_STATE } = await import('../src/model/freeformExamples.ts');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'build/numerical-v1');
const baseline = resolve(process.argv[2] ?? join(output, 'baseline'));
const currentFactory = (await import(pathToFileURL(join(root, 'public/wasm/bem.mjs')).href)).default;
const baselineFactory = (await import(pathToFileURL(join(baseline, 'public/wasm/bem.mjs')).href)).default;
const oldReducer = (await import(pathToFileURL(join(baseline, 'src/analysis/explicitReference.ts')).href)).reduceExplicitReferenceResults;
const nativeCases = [];
mkdirSync(join(output, 'cases'), { recursive: true });

async function solve(factory, stackup, name, save) {
  const log = [];
  const mod = await factory({ print: (s) => log.push(s), printErr: (s) => log.push(s) });
  const input = generateXsctn(stackup);
  mod.FS.mkdir('/work'); mod.FS.chdir('/work');
  mod.FS.writeFile('/work/case.xsctn', input);
  const oldExit = process.exitCode;
  try { mod.callMain(['/work/case', String(stackup.cseg), String(stackup.dseg)]); }
  finally { process.exitCode = oldExit; }
  if (!log.join('\n').includes('MMTL is done')) throw new Error(`${name} failed: ${log.slice(-8).join('\n')}`);
  const text = mod.FS.readFile('/work/case.result', { encoding: 'utf8' });
  if (save) {
    writeFileSync(join(output, 'cases', `${name}.xsctn`), input);
    writeFileSync(join(output, 'cases', `${name}.result`), text);
    nativeCases.push({ name, cseg: stackup.cseg, dseg: stackup.dseg });
  }
  return parseResult(text);
}

const cases = [];
for (const kind of ['microstrip', 'stripline', 'cpw']) {
  for (const variant of ['se', 'diff']) {
    cases.push({ name: `${kind}-${variant}`, stackup: buildPreset(kind, variant, defaultParams(kind, variant)) });
  }
}
cases.push({ name: 'ribbon', stackup: RIBBON_CABLE_EXAMPLE_STATE.freeform, explicit: true });
cases.push({ name: 'cat5', stackup: CAT5E_PAIR_EXAMPLE_STATE.freeform, explicit: true });
const rows = [];
for (const entry of cases) {
  const result = {};
  for (const [label, factory, reducer] of [
    ['before', baselineFactory, oldReducer], ['after', currentFactory, reduceExplicitReferenceResults],
  ]) {
    const start = performance.now();
    let r;
    if (entry.explicit) {
      const preparation = prepareExplicitReferenceStackup(entry.stackup);
      const dielectric = await solve(factory, preparation.solverStackup, `${entry.name}-dielectric`, label === 'after');
      const air = await solve(factory, freeSpaceStackup(preparation.solverStackup), `${entry.name}-air`, label === 'after');
      r = reducer(preparation, dielectric, air).result;
    } else {
      r = await solve(factory, entry.stackup, entry.name, label === 'after');
    }
    result[label] = { elapsedMs: performance.now() - start, z0: r.z0, B: r.B, L: r.L, epsEff: r.epsEff, velocity: r.velocity };
  }
  const row = { name: entry.name, ...result,
    z0ChangePercent: result.after.z0.map((v, i) => 100 * (v / result.before.z0[i] - 1)) };
  rows.push(row);
  console.log(`${entry.name}: ${result.before.z0.join(', ')} -> ${result.after.z0.join(', ')} ohm; change ${row.z0ChangePercent.map((v) => v.toFixed(5)).join(', ')}%`);
  writeFileSync(join(output, 'mode-comparison.json'), JSON.stringify({
    wasmSha256: createHash('sha256').update(readFileSync(join(root, 'public/wasm/bem.wasm'))).digest('hex'),
    note: 'Same geometry and mesh settings. Observed differences, not physical error bounds.', rows,
  }, null, 2));
  writeFileSync(join(output, 'native-cases.json'), JSON.stringify(nativeCases, null, 2));
}
