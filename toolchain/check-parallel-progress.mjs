import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { FineProgressTracker } from '../src/solver/fineProgress.ts';
const data = JSON.parse(readFileSync(new URL('../build/parallel-assembly/measurements.json',import.meta.url)));
const rows = data.rows.map(row => {
  const tracker = new FineProgressTracker(true); let previous=0,maxJump=0;
  for (const event of row.events) {
    const p = tracker.feed(event.line);
    if (p) { assert.ok(p.fraction >= previous); maxJump=Math.max(maxJump,p.fraction-previous); previous=p.fraction; }
  }
  assert.equal(previous,1);
  assert.ok(maxJump<0.01, `progress jump ${maxJump}`);
  assert.deepEqual(row.result,data.rows[0].result);
  return {mode:row.mode,seconds:row.elapsedMs/1000,maxProgressJumpPercentagePoints:100*maxJump};
});
writeFileSync(new URL('../build/parallel-assembly/progress.json',import.meta.url),JSON.stringify(rows,null,2));
console.log(rows);
