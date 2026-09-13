import test from 'node:test';
import assert from 'node:assert/strict';
import {runGoalSeek,seekParams} from '../../src/analysis/goalSeek.ts';
import {defaultParams,buildPreset} from '../../src/model/presets.ts';
import {generateXsctn} from '../../src/xsctn/generate.ts';
import {parseResult} from '../../src/solver/parseResult.mjs';
import createModule from '../../public/wasm/bem.mjs';
async function solve(req){
 const mod=await createModule({print:()=>{},printErr:()=>{}});
 mod.FS.mkdir('/work');mod.FS.chdir('/work');mod.FS.writeFile('case.xsctn',req.xsctn);
 mod.callMain(['/work/case',String(req.cseg),String(req.dseg)]);
 return {ok:true,result:parseResult(mod.FS.readFile('case.result',{encoding:'utf8'}))};
}
test('only dimensions present in the selected geometry can be tuned',()=>{
 for(const kind of ['microstrip','stripline','cpw'])for(const variant of ['se','diff']){
  const keys=seekParams(kind,variant);
  assert.equal(keys.includes('s'),variant==='diff');
  assert.equal(keys.includes('cpwGap'),kind==='cpw');
  assert.equal(keys.includes('cpwGroundWidth'),kind==='cpw');
  assert.equal(keys.includes('h'),false);
  assert.equal(keys.includes('h2'),false);
 }
});
for(const [kind,variant,key,mode] of [
 ['cpw','se','cpwGap','z0'],['cpw','diff','cpwGap','zdiff'],
 ['cpw','se','cpwGroundWidth','z0'],['cpw','diff','cpwGroundWidth','zeven'],
 ['stripline','diff','s','zeven'],
])test(`${kind} ${variant}: tune ${key} for ${mode} with native solver`,async()=>{
 const params={...defaultParams(kind,variant),cseg:12,dseg:12,cover:null};
 const value=r=>mode==='z0'?r.z0[0]:mode==='zdiff'?2*r.zOdd:r.zEven;
 const expected={...params,[key]:params[key]*1.4};
 const target=value((await solve({xsctn:generateXsctn(buildPreset(kind,variant,expected)),cseg:12,dseg:12})).result);
 const outcome=await runGoalSeek({kind,variant,params,designFreqHz:1e9,seekParam:key,mode,target},solve,()=>{});
 assert.equal(outcome.ok,true,outcome.message);
 assert.ok(Math.abs(outcome.z-target)/target<0.002,`${outcome.z} vs ${target}`);
 assert.ok(outcome.x>0);
 assert.equal(params[key],defaultParams(kind,variant)[key]);
});
test('invalid single-ended pair-gap request never starts a solve',async()=>{
 const params=defaultParams('cpw','se');
 const outcome=await runGoalSeek({kind:'cpw',variant:'se',params,designFreqHz:1e9,seekParam:'s',mode:'z0',target:50},()=>{throw Error('unexpected solve');},()=>{});
 assert.equal(outcome.ok,false);assert.equal(outcome.iterations,0);
});
