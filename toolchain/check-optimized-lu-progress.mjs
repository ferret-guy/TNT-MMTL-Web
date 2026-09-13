import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { FineProgressTracker } from '../src/solver/fineProgress.ts';
const data = JSON.parse(readFileSync(new URL('../build/optimized-lu/measurements.json',import.meta.url)));
const rows = data.rows.map(row => {
  const tracker = new FineProgressTracker(true); let previous=0,maxJump=0;
  if (row.mode === 'eigen') tracker.feed('MMTL_LU Eigen-3.4.0 SIMD');
  for (const event of row.events) {
    const p = tracker.feed(event.line);
    if (p) { assert.ok(p.fraction >= previous); maxJump=Math.max(maxJump,p.fraction-previous); previous=p.fraction; }
  }
  assert.equal(previous,1);
  assert.ok(maxJump<0.01, `progress jump ${maxJump}`);

  return {mode:row.mode,seconds:row.elapsedMs/1000,maxProgressJumpPercentagePoints:100*maxJump};
});
writeFileSync(new URL('../build/optimized-lu/progress.json',import.meta.url),JSON.stringify(rows,null,2));
console.log(rows);
