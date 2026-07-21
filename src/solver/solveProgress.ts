/** Coarse, honest progress milestones emitted by the native MMTL solver. */
export type SolveProgressPhase =
  | 'initializing'
  | 'meshing'
  | 'free-space-assembly'
  | 'free-space-solves'
  | 'dielectric-assembly'
  | 'dielectric-solves'
  | 'finalizing'
  | 'complete';

export interface SolveProgress {
  fraction: number;
  phase: SolveProgressPhase;
}

/**
 * Translate MMTL's native stage messages into monotonic progress. The two
 * matrix assemblies dominate runtime, so the bar remains striped while each
 * of those indivisible native calls is running rather than inventing timer
 * based progress.
 */
export class SolveProgressTracker {
  private conductorCount = 1;
  private region: 'setup' | 'free-space' | 'dielectric' = 'setup';
  private integratedConductors = 0;
  private lastFraction = 0;
  private lastPhase: SolveProgressPhase | null = null;

  feed(outputLine: string): SolveProgress | null {
    const line = outputLine.trim();
    const signalCount = line.match(/\bnum_sig:\s*(\d+)/i);
    if (signalCount) {
      this.conductorCount = Math.max(1, Number.parseInt(signalCount[1], 10));
      return null;
    }

    if (/\belements\s+and\s+\d+\s+nodes\s+were\s+generated\b/i.test(line)) {
      return this.update(0.04, 'meshing');
    }
    if (/calculate lhs .*free space/i.test(line)) {
      this.region = 'free-space';
      this.integratedConductors = 0;
      return this.update(0.05, 'free-space-assembly');
    }
    if (/calculate lhs .*dielectric/i.test(line)) {
      this.region = 'dielectric';
      this.integratedConductors = 0;
      return this.update(0.50, 'dielectric-assembly');
    }

    const rhs = line.match(/calculate rhs .*conductor\s+(\d+)/i);
    if (rhs && this.region !== 'setup') {
      const conductor = Math.max(
        1,
        Math.min(this.conductorCount, Number.parseInt(rhs[1], 10)),
      );
      if (this.region === 'free-space') {
        return this.update(
          0.45 + 0.03 * ((conductor - 1) / this.conductorCount),
          'free-space-solves',
        );
      }
      return this.update(
        0.95 + 0.02 * ((conductor - 1) / this.conductorCount),
        'dielectric-solves',
      );
    }

    if (/integrate charge density/i.test(line) && this.region !== 'setup') {
      this.integratedConductors = Math.min(
        this.conductorCount,
        this.integratedConductors + 1,
      );
      const completed = this.integratedConductors / this.conductorCount;
      if (this.region === 'free-space') {
        return this.update(0.45 + 0.04 * completed, 'free-space-solves');
      }
      return this.update(
        0.95 + 0.03 * completed,
        this.integratedConductors === this.conductorCount
          ? 'finalizing'
          : 'dielectric-solves',
      );
    }

    if (/mmtl is done/i.test(line)) return this.update(1, 'complete');
    return null;
  }

  private update(
    fraction: number,
    phase: SolveProgressPhase,
  ): SolveProgress | null {
    const monotonicFraction = Math.max(
      this.lastFraction,
      Math.min(1, Math.max(0, fraction)),
    );
    if (
      monotonicFraction === this.lastFraction &&
      phase === this.lastPhase
    ) {
      return null;
    }
    this.lastFraction = monotonicFraction;
    this.lastPhase = phase;
    return { fraction: monotonicFraction, phase };
  }
}
