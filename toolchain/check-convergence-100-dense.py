"""Check completed 100-case solver differences on the source's dense frequency grid."""
import pathlib,json,sys,itertools
import numpy as np
ROOT=pathlib.Path(__file__).resolve().parents[1];OUT=ROOT/'build/convergence-100';M=json.loads((OUT/'manifest.json').read_text())
sys.path.insert(0,str(pathlib.Path(M['source']).parents[1]/'tools'))
import c21_mmtl_table_candidate as model
model.F=np.linspace(130e6,20e9,16001)
limits=dict(dL_relative=.001,S_rms=1e-4,S_max=3e-4,IL_max_db=.005,phase_max_deg=.05)
worst={k:0 for k in limits};passed=0
for case in M['rows']:
 r=json.loads((OUT/(case['id']+'.json')).read_text());ok=True
 for rough,tand,mask,rho in itertools.product([0,4],[0,.03],[0,.05],[1.6e-8,2.2e-8]):
  q=model.compare(r['current'],case['baseline'],roughness_um=rough,tand=tand,masktand=mask,rho=rho)
  ok &= q['pass']
  for k in worst:worst[k]=max(worst[k],q[k])
 passed+=int(ok)
result=dict(current_wasm_sha256=M['current_wasm_sha256'],source_wasm_sha256=M['source_wasm_sha256'],cases=100,passed=passed,frequencies=16001,loss_scenarios=16,worst=worst,limits=limits)
(OUT/'dense-frequency-check.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
