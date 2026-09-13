#!/usr/bin/env python3
"""Record a local solver build and invalidate the browser's paired WASM assets."""
import sys
import hashlib
import json
import re
from pathlib import Path

root = Path(__file__).resolve().parents[1]
threaded = len(sys.argv) > 1 and sys.argv[1] == '1'
optimized_lu = len(sys.argv) > 2 and sys.argv[2] == '1'
assets = root / 'public' / 'wasm'
if threaded: assets = assets / 'threaded'
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
source = root / 'vendor' / 'mmtl' / 'bem'
files = sorted(p for p in source.rglob('*') if p.suffix in ('.cpp', '.h', '.F'))
hashes = {p.relative_to(source).as_posix(): sha(p) for p in files}
wasm_hash = sha(assets / 'bem.wasm')
metadata = {
    'version': 'numerical-v1',
    'assembly_threads': 4 if threaded else 1,
    'lu_residual_validation': len(sys.argv) > 3 and sys.argv[3] == '1',
    'factorization': 'Eigen 3.4.0 blocked LU / SIMD' if optimized_lu else 'LINPACK / f2c',
    'eigen_source_sha256': {p.relative_to(root / 'vendor' / 'eigen-3.4.0').as_posix(): sha(p) for p in sorted((root / 'vendor' / 'eigen-3.4.0' / 'Eigen').rglob('*')) if p.is_file()} if optimized_lu else None,
    'precision': 'C++ double; f2c -r8 -R',
    'quadrature_order': 24,
    'panel_grading_power': 4,
    'wasm_sha256': wasm_hash,
    'module_sha256': sha(assets / 'bem.mjs'),
    'source_sha256': hashes,
    'physical_certification': False,
}
(assets / 'build-info.json').write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8')
client = root / 'src' / 'solver' / 'client.ts'
text = client.read_text(encoding='utf-8')
constant = 'BEM_THREADED_ASSET_REVISION' if threaded else 'BEM_ASSET_REVISION'
text, count = re.subn(r"const " + constant + r" = '[^']+';",
                     "const " + constant + " = '" + wasm_hash[:16] + "';", text)
if count != 1:
    raise SystemExit('Expected exactly one browser asset revision')
with client.open('w', encoding='utf-8', newline='\n') as output:
    output.write(text)
print(f'Recorded numerical-v1 solver {wasm_hash[:16]}')
