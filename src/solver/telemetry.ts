/** Opt-in, local benchmark recording. No network transmission. */
export const recordingEnabled = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('eta-record');
export const recording = { schemaVersion: 1, timeOrigin: typeof performance !== 'undefined' ? performance.timeOrigin : 0, events: [] as Array<{at: number; type: string; data: unknown}> };
export function recordTelemetry(type: string, data: unknown): void {
  if (recordingEnabled) recording.events.push({at: performance.now(), type, data});
}
if (recordingEnabled) Object.assign(window, {__etaRecording: recording});
