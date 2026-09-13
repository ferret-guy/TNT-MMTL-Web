import fs from 'node:fs';
import {defaultParams} from '../../../src/model/presets.ts';
globalThis.window={location:{hash:''}};globalThis.localStorage={getItem:()=>null,setItem:()=>{}};
const {defaultState,encodeConfig,decodeHash}=await import('../../../src/model/store.ts');
const {FREEFORM_EXAMPLES}=await import('../../../src/model/freeformExamples.ts');
const html=fs.readFileSync('about.html','utf8');
const examples=[];
for(const match of html.matchAll(/href="(\.\/#v=3[^\"]+)"/g)){
 const hash=match[1].slice(2).replaceAll('&amp;','&');const decoded=decodeHash(hash),s=defaultState();
 examples.push({label:`About PCB ${examples.length+1}`,state:{...s,...decoded,presetParams:{...s.presetParams,...decoded.presetParams}}});
}
for(const e of FREEFORM_EXAMPLES)examples.push({label:e.title,state:structuredClone(e.state)});
for(const kind of ['microstrip','stripline','cpw'])for(const variant of ['se','diff']){
 const s=defaultState();s.presetKind=kind;s.presetVariant=variant;s.presetParams=defaultParams(kind,variant);
 examples.push({label:`Guided ${kind} ${variant}`,state:s});
}
const cases=[];
function add(e,mesh){const s=structuredClone(e.state);s.presetParams.cseg=mesh;s.presetParams.dseg=mesh;s.freeform.cseg=mesh;s.freeform.dseg=mesh;
 cases.push({id:String(cases.length+1).padStart(3,'0'),label:e.label,mesh,url:'http://127.0.0.1:5179/?eta-measure='+cases.length+'#'+encodeConfig(s)});}
for(const mesh of [45,200])for(const e of examples)add(e,mesh);
add(examples.find(e=>e.label==='Guided microstrip se'),400);
add(examples.find(e=>e.label.includes('G-S-G')),400);
export const manifest={cases};

delete globalThis.window;
delete globalThis.localStorage;
