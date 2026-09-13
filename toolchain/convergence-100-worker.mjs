import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const source='D:/Dropbox/MENGR Share Folder/TRL-Cal';
const {buildCrossSection,parseMmtlResult}=await import(pathToFileURL(source+'/tools/c21_mmtl_bridge_candidate.mjs'));
const create=(await import('../public/wasm/threaded/bem.mjs')).default;
const req=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const lines=[]; const started=performance.now();
const mod=await create({print:s=>lines.push(s),printErr:s=>lines.push(s)});
try {
 const build=buildCrossSection(req.width,req.config);
 const xsctn=build.xsctn.replace('set CSEG',`set EDGE_SEGMENTS ${req.config.fixedEdgeDivisions.join(' ')}\nset CSEG`);
 mod.FS.mkdir('/work');mod.FS.chdir('/work');mod.FS.writeFile('/work/case.xsctn',xsctn);
 try {mod.callMain(['/work/case',String(req.config.cseg),String(req.config.dseg)]);} catch(e){if(e.name!=='ExitStatus'||e.status!==0)throw e;}
 if(!lines.some(s=>s.includes('MMTL is done')))throw Error(lines.slice(-20).join('\n'));
 const result=parseMmtlResult(mod.FS.readFile('/work/case.result',{encoding:'utf8'}));
 fs.writeFileSync(process.argv[3],JSON.stringify({...result,elapsedMs:performance.now()-started,inputSha256:createHash('sha256').update(xsctn).digest('hex'),solver:lines.filter(s=>/MMTL_LU|MMTL_PARALLEL/.test(s))},null,2));
} finally {mod.PThread?.terminateAllThreads();}
