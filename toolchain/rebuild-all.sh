#!/bin/bash
# Full rebuild of all three solver targets + all golden gates.
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# All objects are rebuilt so header/precision changes cannot leave stale ABI objects.
bash toolchain/build-native-gfortran.sh >/dev/null
bash toolchain/build-native-f2c.sh >/dev/null
bash toolchain/build-wasm.sh >/dev/null
echo "== native gfortran gate"
bash toolchain/run-golden-native.sh build/native-gfortran-double-q24-v1/bem 2>/dev/null | tail -2
echo "== native f2c gate"
bash toolchain/run-golden-native.sh build/native-f2c-double-q24-v1/bem 2>/dev/null | tail -2
echo "== wasm gate"
bash toolchain/run-golden-wasm.sh 2>/dev/null | tail -2
