#!/usr/bin/env python3
"""Record a local solver build and invalidate the browser's paired WASM assets."""
import hashlib
import json
import re
from pathlib import Path

root = Path(__file__).resolve().parents[1]
assets = root / 'public' / 'wasm'
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
source = root / 'vendor' / 'mmtl' / 'bem'
files = sorted(p for p in source.rglob('*') if p.suffix in ('.cpp', '.h', '.F'))
hashes = {p.relative_to(source).as_posix(): sha(p) for p in files}
wasm_hash = sha(assets / 'bem.wasm')
metadata = {
    'version': 'numerical-v1',
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
text, count = re.subn(r"const BEM_ASSET_REVISION = '[^']+';",
                     f"const BEM_ASSET_REVISION = '{wasm_hash[:16]}';", text)
if count != 1:
    raise SystemExit('Expected exactly one browser asset revision')
with client.open('w', encoding='utf-8', newline='\n') as output:
    output.write(text)
print(f'Recorded numerical-v1 solver {wasm_hash[:16]}')
