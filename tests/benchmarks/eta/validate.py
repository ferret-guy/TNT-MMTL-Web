"""Validate and inventory immutable raw ETA recordings before fitting or replay."""
import hashlib, json, sys
from pathlib import Path
root = Path(sys.argv[1] if len(sys.argv) > 1 else 'build/eta-recordings').resolve()
files = sorted(root.glob('0??.json'))
index = []
for path in files:
    data = json.loads(path.read_text(encoding='utf-8'))
    rec = data['recording']
    events = rec['events']
    assert data['success'], f'{path.name}: solve failed'
    assert rec['schemaVersion'] == 1, f'{path.name}: unsupported schema'
    assert sum((e['type'] == 'run-start' for e in events)) == 1, f'{path.name}: multiple runs'
    assert sum((e['type'] == 'run-end' for e in events)) == 1, f'{path.name}: missing completion'
    assert all((a['at'] <= b['at'] for a, b in zip(events, events[1:]))), f'{path.name}: event time order'
    requests = [e['data'] for e in events if e['type'] == 'request']
    outputs = [e['data'] for e in events if e['type'] == 'message' and 'telemetry' in e['data']]
    assert len(next(e['data']['jobs'] for e in events if e['type']=='plan')) == len(outputs), f'{path.name}: an expected pass is missing'
    assert len(requests) == len(outputs), f'{path.name}: missing pass output'
    count = 0
    for req, out in zip(requests, outputs):
        assert req['id'] == out['id'] and req.get('clientId') == out.get('clientId'), f'{path.name}: request mismatch'
        assert req['xsctn'] and out['ok'] and out['resultText'], f'{path.name}: incomplete pass'
        trace = out['telemetry']
        count += len(trace)
        assert trace and any(('MMTL is done' in e['line'] for e in trace)), f'{path.name}: truncated native log'
        assert all((a['ms'] <= b['ms'] for a, b in zip(trace, trace[1:]))), f'{path.name}: native time order'
        assert all((0 <= e['ms'] <= out['elapsedMs'] + 1 for e in trace)), f'{path.name}: invalid native timestamps'
    index.append({'file': path.name, 'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'passes': len(outputs), 'nativeEvents': count, 'mainEvents': len(events)})
(root / 'recordings-index.json').write_text(json.dumps(index, indent=2), encoding='utf-8')
print(f"Validated {len(index)} cases, {sum((d['passes'] for d in index))} passes, {sum((d['nativeEvents'] for d in index))} native events.")
if len(index) != 28:
    print('Partial dataset: full suite requires 28 cases.')

if len(index) != 28 and '--allow-partial' not in sys.argv:
    raise SystemExit('Incomplete benchmark: use --allow-partial only for an intentional subset.')
