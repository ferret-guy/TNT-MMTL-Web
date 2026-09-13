/** Tune a geometry dimension by sampling both directions, then bisect a bracket. */
import { buildPreset, type PresetKind, type PresetParams, type PresetVariant } from '../model/presets.ts';
import { generateXsctn } from '../xsctn/generate.ts';

export type SeekParam = 'w' | 's' | 'cpwGap' | 'cpwGroundWidth';
export const SEEK_LABELS: Record<SeekParam, string> = {
  w: 'Trace Width', s: 'Pair Gap', cpwGap: 'Coplanar Gap',
  cpwGroundWidth: 'Side Ground Width',
};
export function seekParams(kind: PresetKind, variant: PresetVariant): SeekParam[] {
  return ['w', ...(variant === 'diff' ? ['s' as const] : []),
    ...(kind === 'cpw' ? ['cpwGap' as const, 'cpwGroundWidth' as const] : [])];
}
export type SeekMode = 'z0' | 'zdiff' | 'zodd' | 'zeven';

export interface GoalSeekSpec {
  kind: PresetKind;
  variant: PresetVariant;
  params: PresetParams;
  designFreqHz: number;
  seekParam: SeekParam;
  mode: SeekMode;
  target: number;
}

export interface GoalSeekIter {
  i: number;
  phase: 'bracket' | 'refine' | 'final';
  x: number;
  z: number | null;
}

export interface GoalSeekOutcome {
  ok: boolean;
  x?: number;
  z?: number;
  iterations: number;
  message: string;
  log: string[];
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

// Report success only within 0.1% of the requested impedance.
const TARGET_REL_TOL = 0.001;
const round4sig = (x: number): number => parseFloat(x.toPrecision(4));

export async function runGoalSeek(
  spec: GoalSeekSpec,
  solve: SolveFn,
  onIter: (it: GoalSeekIter) => void,
): Promise<GoalSeekOutcome> {
  const log: string[] = [];
  const p0 = spec.params;
  let evals = 0;

  const evalAt = async (x: number, phase: GoalSeekIter['phase']): Promise<number | null> => {
    const params: PresetParams = { ...p0 };
    params[spec.seekParam] = x;
    const stackup = buildPreset(spec.kind, spec.variant, params, spec.designFreqHz);
    const out = await solve({
      xsctn: generateXsctn(stackup),
      cseg: stackup.cseg,
      dseg: stackup.dseg,
    });
    evals++;
    const z = out.ok && out.result ? extractZ(spec.mode, out.result) : null;
    log.push(
      `[${phase}] #${evals}  ${spec.seekParam} = ${x.toPrecision(6)}  ->  ${
        z == null ? 'solve failed' : z.toFixed(3) + ' ohm'
      }  (target ${spec.target})`,
    );
    onIter({ i: evals, phase, x, z });
    return z != null && Number.isFinite(z) ? z : null;
  };

  const x0 = p0[spec.seekParam];
  if (!seekParams(spec.kind, spec.variant).includes(spec.seekParam) ||
      !Number.isFinite(x0) || x0 <= 0 || !Number.isFinite(spec.target) || spec.target <= 0) {
    return { ok: false, iterations: 0, message: 'Choose a valid positive dimension and target.', log };
  }
  let xA = x0;
  let zA = await evalAt(xA, 'bracket');
  if (zA === null) return { ok: false, iterations: evals, message: 'initial solve failed', log };
  let xB = xA, zB = zA;
  let crossed = Math.abs(zA - spec.target) / spec.target <= TARGET_REL_TOL;
  const samples = [{ x: x0, z: zA }];
  const active = [true, true];
  // Even-mode coupling and finite side grounds need not follow a fixed slope.
  for (let round = 1; round <= 10 && !crossed; round++) {
    for (const direction of [0, 1]) {
      if (!active[direction]) continue;
      const x = x0 * 2 ** (direction === 0 ? round : -round);
      const z = await evalAt(x, 'bracket');
      if (z === null) { active[direction] = false; continue; }
      samples.push({ x, z });
      if (Math.abs(z - spec.target) / spec.target <= TARGET_REL_TOL) {
        xA = xB = x; zA = zB = z; crossed = true; break;
      }
      samples.sort((a, b) => a.x - b.x);
      for (let i = 1; i < samples.length; i++) {
        const a = samples[i - 1], b = samples[i];
        if ((a.z - spec.target) * (b.z - spec.target) <= 0) {
          xA = a.x; zA = a.z; xB = b.x; zB = b.z; crossed = true; break;
        }
      }
      if (crossed) break;
    }
  }
  if (!crossed) {
    const best = samples.reduce((a, b) => Math.abs(a.z - spec.target) < Math.abs(b.z - spec.target) ? a : b);
    return { ok: false, x: best.x, z: best.z, iterations: evals,
      message: `Target not bracketed within 10 expansion rounds (closest ${best.z.toFixed(2)} Ω).`, log };
  }

  /* ---- phase 2: 10 bisection refinements ---- */
  let lo = Math.min(xA, xB);
  let hi = Math.max(xA, xB);
  let fLo = lo === xA ? zA! - spec.target : zB! - spec.target;
  let best = Math.abs(zA! - spec.target) < Math.abs(zB! - spec.target) ? { x: xA, z: zA! } : { x: xB, z: zB! };
  for (let round = 0; round < 10 && hi > lo; round++) {
    const mid = (lo + hi) / 2;
    const zMid = await evalAt(mid, 'refine');
    if (zMid === null) break;
    if (Math.abs(zMid - spec.target) < Math.abs(best.z - spec.target)) best = { x: mid, z: zMid };
    const fMid = zMid - spec.target;
    if (fLo * fMid <= 0) {
      hi = mid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }

  /* ---- round to 4 significant figures, final answer ---- */
  const xFinal = round4sig(best.x);
  const zFinal = await evalAt(xFinal, 'final');
  if (zFinal === null) return { ok: false, iterations: evals, message: 'Final rounded geometry failed to solve.', log };
  const z = zFinal;
  log.push(`[final] ${spec.seekParam} = ${xFinal} (4 sig figs) -> ${z.toFixed(3)} ohm`);
  return {
    ok: Math.abs(z - spec.target) / spec.target <= TARGET_REL_TOL,
    x: xFinal,
    z,
    iterations: evals,
    message: `${SEEK_LABELS[spec.seekParam]} = ${xFinal} mil → ${z.toFixed(2)} Ω (${evals} solves)${Math.abs(z - spec.target) / spec.target > TARGET_REL_TOL ? "; target tolerance not reached" : ""}`,
    log,
  };
}
