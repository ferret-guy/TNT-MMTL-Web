#!/bin/bash
# Build calcRL (frequency-dependent R/L wavelet solver, pure C++):
#   native  -> build/calcrl-native/calcrl   (golden validation)
#   wasm    -> public/wasm/calcrl.mjs       (with --wasm)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/vendor/mmtl/calcRL/src"

MODE="${1:-native}"

# per calcRL/Makefile.am: wavecyn.cpp is an alternate (disabled) main
SOURCES=()
for f in "$SRC"/*.cpp; do
  case "$f" in *wavecyn.cpp) continue;; esac
  SOURCES+=("$f")
done

if [ "$MODE" = "--wasm" ] || [ "$MODE" = "wasm" ]; then
  if ! command -v emcc >/dev/null; then
    source "$HOME/emsdk/emsdk_env.sh" >/dev/null 2>&1 || true
  fi
  [ -x "$HOME/node16/bin/node" ] && export PATH="$HOME/node16/bin:$PATH"
  OUT="$HOME/.cache/tnt-web/calcrl-wasm"
  mkdir -p "$OUT"
  for f in "${SOURCES[@]}"; do
    o="$OUT/$(basename "${f%.cpp}").o"
    [ "$o" -nt "$f" ] && continue
    em++ -O2 -std=gnu++14 -fpermissive -w "-I$SRC" -c "$f" -o "$o"
  done
  em++ -O2 "$OUT"/*.o -o "$OUT/calcrl.mjs" \
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createCalcRLModule \
    -sENVIRONMENT=web,worker,node \
    -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 \
    -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864 -sSTACK_SIZE=4194304 \
    -sEXPORTED_RUNTIME_METHODS=FS,callMain \
    -sASSERTIONS=0
  cp -f "$OUT/calcrl.mjs" "$OUT/calcrl.wasm" "$ROOT/public/wasm/"
  echo "OK: public/wasm/calcrl.mjs"
else
  OUT="$ROOT/build/calcrl-native"
  mkdir -p "$OUT/obj"
  for f in "${SOURCES[@]}"; do
    o="$OUT/obj/$(basename "${f%.cpp}").o"
    [ "$o" -nt "$f" ] && continue
    g++ -O2 -std=gnu++14 -fpermissive -w "-I$SRC" -c "$f" -o "$o"
  done
  g++ "$OUT"/obj/*.o -lm -o "$OUT/calcrl"
  echo "OK: $OUT/calcrl"
fi
