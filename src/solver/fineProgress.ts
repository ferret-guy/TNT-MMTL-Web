// Work-based solve progress. Overall weights are estimates; phase fractions
// count completed elements or factorization work, never elapsed-time animation.
// Actual mesh dimensions drive the model for every geometry and mesh size.
// Legacy profiles are fallbacks when mesh telemetry is unavailable.
// Timing coefficients are empirical estimates, not an ETA guarantee.
export const PROGRESS_STAGES = [
  ['Preparing mesh', 0.0008],
  ['Assembling free-space matrix', 0.049],
  ['Factoring free-space matrix', 0.0497],
  ['Solving free-space currents', 0.0498],
  ['Assembling dielectric matrix', 0.682],
  ['Factoring dielectric matrix', 0.9998],
  ['Solving and writing results', 1],
] as const;

export class FineProgressTracker {
  private readonly refined: boolean;
  constructor(refined = true) { this.refined = refined; }
  private optimizedLu = false;
  private assemblyThreads = 1;
  private dielectric = false;
  private conductorElements = 0;
  private meshElements = 0;
  private meshNodes = 0;
  private fraction = 0;
  feed(line: string) {
    const mesh = line.match(/(\d+) elements and (\d+) nodes were generated/);
    if (mesh) {
      this.meshElements = Number(mesh[1]);
      this.meshNodes = Number(mesh[2]);
      return null;
    }
    if (line.startsWith('MMTL_LU Eigen')) { this.optimizedLu = true; return null; }
    const workers = line.match(/^MMTL_PARALLEL ([1-4])$/);
    if (workers) { this.assemblyThreads = Math.max(this.assemblyThreads, Number(workers[1])); return null; }
    if (/Calculate LHS .*free space/.test(line)) this.dielectric = false;
    if (/Calculate LHS .*dielectric/.test(line)) this.dielectric = true;
    const match = line.match(/^MMTL_PROGRESS (assembly|factorization) (\d+) (\d+)$/);
    let stage: number;
    let completed = 0;
    let total = 1;
    let local = 0;
    if (match) {
      completed = Number(match[2]); total = Number(match[3]);
      if (total <= 0 || completed > total) return null;
      local = completed / total;
      stage = (this.dielectric ? 4 : 1) + (match[1] === 'factorization' ? 1 : 0);
      if (match[1] === 'assembly') {
        if (!this.dielectric) this.conductorElements = total;
        else {
          // Conductor rows invoke a more expensive kernel than dielectric
          // rows. A raw row count noticeably understates the early work.
          const conductors = Math.min(total, this.conductorElements);
          const work = 4.55 * Math.min(completed, conductors) + Math.max(0, completed - conductors);
          local = work / (4.55 * conductors + total - conductors);
        }
      }
      // Remaining LU updates shrink quadratically with each pivot.
      if (match[1] === 'factorization') local = 1 - (1 - local) ** 3;
    } else if (/calculate rhs/i.test(line)) {
      stage = this.dielectric ? 6 : 3;
    } else if (/MMTL is done/.test(line)) {
      stage = 6; local = 1;
    } else return null;
    const ends = this.refined ? PROGRESS_STAGES.map(s => s[1])
      : [0.0008, 0.095, 0.097, 0.098, 0.97, 0.997, 1];
    // Four-worker 400-cell measurements: assembly is about 34% of total
    // time after parallelization. Keep serial and coarse profiles intact.
    if (this.refined && this.assemblyThreads > 1) {
      const parallelEnds = [0.002, 0.025, 0.026, 0.027, 0.34, 0.9998, 1];
      const blend = (this.assemblyThreads - 1) / 3;
      for (let i = 0; i < ends.length; ++i) ends[i] += blend * (parallelEnds[i] - ends[i]);
    }
    if (this.refined && this.optimizedLu) {
      // Eigen SIMD cuts LU to about 4.4 s in the 400-cell reference.
      const optimizedEnds = [0.002, 0.058, 0.060, 0.061, 0.785, 0.9998, 1];
      for (let i = 0; i < ends.length; ++i) ends[i] = optimizedEnds[i];
    }
    let estimatedSeconds: number | undefined;
    if (this.meshElements > 0 && this.conductorElements > 0) {
      // Scale actual work, rather than assigning every geometry the phase
      // shares of one microstrip. Assembly is quadratic; dense LU is cubic.
      const c = this.conductorElements;
      const n = this.meshElements;
      const hasDielectric = n > c;
      const assemblyScale = 4 / this.assemblyThreads;
      const luScale = this.optimizedLu ? 1 : 27.4 / 4.4;
      const costs = [0.06,
        1.25 * (c / 400) ** 2 * assemblyScale,
        0.035 * (c / 400) ** 3 * luScale,
        0.01 * (c / 400) ** 2,
        hasDielectric ? 16.27 * (n / 2390) *
          ((3.55 * c + n) / (3.55 * 400 + 2390)) * assemblyScale : 0,
        hasDielectric ? 4.38 * (this.meshNodes / 4783) ** 3 * luScale : 0,
        0.1 * Math.max(1, this.meshNodes / 4783)];
      const sum = costs.reduce((a, b) => a + b, 0);
      estimatedSeconds = sum;
      let accumulated = 0;
      for (let i = 0; i < ends.length; i++) ends[i] = (accumulated += costs[i]) / sum;
    }
    const lower = stage > 0 ? ends[stage - 1] : 0;
    const upper = ends[stage];
    this.fraction = stage === 6 && local === 1 ? 1
      : Math.min(1, Math.max(this.fraction, lower + (upper - lower) * local));
    return { estimatedSeconds, fraction: this.fraction, phaseFraction: local, stage,
      label: PROGRESS_STAGES[stage][0], completed, total };
  }
}
