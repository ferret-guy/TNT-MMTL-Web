#!/usr/bin/env python3
"""Compare both native builds with the real application-mode WASM inputs/results."""
import json
import shutil
import subprocess
from pathlib import Path
from compare_results import sections

root = Path(__file__).resolve().parents[1]
work = root / 'build' / 'numerical-v1'
cases = json.loads((work / 'native-cases.json').read_text())
results = []
for backend in ('native-f2c-double-q24-v1', 'native-gfortran-double-q24-v1'):
    binary = root / 'build' / backend / 'bem'
    for case in cases:
        name = case['name']
        directory = work / backend / name
        directory.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(work / 'cases' / (name + '.xsctn'), directory / 'case.xsctn')
        run = subprocess.run([str(binary), 'case', str(case['cseg']), str(case['dseg'])],
                             cwd=directory, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             universal_newlines=True, timeout=300)
        (directory / 'stdout.log').write_text(run.stdout + run.stderr)
        if run.returncode or 'MMTL is done' not in run.stdout:
            raise SystemExit(f'{backend}/{name}: solve failed')
        actual = sections(directory / 'case.result')
        expected = sections(work / 'cases' / (name + '.result'))
        worst = 0.0
        for key in ('B', 'L', 'Rdc', 'Z0', 'Zoddeven', 'eps', 'V', 'Voddeven', 'D', 'Doddeven'):
            a, b = actual[key], expected[key]
            if len(a) != len(b):
                raise SystemExit(f'{backend}/{name}: {key} dimensions differ')
            scale = max(map(abs, b), default=0)
            for x, y in zip(a, b):
                error = abs(x-y) / max(abs(y), scale * 1e-3, 1e-30)
                worst = max(error, worst)
        row = dict(backend=backend, case=name, worst_relative_error=worst, passed=worst < 1e-7)
        results.append(row)
        print(f"{'PASS' if row['passed'] else 'FAIL'} {backend}/{name}: {worst:.3g}", flush=True)
        (work / 'native-parity.json').write_text(json.dumps(results, indent=2) + '\n')
if not all(row['passed'] for row in results):
    raise SystemExit(1)
