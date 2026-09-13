"""Summarize current/reference agreement and independently repeat mesh/step gates."""
import pathlib,json,sys,itertools,hashlib,math
ROOT=pathlib.Path(__file__).resolve().parents[1];OUT=ROOT/'build/convergence-100';M=json.loads((OUT/'manifest.json').read_text())
sys.path.insert(0,str(pathlib.Path(M['source']).parents[1]/'tools'))
import c21_mmtl_table_candidate as model
limits=dict(dL_relative=.001,S_rms=1e-4,S_max=3e-4,IL_max_db=.005,phase_max_deg=.05)
materials=[dict(roughness_um=r,tand=t,masktand=m,rho=p) for r,t,m,p in itertools.product([0,4],[0,.03],[0,.05],[1.6e-8,2.2e-8])]
rows=[json.loads(f.read_text()) for f in sorted(OUT.glob('[0-9][0-9][0-9].json'))]
coefficients=['C_F_m','L_external_H_m','dL_dn_H_m2','dC_der_F_m','dC_dmask_F_m','Rdc_ohm_m']
assert all(math.isfinite(r['current'][k]) and r['current'][k]>0 for r in rows for k in coefficients), 'Nonpositive or nonfinite coefficient'
worst={k:max((x['metrics'][k] for r in rows for x in r['comparisons']),default=0) for k in limits}
checks=[]
byid={r['id']:r for r in rows}
for offset in range(0,95,5):
 ids=[f'{offset+i:03}' for i in range(1,6)]
 if not all(i in byid for i in ids):continue
 a,b,c,d,e=[byid[i]['current'] for i in ids] # 200,280,400 step.2,400 step.1,400 step.05
 for label,x,y in [('mesh 200 to 280',a,b),('mesh 280 to 400',b,d),('step 0.2 to 0.1 um',c,d),('step 0.1 to 0.05 um',d,e)]:
  metrics=[model.compare(x,y,**m) for m in materials]
  checks.append(dict(point=byid[ids[0]]['label'],check=label,passed=all(q['pass'] for q in metrics),worst={k:max(q[k] for q in metrics) for k in limits}))
coefficient_relative={k:max((abs(r['current'][k]/M['rows'][int(r['id'])-1]['baseline'][k]-1) for r in rows),default=0) for k in coefficients}
summary=dict(coefficient_relative=coefficient_relative,completed=len(rows),required=100,passed=sum(r['passed'] for r in rows),worst=worst,limits=limits,limit_fractions={k:worst[k]/limits[k] for k in limits},convergence_checks=checks,convergence_passed=sum(c['passed'] for c in checks),convergence_required=76,source_wasm_sha256=M['source_wasm_sha256'],current_wasm_sha256=M['current_wasm_sha256'])
material_checks=[]
if all(i in byid for i in ['096','097','098']):
 for i,j in [('096','097'),('097','098')]:
  x,y=byid[i]['current'],byid[j]['current']
  assert x['config']['constructionEr']==y['config']['constructionEr']==6.8
  metrics=[model.compare(x,y,**m) for m in materials]
  material_checks.append(dict(meshes=[x['mesh'],y['mesh']],passed=all(q['pass'] for q in metrics),worst={k:max(q[k] for q in metrics) for k in limits}))
summary['material_convergence_checks']=material_checks
(OUT/'summary.json').write_text(json.dumps(summary,indent=2))
text=['# Solver regression and convergence comparison','',M['scope'],'',f"Completed **{len(rows)}/100** coefficient cases; **{summary['passed']} pass** all 16 loss scenarios.",'','| Metric | Worst current/reference difference | Acceptance limit | Fraction of limit |','|---|---:|---:|---:|']
for k in limits:text.append(f'| {k} | {worst[k]:.9g} | {limits[k]:.9g} | {worst[k]/limits[k]:.6g} |')
text+=['',f"Repeated mesh/normal-step convergence: **{summary['convergence_passed']}/{len(checks)}** completed comparisons pass; **76** required.",'','Baseline: frozen q24 double-precision LINPACK recipe, compared at identical geometry, fixed conductor edge counts, domain, mesh, normal recession and dielectric perturbations. Current: four-worker assembly and Eigen SIMD LU. Baseline coefficient records are replayed from the source task, not regenerated truth.','', 'Each coefficient case uses vacuum inductance, central normal recession, dielectric capacitance, and substrate/mask capacitance derivatives. Identical raw solve requests are cached. Loss scenarios use a 100 mm line, 50 ohm ports, 1001 frequencies from 130 MHz to 20 GHz, and the original roughness, loss-tangent and resistivity corners.','', 'The explicit edge-count control is translated from the old case.mesh sidecar to the current EDGE_SEGMENTS input directive. Geometry generation and loss/S-parameter scoring use the original source tools.','', 'These are empirical numerical comparisons on sampled geometries. Agreement below convergence gates is not an absolute continuum or physical accuracy bound. The separate 100-coupon blind-fit scores are not rerun or revised.','',f"Reference WASM SHA-256: `{M['source_wasm_sha256']}`",f"Current WASM SHA-256: `{M['current_wasm_sha256']}`",'']
text += ['', f"Additional Er=6.8 mesh refinements: {sum(q['passed'] for q in material_checks)}/{len(material_checks)} pass.", '']
text+=['All completed capacitance, inductance, loss derivatives and DC resistance coefficients are finite and positive. Reference snapshot integrity, source-tool hashes, baseline cache provenance and a fresh old-solver replay are recorded alongside this report.','', '## Repeated convergence checks','', '| Refinement | Worst relative dL/dn | Worst S RMS | Worst S max | Worst IL dB | Worst phase degrees |', '|---|---:|---:|---:|---:|---:|']
for label in dict.fromkeys(c['check'] for c in checks):
 selected=[c for c in checks if c['check']==label]
 values=[max(c['worst'][k] for c in selected) for k in limits]
 text.append('| '+label+' | '+' | '.join(f'{v:.9g}' for v in values)+' |')
text+=['', 'Reproduce locally: run `python toolchain/prepare-convergence-100.py` once to select the manifest, then `python toolchain/check-convergence-100.py` (resumes cached results), then `python toolchain/summarize-convergence-100.py`. Four optional runner shards accept arguments 0, 1, 2, 3. Run `python toolchain/check-convergence-100-dense.py` after all cases complete for 16001-frequency corroboration. Source repository location is currently specific to this workspace.','']
if (OUT/'dense-frequency-check.json').exists():
 dense=json.loads((OUT/'dense-frequency-check.json').read_text())
 assert dense['current_wasm_sha256']==M['current_wasm_sha256']
 text += ['## Dense frequency corroboration','',f"{dense['passed']}/100 cases pass all 16 loss scenarios at 16001 frequencies.",'', '| Metric | Worst dense-grid difference | Limit |', '|---|---:|---:|']
 for k in limits:text.append(f"| {k} | {dense['worst'][k]:.9g} | {limits[k]:.9g} |")
 text.append('')
(OUT/'REPORT.md').write_text('\n'.join(text))
print(json.dumps({k:summary[k] for k in ['completed','required','passed','worst','limit_fractions','convergence_passed','convergence_required']}))
