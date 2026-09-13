import { WorkTracker } from './workEta.mjs';
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
import { FineProgressTracker } from './fineProgress.ts';
import { parseResult } from './parseResult.mjs';
import { parseFieldPlot } from './parseFieldPlot.mjs';
import {
  computeGrid,
  type FieldPotentialOptions,
  type MaskPoly,
  type MaskRect,
} from '../field/potential.ts';
import { runGoalSeek, type GoalSeekSpec } from '../analysis/goalSeek.ts';
import {
  type SolveProgress,
} from './solveProgress.ts';

// Emscripten module factory: lives in public/, served at <base>/wasm/. The
// worker script itself is bundled under <base>/assets/, so relative
// resolution here would land in the wrong directory -- the main thread
// (which knows the real document base) sends the URL in an init message.
let bemUrl = new URL('/wasm/bem.mjs', self.location.href).href; // dev fallback

let threadedBemUrl: string | undefined;

function versionedWasmUrl(url: string): string {
  const moduleUrl = new URL(url);
  const wasmUrl = new URL('bem.wasm', moduleUrl);
  // new URL('bem.wasm', moduleUrl) intentionally replaces the filename and
  // would otherwise drop the revision query carried by bem.mjs.
  wasmUrl.search = moduleUrl.search;
  return wasmUrl.href;
}

interface BemModule {
  FS: {
    mkdir(p: string): void;
    writeFile(p: string, data: string): void;
    readFile(p: string, opts: { encoding: 'utf8' }): string;
    chdir(p: string): void;
  };
  callMain(args: string[]): number;
  PThread?: { terminateAllThreads(): void };
}

const factories = new Map<string, (opts: object) => Promise<BemModule>>();
async function getFactory(url: string) {
  if (!factories.has(url)) {
    const mod = await import(/* @vite-ignore */ url);
    factories.set(url, mod.default);
  }
  return factories.get(url)!;
}

export interface SolveRequest {
  recordTelemetry?: boolean;
  xsctn: string;
  cseg: number;
  dseg: number;
}

async function solveOnce(
  req: SolveRequest,
  onProgress?: (progress: SolveProgress) => void,
) {
  const t0 = performance.now();
  const stdout: string[] = [];
  const workTracker = new WorkTracker('serial', Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1)));
  const telemetry: Array<{ms: number; line: string}> | undefined = req.recordTelemetry ? [] : undefined;
  const fineTracker = new FineProgressTracker(req.cseg >= 200);
  const phases: SolveProgress['phase'][] = ['meshing', 'free-space-assembly',
    'free-space-factorization', 'free-space-solves', 'dielectric-assembly',
    'dielectric-factorization', 'finalizing'];
  const progressTracker = { feed: (line: string): SolveProgress | null => {
    const p = fineTracker.feed(line);
    return p ? { estimatedSeconds: p.estimatedSeconds, fraction: p.fraction, phase: p.fraction === 1 ? 'complete' : phases[p.stage] } : null;
  } };
  onProgress?.({ fraction: 0, phase: 'initializing' });
  const instantiate = async (url: string) => {
    const create = await getFactory(url);
    return create({
      print: (s: string) => {
        stdout.push(s);
        const ms = performance.now() - t0;
        telemetry?.push({ms, line: s});
        workTracker.feed(s, ms / 1000);
        const progress = progressTracker.feed(s);
        if (progress) onProgress?.({...progress, work: {...workTracker}});
      },
      printErr: (s: string) => {
        stdout.push(s);
        const ms = performance.now() - t0;
        telemetry?.push({ms, line: s});
        workTracker.feed(s, ms / 1000);
        const progress = progressTracker.feed(s);
        if (progress) onProgress?.({...progress, work: {...workTracker}});
      },
      locateFile: (f: string, prefix: string) =>
        f.endsWith('.wasm') ? versionedWasmUrl(url) : prefix + f,
    });
  };
  let mod: BemModule;
  // Small meshes avoid pool startup; unsupported hosts use the serial asset.
  const useThreads = threadedBemUrl && self.crossOriginIsolated
    && typeof SharedArrayBuffer !== 'undefined' && Math.max(req.cseg, req.dseg) >= 128;
  if (useThreads) {
    try { mod = await instantiate(threadedBemUrl!); }
    catch { mod = await instantiate(bemUrl); }
  } else { mod = await instantiate(bemUrl); }
  try {
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
      telemetry,
      workerTimeOrigin: telemetry ? performance.timeOrigin : undefined,
      workerStartedAt: telemetry ? t0 : undefined,
      elapsedMs: Math.round(performance.now() - t0),
      result,
      error: error ?? parseError,
    };
  } finally { mod.PThread?.terminateAllThreads(); }
}

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data;
  try {
    if (msg.cmd === 'init') {
      bemUrl = msg.bemUrl;
      threadedBemUrl = msg.threadedBemUrl;
      factories.clear();
      return;
    }
    if (msg.cmd === 'solve') {
      const out = await solveOnce(msg, (progress) =>
        (self as unknown as Worker).postMessage({
          id: msg.id,
          evt: 'progress',
          frac: progress.fraction,
          estimatedSeconds: progress.estimatedSeconds,
          phase: progress.phase,
          work: progress.work,
        }),
      );
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
        {
          imagePlaneYM: msg.imagePlaneYM,
          calibrationMode: msg.calibrationMode,
          contourPotentials: msg.contourPotentials,
        } as FieldPotentialOptions,
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
