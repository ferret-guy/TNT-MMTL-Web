import json,csv,sys,html
from pathlib import Path
root=Path(sys.argv[1] if len(sys.argv)>1 else 'build/eta-recordings').resolve()
results=json.loads((root/'replay-results.json').read_text(encoding='utf-8'))
rows=[]
for r in results:
 if r['mode']!='heldout':continue
 baseline=next(x for x in results if x['id']==r['id'] and x['mode']=='baseline')
 fitted=next(x for x in results if x['id']==r['id'] and x['mode']=='fit')
 rows.append({'id':r['id'],'case':r['label'],'segments':r['mesh'],'duration_s':round(r['duration'],3),'old_p90_error_pct':round(baseline['p90'],3),'heldout_median_error_pct':round(r['median'],3),'heldout_p90_error_pct':round(r['p90'],3),'heldout_max_error_pct':round(r['max'],3),'fitted_p90_error_pct':round(fitted['p90'],3),'max_finish_jump_s':round(r['maxJump'],3)})
with (root/'replay-summary.csv').open('w',encoding='utf-8',newline='') as f:
 w=csv.DictWriter(f,fieldnames=rows[0]);w.writeheader();w.writerows(rows)
lines=['# Replayable ETA benchmark','',f'{len(rows)} recorded cases. All comparisons reuse the same raw solver run; no solver is launched by fitting or replay.','', '## Method','', 'The capture stores every native output line with its worker timestamp, all progress delivery timestamps, every pass input/output, the planned passes, and page start/completion. Replay releases events only at their recorded delivery times. Costs depend on matrix dimensions and backend, not geometry names. The simplified model learns five numbers: two assembly rates, two LU backend rates and one shared overhead; within a run it adapts to observed progress and completed phases. Uniform-dielectric matrices use the homogeneous kernel cost, and the air/current pass receives its own predicted work instead of a fixed percentage.','', 'Held-out validation excludes the entire guided geometry/mode family, including About examples and every mesh size, or the entire named freeform example. It does not use that family to fit the starting rates. The final deployed rates use the full dataset. Online adaptation uses only past events of the current run. This is a development cross-validation benchmark, not an untouched independent test set or a guarantee for every machine.','', 'Errors are absolute predicted finish-time errors divided by actual total solve duration. Median, P90 and maximum use the middle 80% of elapsed time. P90 means 90% of those samples have no larger error; maxima remain reported so transient spikes are not hidden. These are unrounded estimates; the UI continues to display whole seconds. Small solves cannot display 1% precision at that resolution.','', 'Duration policy: under 10 seconds is ungraded; 10-30 seconds allows up to 50% error; 30-60 seconds is informational. Above 60 seconds matters most: stripline <10%, freeform <25%. These recordings contain no stripline solve longer than 60 seconds, so that long-stripline target remains unmeasured.', '', '## Results','', '| Case | Segments | Time (s) | Old P90 | New held-out median | New held-out P90 | New maximum |','|---|---:|---:|---:|---:|---:|---:|']
for r in rows:lines.append(f"| {r['case']} | {r['segments']} | {r['duration_s']:.1f} | {r['old_p90_error_pct']:.1f}% | {r['heldout_median_error_pct']:.1f}% | {r['heldout_p90_error_pct']:.1f}% | {r['heldout_max_error_pct']:.1f}% |")
lines+=['','## Reproduction','','From the repository root:','','```text','npm run benchmark:eta:replay','python tests/benchmarks/eta/report.py','```','','For a different recorded directory, pass its path to validate.py, fit.py, replay.mjs and report.py. `ETA_SETTLING` changes the single smoothing confidence time for an offline experiment. Raw JSON files are immutable evidence; derived models and replay outputs can be regenerated. `recordings-index.json` contains file checksums and event counts.','','New recordings use `npm run benchmark:eta:record -- build/new-eta-recording`, then the printed local URL. The recorder resumes missing cases and refuses to overwrite existing files or mix changed source versions. `?cases=023,024,005` selects a small integration-check subset.']
(root/'replay-report.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
header=['Case','Segments','Time (s)','Old P90','New median','New P90','New maximum']
body=''.join('<tr>'+''.join('<td>'+html.escape(str(v))+'</td>' for v in [r['case'],r['segments'],f"{r['duration_s']:.1f}",f"{r['old_p90_error_pct']:.1f}%",f"{r['heldout_median_error_pct']:.1f}%",f"{r['heldout_p90_error_pct']:.1f}%",f"{r['heldout_max_error_pct']:.1f}%"])+'</tr>' for r in rows)
(root/'replay-report.html').write_text('<!doctype html><meta charset="utf-8"><title>ETA replay results</title><style>body{font:16px system-ui;max-width:1250px;margin:30px auto;padding:20px}table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}td,th{padding:8px;border-bottom:1px solid #ddd;text-align:right}td:first-child,th:first-child{text-align:left}img{width:100%}</style><h1>ETA replay results</h1><p>Raw recordings reused offline. Five fitted numbers. Geometry-family held-out validation. Under 10 seconds is ungraded; 10-30 seconds allows 50%; 30-60 seconds is informational; longer solves are the tuning priority. Errors are unrounded finish-time errors relative to total solve duration, measured during the middle 80% of each run.</p><p><a href="replay-report.md">Method and full report</a> | <a href="replay-summary.csv">CSV</a></p><img src="replay-errors.png" alt="Old and new ETA error traces"><table><thead><tr>'+''.join('<th>'+h+'</th>' for h in header)+'</tr></thead><tbody>'+body+'</tbody></table>',encoding='utf-8')
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
fig,axes=plt.subplots(3,2,figsize=(12,10),constrained_layout=True)
for ax,ident in zip(axes.flat,['015','024','018','019','020','028']):
 matches=[x for x in results if x['id']==ident]
 if not matches:ax.set_title(ident+' pending');continue
 r=next(x for x in matches if x['mode']=='heldout');limit=None if r['duration']<10 or 30<=r['duration']<=60 else 50 if r['duration']<30 else 10 if ident in ['015','024'] else 25
 for mode,label,color in [('baseline','Old ETA','#d55e00'),('heldout','New held-out ETA','#0072b2')]:
  s=next(x for x in matches if x['mode']==mode)['samples'];ax.plot([v['at']/r['duration']*100 for v in s],[v['error']/r['duration']*100 for v in s],label=label,color=color,linewidth=1)
 
 if limit is not None:ax.axhspan(-limit,limit,alpha=.12,color='#009e73')
 ax.axhline(0,color='#555',linewidth=.6);ax.set_xlim(0,100);ax.set_xlabel('Elapsed fraction (%)');ax.set_ylabel('Finish-time error / total (%)');ax.set_title(r['label']+f"\n{r['mesh']} segments, {r['duration']:.1f} s");ax.grid(alpha=.2);ax.legend(fontsize=8)
 if max(abs(v['error'])/r['duration']*100 for x in matches if x['mode'] in ['baseline','heldout'] for v in x['samples'])>200:ax.set_yscale('symlog',linthresh=25);ax.set_ylabel('Error (%) - symmetric log')
fig.suptitle('Recorded solver work, replayed ETA algorithms',fontsize=15);fig.savefig(root/'replay-errors.png',dpi=150)
print(root/'replay-report.md')

if (root/'live-check.json').exists() and 'conductor' not in json.loads((root/'cost-model.json').read_text(encoding='utf-8')):
 live=json.loads((root/'live-check.json').read_text(encoding='utf-8'))
 extra=['','## Fresh live integration checks','','Three fresh browser solves used the selected implementation. These check integration and timing on a new run, not new geometry coverage.','', '| Case | Segments | Typical raw ETA error | P90 | Maximum |','|---|---:|---:|---:|---:|']
 for row in live['cases']:extra.append(f"| {row['label']} | {row['mesh']} | {row['median']:.2f}% | {row['p90']:.2f}% | {row['max']:.2f}% |")
 extra+=['',f"Replaying the transported live snapshots agrees with the page to within {max(r['maxEtaDifferenceSeconds'] for r in live['conformance']):.6f} seconds. Single-ended stripline has a brief 10.22% peak in this fresh run; it is not a strict all-instants-under-10% guarantee. The display still rounds to whole seconds."]
 with (root/'replay-report.md').open('a',encoding='utf-8') as f:f.write('\n'.join(extra)+'\n')
