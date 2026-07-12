#!/bin/bash
# Full rebuild of all three solver targets + all golden gates.
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# incremental: build scripts recompile only TUs newer than their objects
bash toolchain/build-native-gfortran.sh >/dev/null
bash toolchain/build-native-f2c.sh >/dev/null
bash toolchain/build-wasm.sh >/dev/null
echo "== native gfortran gate"
bash toolchain/run-golden-native.sh build/native-gfortran/bem 2>/dev/null | tail -2
echo "== native f2c gate"
bash toolchain/run-golden-native.sh build/native-f2c/bem 2>/dev/null | tail -2
echo "== wasm gate"
bash toolchain/run-golden-wasm.sh 2>/dev/null | tail -2
