import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {parseResult} from '../src/solver/parseResult.mjs';
const root=path.resolve('build/assembly-cache');
const ids=(process.argv[2]||'012,013,008,009,010,011,005,006,007').split(',');
const modes=(process.argv[3]||'threaded').split(',');
const rows=[];
for(const mode of modes)for(const id of ids){
 const recording=JSON.parse(fs.readFileSync(`build/eta-recordings/${id}.json`));
 const requests=recording.recording.events.filter(e=>e.type==='request'&&e.data.xsctn).map(e=>e.data);
 for(let pass=0;pass<requests.length;pass++){
  const req=requests[pass];const pairs=[];
  for(const variant of ['baseline','cached']){
   const directory=variant==='baseline'?path.join(root,'baseline/wasm'):path.resolve('public/wasm');
   const modulePath=path.join(directory,mode==='threaded'?'threaded/bem.mjs':'bem.mjs');
   const create=(await import(pathToFileURL(modulePath).href)).default;
   const events=[];const t0=performance.now();
   const mod=await create({print:line=>events.push({ms:performance.now()-t0,line}),printErr:line=>events.push({ms:performance.now()-t0,line})});
   try{
    mod.FS.mkdir('/work');mod.FS.chdir('/work');mod.FS.writeFile('/work/case.xsctn',req.xsctn);
    mod.callMain(['/work/case',String(req.cseg),String(req.dseg)]);
    assert(events.some(e=>e.line.includes('MMTL is done')),'Solver failed');
    const result=parseResult(mod.FS.readFile('/work/case.result',{encoding:'utf8'}));
    const field=mod.FS.readFile('/work/case.result_field_plot_data',{encoding:'utf8'});
    let assembly=0,started=null;
    for(const e of events){if(e.line.startsWith('MMTL_PROGRESS assembly 0 '))started=e.ms;
     if(started!==null&&e.line.startsWith('MMTL_PROGRESS factorization 0 ')){assembly+=e.ms-started;started=null;}}
    pairs.push({variant,totalMs:performance.now()-t0,assemblyMs:assembly,result,field,events});
   }finally{mod.PThread?.terminateAllThreads();}
  }
  assert.deepEqual(pairs[1].result,pairs[0].result,`${id} pass ${pass} result differs`);
  assert.equal(pairs[1].field,pairs[0].field,`${id} pass ${pass} field differs`);
  rows.push({id,label:recording.label,mode,pass,pairs});
  fs.writeFileSync(path.join(root,`comparison-${mode}.json`),JSON.stringify(rows,null,2));
  console.log(id,mode,pass,'assembly ms',...pairs.map(p=>p.assemblyMs.toFixed(1)),'speedup',(pairs[0].assemblyMs/pairs[1].assemblyMs).toFixed(2),'exact match');
 }
}

