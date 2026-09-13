import pathlib,json,hashlib
root=pathlib.Path.cwd(); src=root.parent.parent/'TRL-Cal'/'deliverables/C21_mmtl_convergence'
out=root/'build/convergence-100';out.mkdir(exist_ok=True)
audit=json.loads((src/'final_step_audit.json').read_text()); fp=audit['solver_fingerprint']
cache=[(f,json.loads(f.read_text())['row']) for f in sorted((src/'row_cache').glob('*.json'))]
cache=[(f,r) for f,r in cache if r['solver_fingerprint']==fp]
rows=[]
def add(label,r):
 rows.append(dict(id=f'{len(rows)+1:03}',label=label,baseline=r))
for p in audit['results']:
 b=p['rows'][1]
 for mesh in [200,280]:
  matches=[r for f,r in cache if r['mesh']==mesh and r['width_mm']==b['width_mm'] and r['step_um']==.1 and r['er_step']==.02 and {k:v for k,v in r['config'].items() if k not in ['cseg','dseg','fixedEdgeDivisions']}=={k:v for k,v in b['config'].items() if k not in ['cseg','dseg','fixedEdgeDivisions']}]
  assert matches,(p['point'],mesh)
  add(p['point'],matches[0])
 for r in p['rows']:add(p['point'],r)
assert len(rows)==95
seen={json.dumps(x['baseline'],sort_keys=True) for x in rows}
extra=[(f,r) for f,r in cache if r['mesh']>=200 and json.dumps(r,sort_keys=True) not in seen]
# Prioritize high/low permittivity and domain extremes deterministically.
extra.sort(key=lambda x:(-abs(x[1]['config']['constructionEr']-4.1),-x[1]['config'].get('marginMm',0),str(x[0])))
for f,r in extra[:5]:add('additional saved material/domain: '+f.stem,r)
assert len(rows)==100
manifest=dict(scope='95 original geometry mesh/normal-step rows plus 5 preselected saved material/domain rows; not the separate blind 100-coupon fit study',source=str(src),source_fingerprint=fp,source_wasm_sha256=hashlib.sha256((src/'numerical_recipe_v1/wasm_q24_local_si/bem.wasm').read_bytes()).hexdigest(),current_wasm_sha256=hashlib.sha256((root/'public/wasm/threaded/bem.wasm').read_bytes()).hexdigest(),rows=rows)
if (out/'manifest.json').exists():
 assert json.loads((out/'manifest.json').read_text())==manifest, 'Existing manifest differs; preserve it and choose a fresh output directory'
else:
 (out/'manifest.json').write_text(json.dumps(manifest,indent=2))
print('Frozen',len(rows),'cases')
