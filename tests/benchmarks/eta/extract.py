import sys
import json, re
from pathlib import Path
root = Path(sys.argv[1] if len(sys.argv) > 1 else 'build/eta-recordings').resolve()

def passes(d):
    rec = d['recording']
    events = rec['events']
    start = next((e['at'] for e in events if e['type'] == 'run-start'))
    end = next((e['at'] for e in reversed(events) if e['type'] == 'run-end'))
    result = []
    for event in events:
        m = event['data']
        if event['type'] != 'message' or 'telemetry' not in m:
            continue
        req = next((e for e in events if e['type'] == 'request' and e['data']['id'] == m['id'] and e['data'].get('clientId') == m.get('clientId')))
        p = {'case': d['label'], 'caseId': d['id'], 'mesh': d['mesh'], 'pass': len(result), 'start': req['at'] - start, 'workerStart': m['workerTimeOrigin'] + m['workerStartedAt'] - rec['timeOrigin'] - start, 'end': event['at'] - start, 'backend': 'serial', 'c': 0, 'n': 0, 'nodes': 0, 'signals': 0, 'threads': [1, 1], 'boundaries': [0, None, None, None, None, None, None, m['elapsedMs']], 'lines': m['telemetry'], 'progress': [dict(e['data'], at=e['at'] - start) for e in events if e['type'] == 'message' and e['data'].get('id') == m['id'] and e['data'].get('clientId') == m.get('clientId') and (e['data'].get('evt') == 'progress') and ('phase' in e['data'])], 'xsctn': req['data']['xsctn']}
        stage = 0
        for v in m['telemetry']:
            line = v['line']
            t = v['ms']
            mat = re.search('(\\d+) elements and (\\d+) nodes were generated', line)
            if mat:
                p['n'], p['nodes'] = map(int, mat.groups())
            mat = re.search('num_sig:\\s*(\\d+)', line)
            if mat:
                p['signals'] = int(mat[1])
            if line.startswith('MMTL_LU Eigen'):
                p['backend'] = 'eigen'
            if 'Calculate LHS' in line:
                stage = 4 if 'dielectric' in line else 1
                p['boundaries'][stage] = t
            mat = re.match('MMTL_PARALLEL (\\d+)', line)
            if mat:
                p['threads'][int(stage >= 4)] = int(mat[1])
            mat = re.match('MMTL_PROGRESS (assembly|factorization) (\\d+) (\\d+)', line)
            if mat:
                kind, completed, total = mat.groups()
                if kind == 'assembly' and stage == 1:
                    p['c'] = int(total)
                if kind == 'factorization' and stage in [1, 4]:
                    stage += 1
                    p['boundaries'][stage] = t
            if 'calculate RHS' in line and stage in [1, 2, 4, 5]:
                stage = 3 if stage < 4 else 6
                p['boundaries'][stage] = t
        for i in range(6, 0, -1):
            if p['boundaries'][i] is None:
                p['boundaries'][i] = p['boundaries'][i + 1]
        p['durations'] = [(b - a) / 1000 for a, b in zip(p['boundaries'], p['boundaries'][1:])]
        result.append(p)
    state = next((e['data']['state'] for e in events if e['type'] == 'run-start'))
    group = state['presetKind'] + '-' + state['presetVariant'] if state['mode'] == 'preset' else d['label']
    roles=[j.get('role', 'air' if j['label']=='Current and loss' else 'dielectric') for j in next(e['data']['jobs'] for e in events if e['type']=='plan')]
    return {'isolated': d['crossOriginIsolated'], 'roles':roles, 'estimates': [dict(e['data'], at=(e['at']-start)/1000) for e in events if e['type']=='estimate'], 'group': group, 'id': d['id'], 'label': d['label'], 'mesh': d['mesh'], 'duration': (end - start) / 1000, 'passes': result}
if __name__ == '__main__':
    data = [passes(json.loads(p.read_text(encoding='utf-8'))) for p in sorted(root.glob('0??.json'))]
    (root / 'extracted.json').write_text(json.dumps(data), encoding='utf-8')
    for d in data:
        print(d['id'], round(d['duration'], 2), [(p['backend'], p['c'], p['n'], [round(v, 3) for v in p['durations']]) for p in d['passes']])
