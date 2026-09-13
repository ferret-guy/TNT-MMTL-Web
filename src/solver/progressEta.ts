/** Time-weighted exponential smoothing of completed work per millisecond.
 * Aggregate native callbacks into >=250 ms samples; a 3 s time constant
 * prevents callback frequency from changing the smoothing strength.
 */
export class ProgressEta {
  private initialDurationSeconds: number;
  private sampledAt: number;
  private sampledFraction = 0;
  private fraction = 0;
  private smoothedWork = 0;
  private smoothedTime = 0;
  constructor(now: number, initialDurationSeconds = 1) {
    this.sampledAt = now;
    this.initialDurationSeconds = Number.isFinite(initialDurationSeconds) && initialDurationSeconds > 0 ? initialDurationSeconds : 1;
  }
  update(fraction: number, now: number): void {
    if (!Number.isFinite(fraction) || !Number.isFinite(now)) return;
    const next = Math.max(this.fraction, Math.min(1, Math.max(0, fraction)));
    this.fraction = next;
    const dt = now - this.sampledAt;
    if (dt < 250) return;
    const alpha = 1 - Math.exp(-dt / 3000);
    this.smoothedWork = alpha * (next - this.sampledFraction) + (1 - alpha) * this.smoothedWork;
    this.smoothedTime = alpha * dt + (1 - alpha) * this.smoothedTime;
    this.sampledFraction = next;
    this.sampledAt = now;
  }
  remainingSeconds(_now: number): number {
    if (this.fraction >= 1) return 0;
    // Show the initial mesh-based guess immediately, then keep the last
    // measured rate visible even when the worker has not reported recently.
    if (!(this.smoothedWork > 0)) return (1 - this.fraction) * this.initialDurationSeconds;
    return (1 - this.fraction) * this.smoothedTime / this.smoothedWork / 1000;
  }
}

export function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return 'Estimating remaining time…';
  const rounded = Math.max(0, Math.ceil(seconds));
  if (rounded < 60) return `${rounded} s left`;
  return `${Math.floor(rounded / 60)} min ${rounded % 60} s left`;
}
