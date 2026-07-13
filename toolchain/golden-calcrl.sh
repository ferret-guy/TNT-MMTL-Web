#!/bin/bash
# calcRL golden: run the shipped jc fixture and compare R/L values.
# usage: golden-calcrl.sh [native|wasm]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TESTS="$ROOT/vendor/mmtl/calcRL/tests"
MODE="${1:-native}"
WORK="$ROOT/build/golden-calcrl-$MODE"
mkdir -p "$WORK"
cp "$TESTS/jc.in" "$WORK/jc.in"

if [ "$MODE" = "wasm" ]; then
  [ -x "$HOME/node16/bin/node" ] && export PATH="$HOME/node16/bin:$PATH"
  node "$ROOT/tests/golden/run-calcrl.mjs" "$WORK/jc.in" > "$WORK/jc.out"
else
  ( cd "$WORK" && rm -f jc.out* && "$ROOT/build/calcrl-native/calcrl" jc > stdout.txt 2>&1 )
fi

python3 - "$WORK/jc.out" "$TESTS/jc.out_save" <<'EOF'
import re, sys
def nums(path):
    vals = []
    for line in open(path, errors='replace'):
        if re.search(r'CPU time|Input file', line):
            continue
        vals += [float(t) for t in re.findall(r'[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?', line)]
    return vals
got, want = nums(sys.argv[1]), nums(sys.argv[2])
assert len(got) == len(want), f'count {len(got)} != {len(want)}'
worst = 0.0
for a, b in zip(got, want):
    err = abs(a-b)/max(abs(b), 1e-30)
    worst = max(worst, err)
print(f'calcRL golden: {len(got)} values, worst rel err {worst:.2e}')
sys.exit(0 if worst < 2e-3 else 1)
EOF
