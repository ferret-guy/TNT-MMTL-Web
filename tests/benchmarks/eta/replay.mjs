import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {ProgressEta} from '../../../src/solver/progressEta.ts';
import fs from 'node:fs';
import {SolveWorkEta as ReplayEta} from '../../../src/solver/workEta.mjs';
const root=pathToFileURL(path.resolve(process.argv[2]||'build/eta-recordings')+path.sep);
const data=JSON.parse(fs.readFileSync(new URL('extracted.json',root)));
// Synthetic clock scaling checks adaptation, not real-device validation.
const timeScale=Number(process.env.ETA_TIME_SCALE||1);
if(!(timeScale>0))throw Error('ETA_TIME_SCALE must be positive');
if(timeScale!==1)for(const d of data){
 d.duration*=timeScale;
 for(const e of d.estimates||[]){e.at*=timeScale;e.remaining*=timeScale;}
 for(const p of d.passes){
  p.start*=timeScale;p.end*=timeScale;p.workerStart*=timeScale;
  for(const x of p.lines)x.ms*=timeScale;
  for(const x of p.progress){x.at*=timeScale;if(x.estimatedSeconds!=null)x.estimatedSeconds*=timeScale;}
 }
}
const all=JSON.parse(fs.readFileSync(new URL('cost-model.json',root)));
const heldout=JSON.parse(fs.readFileSync(new URL('heldout-models.json',root)));
const output=[];
if(process.env.ETA_SETTLING && !(Number(process.env.ETA_SETTLING)>0))throw Error('ETA_SETTLING must be positive.');
for(const d of data){
 const roles=d.roles;
 const queue=d.passes.flatMap((p,i)=>{
   const events=[{at:p.start/1000,kind:'begin',index:i,backend:'serial'}];
   let cursor=1,pending=[];
   for(const x of p.lines){
     pending.push(x);
     const match=x.line.match(/^MMTL_PROGRESS (assembly|factorization) (\d+) (\d+)$/);
     const emitted=match?(+match[3]>0&&+match[2]<=+match[3]):(/calculate rhs/i.test(x.line)||/MMTL is done/.test(x.line));
     if(emitted){
       const delivered=p.progress[cursor++];if(!delivered)throw Error('Missing recorded progress delivery');
       for(const raw of pending)events.push({at:delivered.at/1000,workerAt:(p.workerStart+raw.ms)/1000,kind:'line',line:raw.line,read:raw===x});
       pending=[];
     }
   }
   if(cursor!==p.progress.length)throw Error(`Progress alignment failed ${d.id} pass ${i}`);
   for(const raw of pending)events.push({at:p.end/1000,workerAt:(p.workerStart+raw.ms)/1000,kind:'line',line:raw.line});
   events.push({at:p.end/1000,kind:'end'});return events;
 }).sort((a,b)=>a.at-b.at);

 const weights=roles.map(role=>role==='air'?.05:1),total=weights.reduce((a,b)=>a+b,0);
 const old=new ProgressEta(0,Math.max(1,1.06*(d.mesh/45)**2/(d.isolated&&d.mesh>=128?4:1)),15);
 let seeded=false,progress=0,position=0,estimatePosition=-1;
 const progressEvents=d.passes.flatMap((p,i)=>p.progress.map(e=>({...e,index:i}))).sort((a,b)=>a.at-b.at);
 const samples=[];
 for(let now=0;now<d.duration;now+=.1){
  while(position<progressEvents.length&&progressEvents[position].at<=now*1000){
   const e=progressEvents[position++];
   if(!seeded&&e.index===0&&e.estimatedSeconds!=null){old.seedDuration(e.estimatedSeconds*total);seeded=true;}
   const lower=weights.slice(0,e.index).reduce((a,b)=>a+b,0)/total;
   progress=Math.max(progress,.9999*(lower+weights[e.index]/total*e.frac));old.update(progress,e.at);
  }
  let remaining=old.remainingSeconds(now*1000);
  if(d.estimates?.length){
   while(estimatePosition+1<d.estimates.length&&d.estimates[estimatePosition+1].at<=now)estimatePosition++;
   if(estimatePosition>=0){remaining=d.estimates[estimatePosition].remaining;progress=d.estimates[estimatePosition].progress;}
  }
  samples.push({at:now,remaining,progress,error:now+remaining-d.duration});
 }
 const errors=samples.filter(s=>s.at>=d.duration*.1&&s.at<=d.duration*.9).map(s=>100*Math.abs(s.error)/d.duration).sort((a,b)=>a-b);
 output.push({id:d.id,label:d.label,mesh:d.mesh,mode:'baseline',duration:d.duration,median:errors[Math.floor(errors.length/2)],p90:errors[Math.floor(errors.length*.9)],max:Math.max(...errors),samples});
 for(const mode of ['fit','heldout']) {
  const model=mode==='fit'?all:heldout[d.label];
  if(!model[d.passes[0].backend]&&!model.lu?.[d.passes[0].backend])continue;
  const eta=new ReplayEta(model,roles,Math.max(1,1.06*(d.mesh/45)**2/(d.isolated&&d.mesh>=128?4:1)),process.env.ETA_SETTLING ? Number(process.env.ETA_SETTLING) : undefined);
  let index=0;const samples=[];
  for(let now=0;now<d.duration;now+=.1){
   while(index<queue.length&&queue[index].at<=now){const q=queue[index++];if(q.kind==='begin')eta.begin(q.index,q.at,q.backend);else if(q.kind==='end')eta.finish(q.at);else {eta.feed(q.line,q.workerAt);if(q.read)eta.read(q.at);}}
   const r=eta.read(now);samples.push({at:now,...r,error:now+r.remaining-d.duration});
  }
  const mid=samples.filter(s=>s.at>=d.duration*.1&&s.at<=d.duration*.9);
  const errors=mid.map(s=>Math.abs(s.error)/d.duration*100).sort((a,b)=>a-b);
  const jumps=samples.slice(1).map((s,i)=>s.at>=2?Math.abs(s.remaining+s.at-samples[i].remaining-samples[i].at):0);
  output.push({id:d.id,label:d.label,mesh:d.mesh,mode,duration:d.duration,median:errors[Math.floor(errors.length/2)],p90:errors[Math.floor(errors.length*.9)],max:Math.max(...errors),maxJump:Math.max(...jumps),maxProgressJump:Math.max(...samples.slice(1).map((s,i)=>100*(s.progress-samples[i].progress))),samples});
 }
}
fs.writeFileSync(new URL(process.env.ETA_REPLAY_FILE||'replay-results.json',root),JSON.stringify(output));
console.table(output.filter(x=>x.mode==='heldout').map(({id,label,mesh,median,p90,max,maxJump})=>({id,label,mesh,median:median.toFixed(1),p90:p90.toFixed(1),max:max.toFixed(1),jump:maxJump.toFixed(1)})));
