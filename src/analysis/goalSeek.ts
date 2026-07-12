/**
 * Goal seek: tune one preset parameter (trace width w, or diff gap s) until
 * the solved impedance hits a target. Secant iteration with a bisection
 * safeguard on a sign-change bracket (Brent-lite) -- deliberately better than
 * TNT's fixed-increment march (bem/lib/bem_iterate.tcl).
 *
 * Runs inside the solver worker: each evaluation regenerates the .xsctn from
 * the preset and solves in a fresh wasm instance. A coarse-mesh pass finds
 * the neighborhood cheaply; the final iterations run at the user's cseg.
 */
import { buildPreset, type PresetKind, type PresetParams, type PresetVariant } from '../model/presets.ts';
import { generateXsctn } from '../xsctn/generate.ts';

export type SeekParam = 'w' | 's';
export type SeekMode = 'z0' | 'zdiff' | 'zodd' | 'zeven';

export interface GoalSeekSpec {
  kind: PresetKind;
  variant: PresetVariant;
  params: PresetParams;
  seekParam: SeekParam;
  mode: SeekMode;
  target: number;
  tolOhms?: number;
  maxIter?: number;
  coarseCseg?: number;
}

export interface GoalSeekIter {
  i: number;
  x: number;
  z: number | null;
  cseg: number;
}

export interface GoalSeekOutcome {
  ok: boolean;
  x?: number;
  z?: number;
  iterations: number;
  message: string;
}

interface MiniSolveResult {
  z0: number[];
  zOdd?: number;
  zEven?: number;
}

type SolveFn = (req: { xsctn: string; cseg: number; dseg: number }) => Promise<{
  ok: boolean;
  result: MiniSolveResult | null;
  error?: string;
}>;

function extractZ(mode: SeekMode, r: MiniSolveResult): number | null {
  switch (mode) {
    case 'z0':
      return r.z0.length ? r.z0[0] : null;
    case 'zodd':
      return r.zOdd ?? null;
    case 'zeven':
      return r.zEven ?? null;
    case 'zdiff':
      return r.zOdd != null ? 2 * r.zOdd : null;
  }
}

export async function runGoalSeek(
  spec: GoalSeekSpec,
  solve: SolveFn,
  onIter: (it: GoalSeekIter) => void,
): Promise<GoalSeekOutcome> {
  const tol = spec.tolOhms ?? 0.25;
  const maxIter = spec.maxIter ?? 24;
  const coarse = spec.coarseCseg ?? 10;
  const p0 = spec.params;

  // seek bounds in stackup units
  const x0 = spec.seekParam === 'w' ? p0.w : p0.s;
  const lo = spec.seekParam === 'w' ? Math.max(0.05, 0.05 * x0) : Math.max(0.05, 0.05 * x0);
  const hi = spec.seekParam === 'w' ? Math.max(40 * p0.h, 10 * x0) : Math.max(20 * p0.h, 10 * x0);

  let evals = 0;
  const evalAt = async (x: number, cseg: number): Promise<number | null> => {
    const params: PresetParams = { ...p0, cseg, dseg: cseg };
    if (spec.seekParam === 'w') params.w = x;
    else params.s = x;
    const stackup = buildPreset(spec.kind, spec.variant, params);
    const out = await solve({ xsctn: generateXsctn(stackup), cseg, dseg: cseg });
    evals++;
    const z = out.ok && out.result ? extractZ(spec.mode, out.result) : null;
    onIter({ i: evals, x, z, cseg });
    return z != null && Number.isFinite(z) ? z : null;
  };

  // f(x) = Z(x) - target. Z decreases with w; increases with s (zdiff/zodd).
  const f = async (x: number, cseg: number) => {
    const z = await evalAt(x, cseg);
    return z == null ? null : z - spec.target;
  };

  // ---- phase 1: bracket a sign change at coarse mesh ----
  let a = Math.min(Math.max(x0, lo), hi);
  let fa = await f(a, coarse);
  if (fa === null) return { ok: false, iterations: evals, message: 'initial solve failed' };
  if (Math.abs(fa) <= tol) {
    // already close -- refine at full mesh below
  }
  // direction that reduces |f|: dZ/dw < 0, dZ/ds > 0 (for zdiff/zodd)
  const increasesZ = spec.seekParam === 's';
  const wantLarger = increasesZ ? fa < 0 : fa > 0;
  let b = a;
  let fb = fa;
  let step = Math.max(0.25 * a, 0.05);
  for (let k = 0; k < 12 && fa * fb > 0; k++) {
    b = wantLarger ? Math.min(b + step, hi) : Math.max(b - step, lo);
    const v = await f(b, coarse);
    if (v === null) {
      // invalid geometry (e.g. solver NaN) -- shrink the step and retry
      b = wantLarger ? Math.max(b - step / 2, lo) : Math.min(b + step / 2, hi);
      step /= 2;
      continue;
    }
    fb = v;
    step *= 1.6;
    if ((b === lo || b === hi) && fa * fb > 0) {
      return {
        ok: false,
        iterations: evals,
        message: `target ${spec.target} Ω not reachable within ${spec.seekParam} ∈ [${lo.toPrecision(3)}, ${hi.toPrecision(3)}]`,
      };
    }
  }
  if (fa * fb > 0) {
    return { ok: false, iterations: evals, message: 'could not bracket the target' };
  }

  // ---- phase 2: secant + bisection on [a,b], switching to full mesh near tol ----
  let x1 = a;
  let f1 = fa;
  let x2 = b;
  let f2 = fb;
  let best = Math.abs(f1) < Math.abs(f2) ? { x: x1, fz: f1 } : { x: x2, fz: f2 };
  let fineMesh = false;

  while (evals < maxIter) {
    // secant candidate
    let xn = x2 - (f2 * (x2 - x1)) / (f2 - f1 || 1e-30);
    const [blo, bhi] = x1 < x2 ? [x1, x2] : [x2, x1];
    if (!(xn > blo && xn < bhi)) xn = (blo + bhi) / 2; // bisection fallback

    const useFine: boolean = fineMesh || Math.abs(best.fz) < Math.max(4 * tol, 2);
    fineMesh = fineMesh || useFine;
    const cseg = useFine ? spec.params.cseg : coarse;
    const fn = await f(xn, cseg);
    if (fn === null) {
      // treat as failure at that x: bisect away from it
      xn = (blo + bhi) / 2;
      continue;
    }
    if (Math.abs(fn) < Math.abs(best.fz)) best = { x: xn, fz: fn };
    if (Math.abs(fn) <= tol && useFine) {
      return {
        ok: true,
        x: xn,
        z: fn + spec.target,
        iterations: evals,
        message: `converged: ${spec.seekParam} = ${xn.toPrecision(5)} → ${(fn + spec.target).toFixed(2)} Ω in ${evals} solves`,
      };
    }
    // keep the sign-change bracket
    if (f1 * fn < 0) {
      x2 = xn;
      f2 = fn;
    } else {
      x1 = xn;
      f1 = fn;
    }
  }
  return {
    ok: false,
    x: best.x,
    z: best.fz + spec.target,
    iterations: evals,
    message: `did not converge in ${evals} solves (best ${(best.fz + spec.target).toFixed(2)} Ω at ${spec.seekParam} = ${best.x.toPrecision(5)})`,
  };
}
