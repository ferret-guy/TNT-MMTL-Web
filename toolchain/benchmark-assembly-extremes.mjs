import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {buildPreset,defaultParams} from '../src/model/presets.ts';
import {generateXsctn} from '../src/xsctn/generate.ts';
import {parseResult} from '../src/solver/parseResult.mjs';
import {parseFieldPlot} from '../src/solver/parseFieldPlot.mjs';
const root=path.resolve('build/assembly-v2');
const cases=[];
const backend=process.argv.includes('--serial')?'serial':'threaded';
const outputRoot=backend==='serial'?path.join(root,'serial'):root;fs.mkdirSync(outputRoot,{recursive:true});
const scenarios={default:{},narrow:{w:0.6,t:0.1,etch:0.02,h:20,h2:20,s:0.2,cpwGap:0.2,er:2,er2:2,cover:null},wide:{w:80,t:0.7,etch:0.1,h:2,h2:2,s:80,cpwGap:40,er:12,er2:12,cover:null},tight:{w:5,t:2,etch:0.2,h:4,h2:4,s:0.25,cpwGap:0.25,er:10,er2:10,cover:null},asymmetric:{w:3,t:0.3,etch:0.05,h:2,h2:40,s:40,er:2,er2:10,striplineSeparateMaterials:true,cover:null},air:{er:1,er2:1,cover:null}};
for(const kind of ['microstrip','stripline','cpw'])for(const variant of ['se','diff'])for(const [scenario,settings] of Object.entries(scenarios)){
 const params={...defaultParams(kind,variant),...settings,laminateId:null,laminateId2:null};
 for(const segments of (['narrow','wide','tight'].includes(scenario)?[45,90]:[45])){
 const stack=buildPreset(kind,variant,{...params,cseg:segments,dseg:segments});
 cases.push({id:`${kind}-${variant}-${scenario}-${segments}`,kind,variant,scenario,segments,xsctn:generateXsctn(stack)});
 }
}
for(const id of ['005','006','007']){
 const r=JSON.parse(fs.readFileSync(`build/eta-recordings/${id}.json`));
 r.recording.events.filter(e=>e.type==='request'&&e.data.xsctn).forEach((e,i)=>cases.push({id:`example-${id}-${i}`,segments:45,xsctn:e.data.xsctn}));
}
function compare(a,b){
 let max=0;
 function walk(x,y,key=''){
 if(['warnings','fxt','bxt'].includes(key))return;
 if(typeof x==='number'){assert(Number.isFinite(x)&&Number.isFinite(y));max=Math.max(max,Math.abs(x-y)/Math.max(Math.abs(x),Math.abs(y),1e-30));}
 else if(Array.isArray(x)) {assert.equal(x.length,y.length);x.forEach((v,i)=>walk(v,y[i]));}
 else if(x&&typeof x==='object')for(const k of Object.keys(x))walk(x[k],y[k],k);
 }
 walk(a,b);return max;
}
function fieldDifference(a,b){
 assert.equal(a.length,b.length);let worst=0;
 a.forEach((sol,i)=>{
 assert.equal(sol.elements.length,b[i].elements.length);
 for(const type of ['conductor','dielectric']){
 const x=sol.elements.filter(e=>e.type===type).flatMap(e=>e.sigma);
 const y=b[i].elements.filter(e=>e.type===type).flatMap(e=>e.sigma);
 let scale=0,delta=0;
 x.forEach((v,k)=>{assert(Number.isFinite(v)&&Number.isFinite(y[k]));scale=Math.max(scale,Math.abs(v),Math.abs(y[k]));delta=Math.max(delta,Math.abs(v-y[k]));});
 worst=Math.max(worst,delta/(scale||1));
 }
 });return worst;
}
function crossTalkDifference(a,b){let worst=0;for(const key of ['fxt','bxt'])(a[key]||[]).forEach((v,i)=>{assert(Number.isFinite(v.value)&&Number.isFinite(b[key][i].value));worst=Math.max(worst,Math.abs(v.value-b[key][i].value));});return worst;}
async function solve(c,version){
 const dir=version==='baseline'?path.join(root,'baseline/wasm'):path.resolve('public/wasm');
 const create=(await import(pathToFileURL(path.join(dir,backend==='serial'?'bem.mjs':'threaded/bem.mjs')).href)).default;
 const events=[];const start=performance.now();
 const mod=await create({print:line=>events.push({ms:performance.now()-start,line}),printErr:line=>events.push({ms:performance.now()-start,line})});
 try{
 mod.FS.mkdir('/work');mod.FS.chdir('/work');mod.FS.writeFile('case.xsctn',c.xsctn);mod.callMain(['/work/case',String(c.segments),String(c.segments)]);
 assert(events.some(e=>e.line.includes('MMTL is done')),'Solver failed');
 return {ms:performance.now()-start,result:parseResult(mod.FS.readFile('case.result',{encoding:'utf8'})),fields:parseFieldPlot(mod.FS.readFile('case.result_field_plot_data',{encoding:'utf8'})),events};
 }finally{mod.PThread?.terminateAllThreads();}
}
const rows=(process.argv.includes("--resume")||process.argv.includes("--replay-only")) ? JSON.parse(fs.readFileSync(path.join(outputRoot,"extreme-results.json"))).filter(r=>!r.failure) : [];
for(const r of rows){r.error=compare(r.baseline.result,r.candidate.result);r.fieldError=fieldDifference(r.baseline.fields,r.candidate.fields);r.crossTalkAbsoluteError=crossTalkDifference(r.baseline.result,r.candidate.result);r.pass=r.error<1e-7&&r.fieldError<1e-5&&r.crossTalkAbsoluteError<1e-8;}
for(const c of cases){
 if(process.argv.includes("--smoke")&&!(c.scenario==="default"||c.scenario==="air"))continue;
 if(rows.some(r=>r.id===c.id))continue;
 if(process.argv.includes("--replay-only"))throw new Error(`Missing recorded case ${c.id}; replay never runs the solver`);
 let baseline,candidate;
 try{
 baseline=await solve(c,'baseline');candidate=await solve(c,'candidate');
 const error=compare(baseline.result,candidate.result),fieldError=fieldDifference(baseline.fields,candidate.fields),crossTalkAbsoluteError=crossTalkDifference(baseline.result,candidate.result);
 rows.push({...c,baseline,candidate,error,fieldError,crossTalkAbsoluteError,pass:error<1e-7&&fieldError<1e-5&&crossTalkAbsoluteError<1e-8});
 console.log(c.id,`ms ${baseline.ms.toFixed(0)} -> ${candidate.ms.toFixed(0)}, result ${error}, field ${fieldError}`);
 }catch(e){rows.push({...c,baseline,candidate,failure:String(e)});console.log(c.id,String(e));}
 fs.writeFileSync(path.join(outputRoot,'extreme-results.json'),JSON.stringify(rows));
}
const valid=rows.filter(r=>!r.failure);
const convergence=valid.filter(r=>r.segments===90).map(r=>{const low=valid.find(x=>x.id===r.id.replace(/90$/,'45'));return {id:r.id,meshRelativeChange:compare(low.baseline.result,r.baseline.result),optimizationRelativeChange:r.error};});
const summary={cases:rows.length,valid:valid.length,failures:rows.filter(r=>!r.pass).map(r=>({id:r.id,failure:r.failure,error:r.error,fieldError:r.fieldError})),maxCrossTalkAbsoluteError:Math.max(...valid.map(r=>r.crossTalkAbsoluteError)),maxResultError:Math.max(...valid.map(r=>r.error)),maxFieldError:Math.max(...valid.map(r=>r.fieldError)),totalBaselineMs:valid.reduce((s,r)=>s+r.baseline.ms,0),totalCandidateMs:valid.reduce((s,r)=>s+r.candidate.ms,0),reuseCases:valid.filter(r=>r.candidate.events.some(e=>e.line.startsWith('MMTL_REUSE '))).length,convergence};
fs.writeFileSync(path.join(outputRoot,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));
