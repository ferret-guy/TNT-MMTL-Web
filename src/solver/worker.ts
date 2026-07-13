/**
 * Solver Web Worker. Each solve instantiates a FRESH wasm module -- main()
 * leaves file-scope globals and f2c static locals dirty, so instances are
 * single-shot by design (validated by the 50-solve leak check).
 *
 * Protocol (postMessage):
 *   -> { id, cmd: 'solve', xsctn, cseg, dseg }
 *   <- { id, ...SolveOutput }
 *   -> { id, cmd: 'goalSeek', spec }        (see analysis/goalSeek.ts)
 *   <- { id, evt: 'iter', ... } progress events, then { id, done: true, ... }
 */
import { parseResult } from './parseResult.mjs';
import { parseFieldPlot } from './parseFieldPlot.mjs';
import { computeGrid, type MaskPoly, type MaskRect } from '../field/potential.ts';
import { runGoalSeek, type GoalSeekSpec } from '../analysis/goalSeek.ts';

// Emscripten module factory: lives in public/, served at <base>/wasm/. The
// worker script itself is bundled under <base>/assets/, so relative
// resolution here would land in the wrong directory -- the main thread
// (which knows the real document base) sends the URL in an init message.
let bemUrl = new URL('/wasm/bem.mjs', self.location.href).href; // dev fallback

interface BemModule {
  FS: {
    mkdir(p: string): void;
    writeFile(p: string, data: string): void;
    readFile(p: string, opts: { encoding: 'utf8' }): string;
    chdir(p: string): void;
  };
  callMain(args: string[]): number;
}

let calcrlUrl = new URL('/wasm/calcrl.mjs', self.location.href).href; // dev fallback

let factory: ((opts: object) => Promise<BemModule>) | null = null;
let calcrlFactory: ((opts: object) => Promise<BemModule>) | null = null;

async function getFactory() {
  if (!factory) {
    const mod = await import(/* @vite-ignore */ bemUrl);
    factory = mod.default;
  }
  return factory!;
}

async function getCalcRLFactory() {
  if (!calcrlFactory) {
    const mod = await import(/* @vite-ignore */ calcrlUrl);
    calcrlFactory = mod.default;
  }
  return calcrlFactory!;
}

/** one calcRL run (single frequency) in a fresh module instance */
async function calcRLOnce(inputText: string): Promise<string> {
  const create = await getCalcRLFactory();
  const mod = await create({
    print: () => {},
    printErr: () => {},
    locateFile: (f: string, prefix: string) =>
      f.endsWith('.wasm') ? new URL('calcrl.wasm', calcrlUrl).href : prefix + f,
  });
  mod.FS.mkdir('/work');
  mod.FS.writeFile('/work/case.in', inputText);
  mod.FS.chdir('/work');
  try {
    mod.callMain(['/work/case']);
  } catch (e) {
    const err = e as { name?: string };
    if (err?.name !== 'ExitStatus') throw e;
  }
  return mod.FS.readFile('/work/case.out', { encoding: 'utf8' });
}

export interface SolveRequest {
  xsctn: string;
  cseg: number;
  dseg: number;
}

async function solveOnce(req: SolveRequest) {
  const t0 = performance.now();
  const stdout: string[] = [];
  const create = await getFactory();
  const mod = await create({
    print: (s: string) => stdout.push(s),
    printErr: (s: string) => stdout.push(s),
    locateFile: (f: string, prefix: string) =>
      f.endsWith('.wasm') ? new URL('bem.wasm', bemUrl).href : prefix + f,
  });
  mod.FS.mkdir('/work');
  mod.FS.writeFile('/work/case.xsctn', req.xsctn);
  mod.FS.chdir('/work');
  let exitCode = 0;
  let error: string | undefined;
  try {
    exitCode = mod.callMain(['/work/case', String(req.cseg), String(req.dseg)]);
  } catch (e) {
    const err = e as { name?: string; status?: number; message?: string };
    if (err?.name === 'ExitStatus') exitCode = err.status ?? 1;
    else error = err?.message ?? String(e);
  }
  const log = stdout.join('\n');
  const ok = !error && log.includes('MMTL is done');
  let resultText: string | null = null;
  let fieldText: string | null = null;
  try {
    resultText = mod.FS.readFile('/work/case.result', { encoding: 'utf8' });
  } catch {
    /* no result file */
  }
  try {
    fieldText = mod.FS.readFile('/work/case.result_field_plot_data', { encoding: 'utf8' });
  } catch {
    /* no field file */
  }
  let result = null;
  let parseError: string | undefined;
  if (ok && resultText) {
    try {
      result = parseResult(resultText);
    } catch (e) {
      parseError = `result parse failed: ${(e as Error).message}`;
    }
  }
  return {
    ok: ok && !!result,
    exitCode,
    stdout: log,
    resultText,
    fieldText,
    elapsedMs: Math.round(performance.now() - t0),
    result,
    error: error ?? parseError,
  };
}

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data;
  try {
    if (msg.cmd === 'init') {
      bemUrl = msg.bemUrl;
      if (msg.calcrlUrl) calcrlUrl = msg.calcrlUrl;
      factory = null; // re-import against the new URL if needed
      calcrlFactory = null;
      return;
    }
    if (msg.cmd === 'calcRLSweep') {
      const inputs = msg.inputs as string[];
      const outs: string[] = [];
      for (let i = 0; i < inputs.length; i++) {
        outs.push(await calcRLOnce(inputs[i]));
        (self as unknown as Worker).postMessage({
          id: msg.id,
          evt: 'progress',
          frac: (i + 1) / inputs.length,
        });
      }
      (self as unknown as Worker).postMessage({ id: msg.id, outs });
      return;
    }
    if (msg.cmd === 'solve') {
      const out = await solveOnce(msg);
      (self as unknown as Worker).postMessage({ id: msg.id, ...out });
    } else if (msg.cmd === 'goalSeek') {
      const spec = msg.spec as GoalSeekSpec;
      const final = await runGoalSeek(spec, solveOnce, (iter) =>
        (self as unknown as Worker).postMessage({ id: msg.id, evt: 'iter', ...iter }),
      );
      (self as unknown as Worker).postMessage({ id: msg.id, done: true, ...final });
    } else if (msg.cmd === 'fieldGrid') {
      const solutions = parseFieldPlot(msg.fieldText as string);
      const which = Math.min(msg.lineIndex ?? 0, solutions.length - 1);
      if (which < 0) throw new Error('no field solutions in plot data');
      const grid = computeGrid(
        solutions[which],
        msg.bbox as { x0: number; y0: number; x1: number; y1: number },
        msg.nx ?? 240,
        msg.ny ?? 180,
        (msg.masks ?? []) as MaskRect[],
        (msg.maskPolys ?? []) as MaskPoly[],
        (frac) => (self as unknown as Worker).postMessage({ id: msg.id, evt: 'progress', frac }),
      );
      (self as unknown as Worker).postMessage(
        { id: msg.id, ...grid, lines: solutions.map((s) => s.line) },
        [grid.phi.buffer],
      );
    } else {
      throw new Error(`unknown cmd ${msg.cmd}`);
    }
  } catch (e) {
    (self as unknown as Worker).postMessage({
      id: msg.id,
      ok: false,
      error: (e as Error).message,
      done: msg.cmd === 'goalSeek' ? true : undefined,
    });
  }
};
