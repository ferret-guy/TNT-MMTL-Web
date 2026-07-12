#!/usr/bin/env node
/**
 * WASM golden harness: runs public/wasm/bem.mjs against every fixture in
 * vendor/mmtl/bem/tests, writing the produced .result files to an output
 * directory (default build/golden-wasm). Numeric comparison against the
 * .result_save goldens is done by toolchain/compare_results.py (invoked by
 * toolchain/run-golden-wasm.sh, or manually).
 *
 * Also exercises the fresh-module-per-solve policy and reports peak RSS so
 * repeated solves can be checked for leaks (--repeat N).
 *
 * usage: node run-golden.mjs [--outDir dir] [--repeat N] [--fixture name]
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const testsDir = join(root, 'vendor', 'mmtl', 'bem', 'tests');
const wasmMjs = join(root, 'public', 'wasm', 'bem.mjs');

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const outDir = resolve(opt('--outDir', join(root, 'build', 'golden-wasm')));
const repeat = parseInt(opt('--repeat', '1'), 10);
const only = opt('--fixture', null);

mkdirSync(outDir, { recursive: true });

const createBemModule = (await import(pathToFileURL(wasmMjs))).default;

/** One solve in a FRESH module instance (mirrors the browser worker policy). */
async function solve(xsctnText, cseg, dseg) {
  const stdout = [];
  const mod = await createBemModule({
    print: (s) => stdout.push(s),
    printErr: (s) => stdout.push(s),
  });
  mod.FS.mkdir('/work');
  mod.FS.writeFile('/work/case.xsctn', xsctnText);
  mod.FS.chdir('/work');
  let exitCode = 0;
  try {
    exitCode = mod.callMain(['/work/case', String(cseg), String(dseg)]);
  } catch (e) {
    if (e && e.name === 'ExitStatus') exitCode = e.status;
    else throw e;
  }
  const log = stdout.join('\n');
  const ok = log.includes('MMTL is done');
  let result = null, field = null;
  try { result = mod.FS.readFile('/work/case.result', { encoding: 'utf8' }); } catch {}
  try { field = mod.FS.readFile('/work/case.result_field_plot_data', { encoding: 'utf8' }); } catch {}
  return { ok, exitCode, log, result, field };
}

const fixtures = readdirSync(testsDir)
  .filter((f) => f.endsWith('.result_save'))
  .map((f) => f.replace(/\.result_save$/, ''))
  .filter((n) => existsSync(join(testsDir, `${n}.xsctn`)))
  .filter((n) => !only || n === only);

let failures = 0;
for (const name of fixtures) {
  const save = readFileSync(join(testsDir, `${name}.result_save`), 'utf8');
  const cseg = save.match(/\[cseg\] = (\d+)/)?.[1] ?? '0';
  const dseg = save.match(/\[dseg\] = (\d+)/)?.[1] ?? '0';
  const xsctn = readFileSync(join(testsDir, `${name}.xsctn`), 'utf8');

  const t0 = Date.now();
  let last = null;
  for (let i = 0; i < repeat; i++) last = await solve(xsctn, cseg, dseg);
  const ms = Date.now() - t0;

  if (!last.ok || !last.result) {
    failures++;
    console.log(`FAIL ${name}: solver did not finish (exit ${last.exitCode})`);
    console.log(last.log.split('\n').slice(-6).map((l) => `    ${l}`).join('\n'));
    continue;
  }
  writeFileSync(join(outDir, `${name}.result`), last.result);
  if (last.field) writeFileSync(join(outDir, `${name}.result_field_plot_data`), last.field);
  const rss = Math.round(process.memoryUsage().rss / 1e6);
  console.log(`ran  ${name} (cseg=${cseg} dseg=${dseg}) x${repeat} in ${ms} ms, rss ${rss} MB`);
}
console.log(failures === 0 ? `all ${fixtures.length} fixtures ran` : `${failures} fixtures failed to run`);
process.exit(failures === 0 ? 0 : 1);
