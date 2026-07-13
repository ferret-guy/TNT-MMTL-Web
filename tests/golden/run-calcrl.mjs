#!/usr/bin/env node
/** Run one calcRL input through public/wasm/calcrl.mjs; .out text to stdout. */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const inputPath = process.argv[2];
if (!inputPath) {
  console.error('usage: run-calcrl.mjs <input.in>');
  process.exit(2);
}

const createCalcRLModule = (await import(pathToFileURL(join(root, 'public', 'wasm', 'calcrl.mjs')))).default;
const mod = await createCalcRLModule({ print: () => {}, printErr: (s) => process.stderr.write(s + '\n') });
mod.FS.mkdir('/work');
mod.FS.writeFile('/work/case.in', readFileSync(inputPath, 'utf8'));
mod.FS.chdir('/work');
try {
  mod.callMain(['/work/case']);
} catch (e) {
  if (e?.name !== 'ExitStatus') throw e;
}
process.stdout.write(mod.FS.readFile('/work/case.out', { encoding: 'utf8' }));
