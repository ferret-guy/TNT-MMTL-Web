/**
 * Goal seek: tune trace width w (or diff gap s) to a target impedance.
 *
 * Algorithm (per spec):
 *   Phase 1 -- bracket: starting from the current value, jump DOWN or UP by
 *   a factor of 2 (halve/double, in the direction that moves Z toward the
 *   target) for up to 10 rounds until the target is crossed.
 *   Phase 2 -- refine: 10 rounds of bisection inside the bracket.
 *   Then round the variable to 4 significant figures, solve once at the
 *   rounded value, and return that answer.
 *
 * Every evaluation is appended to a detailed log (surfaced in the Log tab);
 * the goal-seek box itself only shows the final answer.
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
    if (spec.seekParam === 'w') params.w = x;
    else params.s = x;
    const stackup = buildPreset(spec.kind, spec.variant, params);
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

  // direction of dZ/dx: Z falls as w grows; Z (odd/diff/even) rises as s grows
  const zRisesWithX = spec.seekParam === 's';

  const x0 = spec.seekParam === 'w' ? p0.w : p0.s;
  let xA = x0;
  let zA = await evalAt(xA, 'bracket');
  if (zA === null) {
    return { ok: false, iterations: evals, message: 'initial solve failed', log };
  }

  /* ---- phase 1: halve/double toward the target, max 10 rounds ---- */
  let xB = xA;
  let zB = zA;
  let crossed = Math.sign(zA - spec.target) === 0;
  for (let round = 0; round < 10 && !crossed; round++) {
    const needHigherZ = zB < spec.target;
    const goUp = needHigherZ === zRisesWithX; // grow x if that raises Z toward target
    const xNext = goUp ? xB * 2 : xB / 2;
    const zNext = await evalAt(xNext, 'bracket');
    if (zNext === null) {
      // solver failed there (geometry too extreme) -- stop expanding
      log.push(`[bracket] stop: solver failed at ${spec.seekParam} = ${xNext.toPrecision(6)}`);
      break;
    }
    xA = xB;
    zA = zB;
    xB = xNext;
    zB = zNext;
    crossed = (zA - spec.target) * (zB - spec.target) <= 0;
  }
  if (!crossed) {
    const best = Math.abs(zB - spec.target) < Math.abs(zA - spec.target) ? { x: xB, z: zB } : { x: xA, z: zA };
    return {
      ok: false,
      x: best.x,
      z: best.z,
      iterations: evals,
      message: `target not crossed within 10 doubling/halving rounds (closest ${best.z.toFixed(2)} Ω at ${spec.seekParam} = ${best.x.toPrecision(5)})`,
      log,
    };
  }

  /* ---- phase 2: 10 bisection refinements ---- */
  let lo = Math.min(xA, xB);
  let hi = Math.max(xA, xB);
  let fLo = lo === xA ? zA! - spec.target : zB! - spec.target;
  let best = Math.abs(zA! - spec.target) < Math.abs(zB! - spec.target) ? { x: xA, z: zA! } : { x: xB, z: zB! };
  for (let round = 0; round < 10; round++) {
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
  const z = zFinal ?? best.z;
  log.push(`[final] ${spec.seekParam} = ${xFinal} (4 sig figs) -> ${z.toFixed(3)} ohm`);
  return {
    ok: true,
    x: xFinal,
    z,
    iterations: evals,
    message: `${spec.seekParam} = ${xFinal} → ${z.toFixed(2)} Ω (${evals} solves)`,
    log,
  };
}
