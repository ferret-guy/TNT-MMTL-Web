import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {manifest} from './manifest.mjs';
const root=path.resolve(process.argv[2]||'build/eta-devices');
fs.mkdirSync(root,{recursive:true});
const port=Number(process.env.ETA_PORT||5182);
const ips=Object.values(os.networkInterfaces()).flat().filter(x=>x.family==='IPv4'&&!x.internal).map(x=>x.address);
const connectionPath=path.join(root,'connection.json');
const token=fs.existsSync(connectionPath)?new URL(JSON.parse(fs.readFileSync(connectionPath)).links[0]).searchParams.get('token'):crypto.randomBytes(24).toString('hex');
const bundle=crypto.createHash('sha256');
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);}
for(const f of walk('dist').sort())bundle.update(f).update(fs.readFileSync(f));
const version=bundle.digest('hex');
const staticRoot=path.join(root,'bundles',version);
if(!fs.existsSync(staticRoot))fs.cpSync(path.resolve('dist'),staticRoot,{recursive:true});
const sources=['src/main.ts','src/solver/worker.ts','src/solver/client.ts','src/solver/workEta.mjs','src/solver/measuredWorkCosts.mjs','src/solver/progressEta.ts','src/solver/fineProgress.ts','src/solver/telemetry.ts'];
const sourceContents=Object.fromEntries(sources.map(f=>[f,fs.readFileSync(f)]));
const sourceHashes=Object.fromEntries(sources.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]));
const send=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
async function body(req){let chunks=[],n=0;for await(const chunk of req){n+=chunk.length;if(n>128*1024*1024)throw Error('Upload exceeds 128 MiB');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString());}
const validRun=id=>/^[a-f0-9-]{36}$/.test(id||'')&&fs.existsSync(path.join(root,id,'provenance.json'));
function metrics(data){
 const e=data.recording.events,start=e.find(x=>x.type==='run-start')?.at,end=e.findLast(x=>x.type==='run-end')?.at;
 const seconds=(end-start)/1000;
 const estimates=e.filter(x=>x.type==='estimate').map(x=>({at:(x.at-start)/1000,...x.data}));
 const errors=estimates.filter(x=>x.at>=seconds*.1&&x.at<=seconds*.9&&Number.isFinite(x.remaining)).map(x=>Math.abs(x.at+x.remaining-seconds)/seconds*100).sort((a,b)=>a-b);
 const percentile=q=>errors.length?errors[Math.min(errors.length-1,Math.floor(errors.length*q))]:null;
 return {id:data.id,label:data.label,mesh:data.mesh,success:data.success,seconds,median:percentile(.5),p90:percentile(.9),max:percentile(1),samples:errors.length,isolated:data.crossOriginIsolated,hidden:data.visibilityEvents?.some(x=>x.hidden)||false};
}
const server=http.createServer(async(req,res)=>{
 res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');res.setHeader('Cache-Control','no-store');
 try {
 const url=new URL(req.url,'http://localhost');
 if(url.searchParams.get('token')===token){res.setHeader('Set-Cookie',`eta_access=${token}; HttpOnly; SameSite=Strict; Path=/`);url.searchParams.delete('token');res.writeHead(303,{Location:url.pathname+url.search});res.end();return;}
 if(!req.headers.cookie?.split(';').some(c=>c.trim()===`eta_access=${token}`)){send(res,{error:'Open the connection link printed by the benchmark server.'},403);return;}
 if(req.method==='POST'&&req.headers.origin!==`http://${req.headers.host}`){send(res,{error:'Origin mismatch'},403);return;}
 if(url.pathname==='/__eta-manifest'){send(res,manifest);return;}
 if(url.pathname==='/__eta-session'&&req.method==='POST'){
  const data=await body(req);let id=data.resume;
  if(!validRun(id)||JSON.parse(fs.readFileSync(path.join(root,id,'provenance.json'))).bundle!==version){
   id=crypto.randomUUID();const dir=path.join(root,id);fs.mkdirSync(dir);
   fs.writeFileSync(path.join(dir,'provenance.json'),JSON.stringify({schemaVersion:1,createdAt:new Date().toISOString(),bundle:version,hashes:sourceHashes,manifest,device:data.device},null,2));
   for(const f of sources){const target=path.join(dir,'sources',f);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,sourceContents[f]);}
  }
  send(res,{id,bundle:version});return;
 }
 if(url.pathname==='/__eta-data'){
  const id=url.searchParams.get('run');if(!validRun(id)){send(res,{error:'Unknown run'},400);return;}const dir=path.join(root,id);
  if(req.method==='GET'){send(res,fs.readdirSync(dir).filter(f=>/^\d{3}\.json$/.test(f)).map(f=>f.slice(0,3)));return;}
  if(req.method!=='POST'){send(res,{},405);return;}
  const data=await body(req),c=manifest.cases.find(c=>c.id===data.id);
  if(!c||!Array.isArray(data.recording?.events)||!data.recording.events.some(e=>e.type==='run-end')){send(res,{error:'Incomplete recording'},400);return;}
  Object.assign(data,{label:c.label,mesh:c.mesh});const target=path.join(dir,data.id+'.json');
  if(fs.existsSync(target)){if(fs.readFileSync(target,'utf8')===JSON.stringify(data)){send(res,{saved:true});return;}send(res,{error:'Case already recorded'},409);return;}
  fs.writeFileSync(target,JSON.stringify(data),{flag:'wx'});
  const summary=metrics(data);fs.writeFileSync(path.join(dir,data.id+'-summary.json'),JSON.stringify(summary));
  console.log(id,data.id,summary.seconds.toFixed(2)+'s','ETA P90',summary.p90?.toFixed(2)+'%');send(res,{saved:true,summary});return;
 }
 if(url.pathname==='/__eta-report'){
  const runs=fs.readdirSync(root).filter(validRun).map(id=>({id,...JSON.parse(fs.readFileSync(path.join(root,id,'provenance.json'))),results:fs.readdirSync(path.join(root,id)).filter(f=>/^\d{3}-summary.json$/.test(f)).map(f=>JSON.parse(fs.readFileSync(path.join(root,id,f))))}));send(res,runs);return;
 }
 if(req.method!=='GET'&&req.method!=='HEAD'){send(res,{},405);return;}
 let file=url.pathname==='/'?path.resolve('tests/benchmarks/eta/remote.html'):url.pathname==='/results'?path.resolve('tests/benchmarks/eta/devices.html'):path.resolve(staticRoot,'.'+decodeURIComponent(url.pathname));
 if(!['/','/results'].includes(url.pathname)&&!file.startsWith(staticRoot+path.sep)){send(res,{},403);return;}
 if(!fs.existsSync(file)||!fs.statSync(file).isFile()){send(res,{},404);return;}
 const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.wasm':'application/wasm','.json':'application/json','.svg':'image/svg+xml','.woff2':'font/woff2','.png':'image/png'};
 res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');if(req.method==='HEAD')res.end();else fs.createReadStream(file).pipe(res);
 }catch(e){send(res,{error:String(e)},400);}
});
server.listen(port,'0.0.0.0',()=>{
 const links=['127.0.0.1',...ips].map(ip=>`http://${ip}:${port}/?token=${token}`);
 fs.writeFileSync(path.join(root,'connection.json'),JSON.stringify({links,version},null,2));
 console.log('Device benchmark links:\n'+links.join('\n'));console.log('Keep the benchmark tab visible. Plain HTTP on LAN devices uses the serial WASM backend.');console.log('Reports: /results; recordings:',root);
});
