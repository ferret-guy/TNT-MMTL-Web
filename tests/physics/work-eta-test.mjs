import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkTracker,SolveWorkEta as ReplayEta,costs} from '../../src/solver/workEta.mjs';
const coefficients={assembly:[10],dielectric:[40,10],lu:[.001,0],solve:[0,.01],setup:[.01,.01]};
const model={serial:coefficients,eigen:coefficients,post:.02};
function uniform(eta) {
 eta.begin(0,0,'serial');
 eta.feed('1000 elements and 2000 nodes were generated',.01);
 eta.feed('Calculate LHS (assemble) matrix in free space',.02);
 eta.feed('MMTL_PARALLEL 1',.02);
 eta.feed('MMTL_PROGRESS assembly 0 1000',.02);
 eta.feed('MMTL_PROGRESS assembly 500 1000',5.02);
}
test('uniform dielectric and later air pass both retain their matrix work',()=>{
 const eta=new ReplayEta(model,['dielectric','air']);uniform(eta);
 const r=eta.read(5.02);assert.ok(r.remaining>30&&r.remaining<40);assert.ok(r.progress<.2);
});
test('a timer alone cannot advance work progress',()=>{
 const eta=new ReplayEta(model,['dielectric','air']);uniform(eta);
 const a=eta.read(5.02),b=eta.read(5.12);assert.equal(a.progress,b.progress);assert.ok(b.remaining<=a.remaining);
});
test('uniform dielectric progress does not depend on fitted interface coefficients',()=>{
 const eta=new ReplayEta({...model,serial:{...coefficients,dielectric:[0,10]}},['dielectric']);uniform(eta);
 eta.feed('MMTL_PROGRESS factorization 2000 2000',10.02);
 eta.feed('calculate RHS (load) matrix for conductor 1',10.03);
 eta.feed('Calculate LHS (assemble) matrix in dielectric',10.04);
 eta.feed('MMTL_PROGRESS assembly 500 1000',15.04);
 assert.equal(eta.fraction(eta.tracker),.5);assert.ok(Number.isFinite(eta.read(15.04).remaining));
});
test('auxiliary LU does not replace the main matrix dimension',()=>{
 const t=new WorkTracker();t.feed('Calculate LHS (assemble) matrix in free space',0);t.feed('MMTL_PROGRESS assembly 0 1000',0);t.feed('MMTL_PROGRESS factorization 2000 2000',1);t.feed('calculate RHS (load) matrix for conductor 1',2);t.feed('MMTL_PROGRESS factorization 3 3',3);assert.equal(t.freeNodes,2000);assert.equal(t.stage,3);
});
test('thread capacity and per-phase native threshold are respected',()=>{
 const shape={backend:'eigen',c:200,n:1200,nodes:2400,signals:1,maxThreads:4};
 const capped=costs({...shape,maxThreads:1},model);const parallel=costs(shape,model);
 assert.equal(capped[1],parallel[1]);assert.equal(capped[4],4*parallel[4]);
});
test('raw worker feed and transported snapshot have identical estimates',()=>{
 const a=new ReplayEta(model,['dielectric','air']);uniform(a);
 const b=new ReplayEta(model,['dielectric','air']);b.begin(0,0,'serial');b.apply(structuredClone(a.tracker));
 assert.deepEqual(a.read(5.02),b.read(5.02));
});

test('entering the air pass cannot temporarily borrow the large dielectric mesh',()=>{
 const eta=new ReplayEta(model,['dielectric','air']);eta.begin(0,0,'serial');
 eta.feed('5000 elements and 10000 nodes were generated',.01);
 eta.feed('Calculate LHS (assemble) matrix in free space',.02);
 eta.feed('MMTL_PROGRESS assembly 0 100',.02);
 eta.begin(1,10,'serial');assert.ok(eta.read(10).remaining<1);
});

test('explicit operator reuse removes only repeated assembly and LU costs',()=>{
 const t=new WorkTracker('eigen');
 t.feed('MMTL_REUSE_ELIGIBLE 1',0);
 t.c=1000;t.n=1000;t.nodes=2000;
 const reused=costs(t,model);
 assert.equal(reused[4],0);assert.equal(reused[5],0);
 assert.ok(reused[1]>0&&reused[2]>0&&reused[6]>0);
 assert.equal(t.shape().reuseMatrix,true);
 t.feed('MMTL_REUSE_ELIGIBLE 0',1);
 assert.ok(costs(t,model)[4]>0&&costs(t,model)[5]>0);
});
