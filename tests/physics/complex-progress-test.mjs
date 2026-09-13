import assert from 'node:assert/strict';
import test from 'node:test';
import {FineProgressTracker} from '../../src/solver/fineProgress.ts';
import {ProgressEta} from '../../src/solver/progressEta.ts';

test('ribbon phase estimates track the measured 12010-node solve', () => {
  const tracker=new FineProgressTracker(true);
  tracker.feed('6004 elements and 12010 nodes were generated');
  tracker.feed('MMTL_LU Eigen-3.4.0 SIMD');
  tracker.feed('Calculate LHS (assemble) matrix in free space');
  tracker.feed('MMTL_PARALLEL 4');
  const start=tracker.feed('MMTL_PROGRESS assembly 0 1203');
  assert.ok(Math.abs(start.estimatedSeconds / 193.261 - 1) < .1);
  const freeFactor=tracker.feed('MMTL_PROGRESS factorization 0 2406');
  assert.ok(Math.abs(freeFactor.fraction - 10.938/193.261) < .02);
  tracker.feed('Calculate LHS (assemble) matrix in dielectric');
  tracker.feed('MMTL_PROGRESS assembly 0 6004');
  const dielectricFactor=tracker.feed('MMTL_PROGRESS factorization 0 12010');
  assert.ok(Math.abs(dielectricFactor.fraction - 123.942/193.261) < .03);
  let previous=dielectricFactor.fraction;
  for(let k=1;k<=12010;k++) {
    const p=tracker.feed(`MMTL_PROGRESS factorization ${k} 12010`);
    assert.ok(p.fraction>=previous);
    assert.ok(p.fraction-previous<.01);
    previous=p.fraction;
  }
  assert.equal(tracker.feed('MMTL is done').fraction,1);
});

test('microstrip retains its measured phase proportions and duration', () => {
  const tracker=new FineProgressTracker(true);
  tracker.feed('2390 elements and 4783 nodes were generated');
  tracker.feed('MMTL_LU Eigen-3.4.0 SIMD');
  tracker.feed('Calculate LHS (assemble) matrix in free space');
  tracker.feed('MMTL_PARALLEL 4');
  const p=tracker.feed('MMTL_PROGRESS assembly 0 400');
  assert.ok(Math.abs(p.estimatedSeconds/22.049-1)<.05);
});

test('longer ETA smoothing reduces finish-time reactions to short speed bursts', () => {
  const quick=new ProgressEta(0,100,3), stable=new ProgressEta(0,100,15);
  quick.seedDuration(100);stable.seedDuration(100);
  let fraction=0, quickJump=0, stableJump=0, qEnd=100, sEnd=100;
  for(let t=250;t<=35000;t+=250) {
    fraction+=(t>30000&&t<=32000 ? .01 : .0025);
    quick.update(fraction,t);stable.update(fraction,t);
    const q=t/1000+quick.remainingSeconds(t),s=t/1000+stable.remainingSeconds(t);
    quickJump=Math.max(quickJump,Math.abs(q-qEnd));
    stableJump=Math.max(stableJump,Math.abs(s-sEnd));qEnd=q;sEnd=s;
  }
  assert.ok(stableJump<quickJump/2,`${stableJump} vs ${quickJump}`);
  assert.equal(new ProgressEta(0,100,15).remainingSeconds(0),100);
});

for (const [name, conductors, elements] of [
  ['single trace', 45, 270], ['differential pair', 90, 340],
  ['CPW rails', 135, 440], ['air-only explicit references', 135, 135],
  ['multi-wire ribbon', 495, 2100], ['large arbitrary geometry', 1600, 8000],
]) {
  for (const optimized of [false, true]) {
    test(`${name}: size-based progress with ${optimized ? 'Eigen' : 'LINPACK'}`, () => {
      // Deliberately use the coarse constructor: all topologies must receive
      // mesh-derived estimates even when the requested segment count is low.
      const tracker = new FineProgressTracker(false);
      const nodes = elements * 2;
      tracker.feed(`${elements} elements and ${nodes} nodes were generated`);
      if (optimized) tracker.feed('MMTL_LU Eigen-3.4.0 SIMD');
      tracker.feed('Calculate LHS (assemble) matrix in free space');
      if (optimized && conductors >= 384) tracker.feed('MMTL_PARALLEL 4');
      let previous = 0;
      function feed(line) {
        const p = tracker.feed(line);
        assert.ok(Number.isFinite(p.estimatedSeconds) && p.estimatedSeconds > 0);
        assert.ok(p.fraction >= previous && p.fraction <= 1);
        previous = p.fraction;
        return p;
      }
      for (let i = 0; i <= conductors; i++) feed(`MMTL_PROGRESS assembly ${i} ${conductors}`);
      for (let i = 0; i <= 2*conductors; i++) feed(`MMTL_PROGRESS factorization ${i} ${2*conductors}`);
      feed('calculate rhs');
      if (elements > conductors) {
        tracker.feed('Calculate LHS (assemble) matrix in dielectric');
        if (optimized && elements >= 384) tracker.feed('MMTL_PARALLEL 4');
        for (let i = 0; i <= elements; i++) feed(`MMTL_PROGRESS assembly ${i} ${elements}`);
        for (let i = 0; i <= nodes; i++) feed(`MMTL_PROGRESS factorization ${i} ${nodes}`);
      }
      assert.equal(feed('MMTL is done').fraction, 1);
    });
  }
}
