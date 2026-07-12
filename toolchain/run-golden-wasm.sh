#!/bin/bash
# WASM golden gate: run all fixtures through public/wasm/bem.mjs under node,
# then numerically compare against .result_save (same waiver as native).
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/sources.sh"
[ -x "$HOME/node16/bin/node" ] && export PATH="$HOME/node16/bin:$PATH"
command -v node >/dev/null || { echo "node not found"; exit 1; }

RTOL="${1:-1e-2}"
WORK="$TNTWEB_ROOT/build/golden-wasm"
TESTS="$BEM_DIR/tests"
WAIVED=" w20t5 "   # same stale-2002-golden waiver as run-golden-native.sh

node "$TNTWEB_ROOT/tests/golden/run-golden.mjs" --outDir "$WORK" || exit 1

pass=0; fail=0; failed=""
for save in "$TESTS"/*.result_save; do
  name="$(basename "$save" .result_save)"
  [ -f "$WORK/$name.result" ] || { echo "MISSING $name.result"; fail=$((fail+1)); continue; }
  if python3 "$TNTWEB_ROOT/toolchain/compare_results.py" "$WORK/$name.result" "$save" "$RTOL"; then
    pass=$((pass+1))
  elif [[ "$WAIVED" == *" $name "* ]]; then
    echo "WAIVED $name (known-stale golden)"
  else
    fail=$((fail+1)); failed="$failed $name"
  fi
done
echo "=================================="
echo "WASM GOLDEN: $pass passed, $fail failed$([ -n "$failed" ] && echo " ($failed)")"
[ $fail -eq 0 ]
