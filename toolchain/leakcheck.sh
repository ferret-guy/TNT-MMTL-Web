#!/bin/bash
# 50-solve leak check (fresh module per solve) + wasm-vs-native-f2c agreement.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/sources.sh"
[ -x "$HOME/node16/bin/node" ] && export PATH="$HOME/node16/bin:$PATH"
cd "$TNTWEB_ROOT"
node tests/golden/run-golden.mjs --fixture trap_test --repeat 50 | tail -2
echo "== wasm vs native-f2c (same translated code):"
python3 toolchain/compare_results.py build/golden-wasm/w10t2.5.result build/golden-native-f2c/w10t2.5.result 1e-3 | tail -1
python3 toolchain/compare_results.py build/golden-wasm/9-7-00.result build/golden-native-f2c/9-7-00.result 1e-3 | tail -1
