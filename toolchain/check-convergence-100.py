import pathlib,json,sys,hashlib,subprocess,itertools,time
ROOT=pathlib.Path(__file__).resolve().parents[1]; OUT=ROOT/'build/convergence-100'
M=json.loads((OUT/'manifest.json').read_text()); SRC=pathlib.Path(M['source'])
sys.path.insert(0,str(SRC.parents[1]/'tools'))
import c21_mmtl_table_candidate as model
from c21_mmtl_convergence import recede,memory
assert hashlib.sha256((ROOT/'public/wasm/threaded/bem.wasm').read_bytes()).hexdigest()==M['current_wasm_sha256']
RAW=OUT/'raw';RAW.mkdir(exist_ok=True)
def solve(w,c):
 req=dict(width=w,config=c,wasm=M['current_wasm_sha256']);key=hashlib.sha256(json.dumps(req,sort_keys=True).encode()).hexdigest();dest=RAW/(key+'.json')
 if not dest.exists():
  if memory()['availPage']<4*1024**3:raise RuntimeError('Less than 4 GiB commit headroom')
  inp=RAW/(key+'.request.json');inp.write_text(json.dumps(req))
  run=subprocess.run(['node',str(ROOT/'toolchain/convergence-100-worker.mjs'),str(inp),str(dest)],capture_output=True,text=True,cwd=ROOT)
  if run.returncode:raise RuntimeError(run.stdout+run.stderr)
 return json.loads(dest.read_text())
def compute(b):
 c=b['config'];w=b['width_mm'];step=b['step_um'];es=b['er_step'];v=c|dict(constructionEr=1,maskEr=1)
 base=solve(w,v);ls=[]
 for d in [-step/1000,step/1000]:
  ww,cc=recede(w,v,d,True);ls.append(solve(ww,cc)['inductanceHPerM'])
 field=solve(w,c)
 def part(k):return (solve(w,c|{k:c[k]+es})['capacitanceFPerM']-solve(w,c|{k:c[k]-es})['capacitanceFPerM'])/(2*es)
 return b|dict(C_F_m=field['capacitanceFPerM'],L_external_H_m=base['inductanceHPerM'],dL_dn_H_m2=(ls[1]-ls[0])/(2*step*1e-6),dC_dmask_F_m=part('maskEr'),dC_der_F_m=part('constructionEr'),Rdc_ohm_m=base['resistanceDcOhmPerM'],solver_fingerprint=M['current_wasm_sha256'])
limits=dict(dL_relative=.001,S_rms=1e-4,S_max=3e-4,IL_max_db=.005,phase_max_deg=.05)
group=int(sys.argv[1]) if len(sys.argv)>1 else None
results=[];started=time.time()
for case in M['rows']:
 if group is not None and ((int(case['id'])-1)//5)%4!=group:continue
 dest=OUT/(case['id']+'.json')
 if dest.exists():
  r=json.loads(dest.read_text())
  assert r['current']['solver_fingerprint']==M['current_wasm_sha256'], 'Stale case result: use a fresh output directory for a different solver'
 else:
  print('Starting',case['id'],case['label'],'mesh',case['baseline']['mesh'],flush=True)
  current=compute(case['baseline']);metrics=[]
  for rough,tand,mask,rho in itertools.product([0,4],[0,.03],[0,.05],[1.6e-8,2.2e-8]):
   material=dict(roughness_um=rough,tand=tand,masktand=mask,rho=rho);metrics.append(dict(material=material,metrics=model.compare(current,case['baseline'],**material)))
  r=dict(id=case['id'],label=case['label'],current=current,comparisons=metrics,passed=all(x['metrics']['pass'] for x in metrics));dest.write_text(json.dumps(r,indent=2))
 results.append(r)
 worst={k:max(x['metrics'][k] for r in results for x in r['comparisons']) for k in limits}
 summary=dict(completed=len(results),required=100,passed=sum(r['passed'] for r in results),worst=worst,limits=limits,limit_fractions={k:worst[k]/limits[k] for k in limits},elapsed_seconds=time.time()-started)
 (OUT/('summary.json' if group is None else f'summary-group-{group}.json')).write_text(json.dumps(summary,indent=2));print(json.dumps(summary),flush=True)
print('COMPLETE',flush=True)
