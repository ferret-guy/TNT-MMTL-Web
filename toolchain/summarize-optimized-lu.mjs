import {readFileSync,writeFileSync} from 'node:fs';
import {parseFieldPlot} from '../src/solver/parseFieldPlot.mjs';
import {prepElements,potentialAt} from '../src/field/potential.ts';
const url=p=>new URL('../build/optimized-lu/'+p,import.meta.url);
const data=JSON.parse(readFileSync(url('measurements.json')));
const summary=data.rows.map(row=>{
  const starts={},totals={assembly:0,factorization:0};
  for(const event of row.events){
    const p=event.line.split(' ');
    if(p[0]==='MMTL_PROGRESS' && Object.hasOwn(totals,p[1])){
      if(p[2]==='0') starts[p[1]]=event.ms;
      if(p[2]===p[3]) totals[p[1]]+=(event.ms-starts[p[1]])/1000;
    }
  }
  return {mode:row.mode,seconds:row.elapsedMs/1000,...totals,z0:row.result.z0[0]};
});
const a=parseFieldPlot(readFileSync(url('linpack-0.field'),'utf8'))[0];
const b=parseFieldPlot(readFileSync(url('eigen-1.field'),'utf8'))[0];
const chargeScale=Math.max(...a.elements.flatMap(e=>e.sigma.map(Math.abs)));
let maxCoefficientDifference=0;
for(let e=0;e<a.elements.length;e++)for(let k=0;k<3;k++)maxCoefficientDifference=Math.max(maxCoefficientDifference,Math.abs(a.elements[e].sigma[k]-b.elements[e].sigma[k])/chargeScale);
const prepped=[prepElements(a),prepElements(b)],values=[[],[]];
for(const x of [0.00360,0.00366,0.00372,0.00378])for(const y of [0.00005,0.00011,0.00015])for(let backend=0;backend<2;backend++)values[backend].push(potentialAt(prepped[backend],x,y));
const scale=Math.max(...values[0].map(Math.abs));
const maxPotentialDifference=Math.max(...values[0].map((v,i)=>Math.abs(v-values[1][i])/scale));
const result={summary,maxCoefficientDifference,maxPotentialDifference};
writeFileSync(url('summary.json'),JSON.stringify(result,null,2));console.log(result);
