import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const directory=path.resolve(process.argv[2]||'build/eta-recordings');
const values=(process.argv[3]||'0.1,0.25,0.5,1,2,3').split(',').map(Number);
if(values.some(v=>!Number.isFinite(v)||v<=0))throw Error('Settling times must be positive seconds.');
const started=performance.now(),rows=[];
fs.mkdirSync(path.join(directory,'sweep'),{recursive:true});
for(const settling of values){
 const file=`sweep/${settling}.json`;
 const result=spawnSync(process.execPath,['tests/benchmarks/eta/replay.mjs',directory],{encoding:'utf8',env:{...process.env,ETA_SETTLING:String(settling),ETA_REPLAY_FILE:file}});
 if(result.status!==0)throw Error(result.stderr||result.stdout);
 const heldout=JSON.parse(fs.readFileSync(path.join(directory,file))).filter(x=>x.mode==='heldout');
 const long=heldout.filter(x=>x.duration>60);
 const stripline=long.filter(x=>x.label.includes('stripline')||['About PCB 2','About PCB 4'].includes(x.label));
 const freeform=long.filter(x=>x.label.startsWith('Belden'));
 rows.push({settling,striplineMax:Math.max(0,...stripline.map(x=>x.max)),striplineP90:Math.max(0,...stripline.map(x=>x.p90)),freeformP90:Math.max(0,...freeform.map(x=>x.p90)),meanP90:long.reduce((s,x)=>s+x.p90,0)/Math.max(1,long.length),
  failures:stripline.filter(x=>x.max>10).length+freeform.filter(x=>x.p90>25).length});
}
rows.sort((a,b)=>a.failures-b.failures||a.meanP90-b.meanP90);
const summary={seconds:(performance.now()-started)/1000,selection:'Only solves above 60 seconds: fewest stripline maximum >10% or freeform P90 >25% violations, then lowest mean held-out P90. No geometry-specific algorithm parameters.',selected:rows[0].settling,rows};
fs.writeFileSync(path.join(directory,'sweep-summary.json'),JSON.stringify(summary,null,2));console.table(rows);console.log(`Selected ${summary.selected} s; offline sweep took ${summary.seconds.toFixed(2)} s.`);
