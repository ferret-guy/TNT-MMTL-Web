import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {SolveWorkEta} from '../../../src/solver/workEta.mjs';
import {measuredWorkCosts} from '../../../src/solver/measuredWorkCosts.mjs';
const directory=path.resolve(process.argv[2]||'build/eta-smoke');const rows=[];
for(const file of fs.readdirSync(directory).filter(f=>/^\d{3}\.json$/.test(f))){
 const d=JSON.parse(fs.readFileSync(path.join(directory,file)));const events=d.recording.events;
 const start=events.find(e=>e.type==='run-start');const mesh=Math.max(start.data.stackup.cseg,start.data.stackup.dseg);
 const eta=new SolveWorkEta(measuredWorkCosts,[],Math.max(1,1.06*(mesh/45)**2/(d.crossOriginIsolated&&mesh>=128?4:1)));
 let index=0,maximum=0,maxProgress=0,count=0;
 for(const e of events){
  const at=(e.at-start.at)/1000,m=e.data;
  if(e.type==='plan')eta.roles=m.jobs.map(j=>j.role);
  if(e.type==='request')eta.begin(index++,at,d.crossOriginIsolated&&Math.max(m.cseg,m.dseg)>=128?'eigen':'serial');
  if(e.type==='message'&&m.evt==='progress'&&m.work){eta.apply(m.work);eta.read(at);}
  if(e.type==='message'&&m.telemetry)eta.finish(at);
  if(e.type==='estimate'){
   const r=eta.read(m.elapsed);maximum=Math.max(maximum,Math.abs(r.remaining-m.remaining));maxProgress=Math.max(maxProgress,Math.abs(r.progress-m.progress));count++;
  }
 }
 assert.ok(count>0,`${file}: no unrounded live estimates`);
 assert.ok(maximum<.05,`${file}: ETA replay/live divergence ${maximum} seconds`);
 assert.ok(maxProgress<.001,`${file}: progress replay/live divergence ${maxProgress}`);
 rows.push({file,samples:count,maxEtaDifferenceSeconds:maximum,maxProgressDifference:maxProgress});
}
fs.writeFileSync(path.join(directory,'conformance.json'),JSON.stringify(rows,null,2));console.table(rows);
