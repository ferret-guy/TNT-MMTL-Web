import {createServer} from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {manifest} from './manifest.mjs';
const directory=path.resolve(process.argv[2]||'build/eta-recordings');
fs.mkdirSync(directory,{recursive:true});
const sources=['src/main.ts','src/solver/worker.ts','src/solver/client.ts','src/solver/workEta.mjs','src/solver/measuredWorkCosts.mjs','src/solver/progressEta.ts','src/solver/fineProgress.ts','src/solver/telemetry.ts'];
const hashes=Object.fromEntries(sources.filter(fs.existsSync).map(p=>[p,crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')]));
const provenance={schemaVersion:1,createdAt:new Date().toISOString(),node:process.version,hashes,manifest};
const provenancePath=path.join(directory,'provenance.json');
if(fs.existsSync(provenancePath)) {
 const old=JSON.parse(fs.readFileSync(provenancePath));
 if(JSON.stringify(old.hashes)!==JSON.stringify(hashes))throw Error('Sources changed. Use a new output directory to preserve the existing recording.');
} else {
 fs.writeFileSync(provenancePath,JSON.stringify(provenance,null,2));
 for(const source of sources.filter(fs.existsSync)){const target=path.join(directory,'sources',source);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target);}
}
const server=await createServer({server:{host:'127.0.0.1',port:5181,strictPort:true},plugins:[{
 name:'eta-benchmark-recording',configureServer(server){
  server.middlewares.use('/__eta-manifest',(_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(manifest));});
  server.middlewares.use('/__eta-data',(req,res)=>{
   res.setHeader('Content-Type','application/json');
   if(req.method==='GET'){res.end(JSON.stringify(fs.readdirSync(directory).filter(f=>/^\d{3}\.json$/.test(f)).map(f=>f.slice(0,3))));return;}
   if(req.method!=='POST'||(req.headers.origin&&req.headers.origin!=='http://127.0.0.1:5181')){res.statusCode=403;res.end('{}');return;}
   let body='',size=0;
   req.on('data',chunk=>{size+=chunk.length;if(size>128*1024*1024){res.statusCode=413;res.end('{}');req.destroy();return;}body+=chunk;});
   req.on('end',()=>{try{
    const data=JSON.parse(body);
    if(!manifest.cases.some(c=>c.id===data.id)||!Array.isArray(data.recording?.events))throw Error('Invalid recording');
    fs.writeFileSync(path.join(directory,data.id+'.json'),JSON.stringify(data),{flag:'wx'});
    res.end('{"saved":true}');
   }catch(error){res.statusCode=400;res.end(JSON.stringify({error:String(error)}));}});
  });
 }
}]});
await server.listen();
console.log('Record benchmark: http://127.0.0.1:5181/tests/benchmarks/eta/record.html');
console.log('Raw recordings:',directory);
