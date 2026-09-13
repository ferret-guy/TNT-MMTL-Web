import { readFileSync, writeFileSync } from 'node:fs';
import { FineProgressTracker, PROGRESS_STAGES } from '../src/solver/fineProgress.ts';
import assert from 'node:assert/strict';
const file = new URL('../build/progress-prototype/measurements.json', import.meta.url);
const data = JSON.parse(readFileSync(file, 'utf8'));
const baseline = data.results[0];
const rows = data.results.filter(r => !r.baseline).map(run => {
  const tracker = new FineProgressTracker();
  let last = 0, lastTime = 0, maxJump = 0, maxGap = 0, maxTimeError = 0;
  const jumps = [], gaps = [], stages = [], advances = [];
  for (const event of run.events) {
    const p = tracker.feed(event.line);
    if (!p) continue;
    if (!stages.some(s => s.stage === p.stage)) stages.push({ stage: p.stage, label: p.label, startMs: event.ms });
    if (p.fraction > last) {
      const jump = 100 * (p.fraction - last), gap = event.ms - lastTime;
      jumps.push(jump); gaps.push(gap);
      maxJump = Math.max(maxJump, jump); maxGap = Math.max(maxGap, gap);
      maxTimeError = Math.max(maxTimeError, 100 * Math.abs(p.fraction - event.ms / run.elapsedMs));
      advances.push({ ms: event.ms, percent: 100 * p.fraction });
      last = p.fraction; lastTime = event.ms;
    }
  }
  const percentile = (v, p) => [...v].sort((a,b) => a-b)[Math.floor((v.length - 1) * p)];
  return { run: run.run, elapsedMs: run.elapsedMs, maxJumpPercent: maxJump,
    maxGapMs: maxGap, p95GapMs: percentile(gaps, .95), medianGapMs: percentile(gaps,.5),
    updates: jumps.length, maxTimeErrorPercent: maxTimeError,
    z0: run.result.z0[0], identicalNumericalResult: JSON.stringify(run.result) === JSON.stringify(baseline.result),
    stages, advances };
});
const result = { hash: data.hash, baselineMs: baseline.elapsedMs, weights: PROGRESS_STAGES, rows };
for (const row of rows) {
  assert.ok(row.maxJumpPercent < 1, `Run ${row.run}: jump exceeds preferred limit`);
  assert.ok(row.identicalNumericalResult, `Run ${row.run}: numerical result changed`);
  assert.equal(row.advances.at(-1).percent, 100);
}
writeFileSync(new URL('../build/progress-prototype/summary.json', import.meta.url), JSON.stringify(result,null,2));
console.log(JSON.stringify({ ...result, rows: rows.map(({ advances, ...r }) => r) },null,2));
