import { readFileSync, writeFileSync } from 'node:fs';
import { generateXsctn } from '../src/xsctn/generate.ts';
import { parseResult } from '../src/solver/parseResult.mjs';
import createModule from '../public/wasm/bem.mjs';
globalThis.window = { location: { hash: '' } };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const { decodeHash, defaultState, currentStackup } = await import('../src/model/store.ts');
const file = new URL('../about.html', import.meta.url);
let html = readFileSync(file, 'utf8');
const links = [...new Set(html.match(/\.\/#v=3[^" ]+/g))];
async function impedance(hash) {
  const decoded = decodeHash(hash);
  const defaults = defaultState();
  const stack = currentStackup({ ...defaults, ...decoded,
    presetParams: { ...defaults.presetParams, ...decoded.presetParams } });
  const log = [];
  const mod = await createModule({ print: s => log.push(s), printErr: s => log.push(s) });
  mod.FS.mkdir('/work'); mod.FS.chdir('/work');
  mod.FS.writeFile('/work/case.xsctn', generateXsctn(stack));
  mod.callMain(['/work/case', String(stack.cseg), String(stack.dseg)]);
  if (!log.join('\n').includes('MMTL is done')) throw new Error(log.slice(-10).join('\n'));
  return parseResult(mod.FS.readFile('/work/case.result', { encoding: 'utf8' })).z0[0];
}
for (const link of links) {
  const q = new URLSearchParams(link.replaceAll('&amp;', '&').split('#')[1]);
  q.set('t', q.get('kind') === 'microstrip' ? '1.4' : '0.7');
  q.set('etch_delta', '0.5');
  q.set('cseg', '45'); q.set('dseg', '45');
  let w = Number(q.get('w'));
  let previousW = w * 1.05;
  q.set('w', String(previousW));
  let previousZ = await impedance('#' + q);
  for (let i = 0; i < 8; i++) {
    q.set('w', w.toFixed(6));
    const z = await impedance('#' + q);
    console.log(q.get('kind'), q.get('h'), q.get('w'), z);
    if (Math.abs(z - 50) < 0.002) break;
    const next = w - (z - 50) * (w - previousW) / (z - previousZ);
    previousW = w; previousZ = z; w = next;
    if (i === 7) throw new Error('Tuning did not converge');
  }
  html = html.replaceAll(link, './#' + q.toString().replaceAll('&', '&amp;'));
}
writeFileSync(file, html);
