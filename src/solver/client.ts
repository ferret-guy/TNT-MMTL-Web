/**
 * Main-thread facade over the solver worker: promise-based solve/goalSeek
 * with progress callbacks; cancel = terminate + respawn.
 */
import type { SolveOutput } from '../model/types.ts';
import type { GoalSeekIter, GoalSeekOutcome, GoalSeekSpec } from '../analysis/goalSeek.ts';
import type { SolveProgressPhase } from './solveProgress.ts';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onIter?: (it: GoalSeekIter) => void;
  onProgress?: (frac: number, phase?: SolveProgressPhase) => void;
}

// Public WASM assets keep stable filenames in both Vite development and the
// static build. Tie their cache key to the native build so an already-open
// browser cannot keep an older solver after bem.wasm is rebuilt.
const BEM_ASSET_REVISION = 'ffc02abe';

function versionedBemUrl(): string {
  const url = new URL(
    `${import.meta.env.BASE_URL}wasm/bem.mjs`,
    document.baseURI,
  );
  url.searchParams.set('v', BEM_ASSET_REVISION);
  return url.href;
}

export class SolverClient {
  private worker: Worker;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  busy = false;

  constructor() {
    this.worker = this.spawn();
  }

  private spawn(): Worker {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    // resolve the wasm location from the document base (the worker itself is
    // bundled under <base>/assets/ and cannot resolve <base> on its own)
    w.postMessage({
      cmd: 'init',
      bemUrl: versionedBemUrl(),
    });
    w.onmessage = (ev) => this.dispatch(ev.data);
    w.onerror = (ev) => {
      for (const p of this.pending.values()) p.reject(new Error(ev.message || 'worker error'));
      this.pending.clear();
      this.busy = false;
    };
    return w;
  }

  private dispatch(msg: { id: number; evt?: string; done?: boolean } & Record<string, unknown>) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.evt === 'iter') {
      p.onIter?.(msg as unknown as GoalSeekIter);
      return;
    }
    if (msg.evt === 'progress') {
      const progress = msg as unknown as {
        frac: number;
        phase?: SolveProgressPhase;
      };
      p.onProgress?.(progress.frac, progress.phase);
      return;
    }
    this.pending.delete(msg.id);
    this.busy = this.pending.size > 0;
    p.resolve(msg);
  }

  solve(
    xsctn: string,
    cseg: number,
    dseg: number,
    onProgress?: (frac: number, phase?: SolveProgressPhase) => void,
  ): Promise<SolveOutput> {
    const id = this.nextId++;
    this.busy = true;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        onProgress,
      });
      this.worker.postMessage({ id, cmd: 'solve', xsctn, cseg, dseg });
    });
  }

  goalSeek(spec: GoalSeekSpec, onIter: (it: GoalSeekIter) => void): Promise<GoalSeekOutcome> {
    const id = this.nextId++;
    this.busy = true;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onIter });
      this.worker.postMessage({ id, cmd: 'goalSeek', spec });
    });
  }

  fieldGrid(
    req: {
      fieldText: string;
      lineIndex: number;
      bbox: { x0: number; y0: number; x1: number; y1: number };
      nx: number;
      ny: number;
      masks: Array<{ x0: number; y0: number; x1: number; y1: number }>;
      maskPolys: Array<Array<[number, number]>>;
      /** Optional override; transformed field text may also carry this metadata. */
      imagePlaneYM?: number;
      calibrationMode?: import('../field/potential.ts').FieldCalibrationMode;
      contourPotentials?: number[];
    },
    onProgress?: (frac: number) => void,
  ): Promise<import('../field/potential.ts').FieldGrid & { lines: string[] }> {
    const id = this.nextId++;
    this.busy = true;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      this.worker.postMessage({ id, cmd: 'fieldGrid', ...req });
    });
  }

  /** hard-cancel everything in flight */
  cancel() {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('cancelled'));
    this.pending.clear();
    this.busy = false;
    this.worker = this.spawn();
  }
}
