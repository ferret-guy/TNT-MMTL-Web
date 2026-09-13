#!/bin/bash
# Double-precision numerical recipe v1.
# Phase C: WebAssembly build with Emscripten (run under WSL with emsdk active,
# or via: docker run --rm -v "$PWD:/src" -w /src emscripten/emsdk:3.1.61 bash toolchain/build-wasm.sh).
#
# Produces public/wasm/bem.mjs + bem.wasm (committed artifacts).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/sources.sh"

# Self-contained env: pick up emsdk and the glibc-2.27-compatible node16
# (emsdk 3.1.61's bundled node 22 needs glibc >= 2.28; see README).
if ! command -v emcc >/dev/null; then
  [ -f "$HOME/emsdk/emsdk_env.sh" ] && source "$HOME/emsdk/emsdk_env.sh" >/dev/null 2>&1 || true
fi
[ -x "$HOME/node16/bin/node" ] && export PATH="$HOME/node16/bin:$PATH"
command -v emcc >/dev/null || { echo "emcc not on PATH (source ~/emsdk/emsdk_env.sh)"; exit 1; }
command -v node >/dev/null || { echo "node not on PATH"; exit 1; }

# Object/intermediate files go to WSL-local storage (Dropbox sync locks files
# under /mnt/d mid-build); only the final bem.mjs/.wasm land in the project.
OUT="$HOME/.cache/tnt-web/wasm-double-q24-v1"
THREAD_FLAGS=()
LINK_THREAD_FLAGS=()
ASSET_DIR="$TNTWEB_ROOT/public/wasm"
if [ "${TNTWEB_PTHREADS:-0}" = 1 ]; then
  OUT="$OUT-pthreads"
  ASSET_DIR="$ASSET_DIR/threaded"
  THREAD_FLAGS=(-pthread)
  LINK_THREAD_FLAGS=(-sPTHREAD_POOL_SIZE=4 -sPTHREAD_POOL_SIZE_STRICT=2)
fi
LU_FLAGS=()
SIMD_FLAGS=()
if [ "${TNTWEB_OPTIMIZED_LU:-${TNTWEB_PTHREADS:-0}}" = 1 ]; then
  SIMD_FLAGS=(-msimd128 -msse2)
  LU_FLAGS=(-DTNT_OPTIMIZED_LU "-I$TNTWEB_ROOT/vendor/eigen-3.4.0")
fi
if [ "${TNTWEB_LU_VALIDATE:-0}" = 1 ]; then LU_FLAGS+=(-DTNT_LU_VALIDATE); fi
GEN="$OUT/f2c-gen"
LIBF2C="$HOME/.cache/tnt-web/libf2c"
mkdir -p "$OUT/obj" "$GEN" "$ASSET_DIR"

# ---- 1. libf2c for wasm (cached) ----
if [ ! -f "$LIBF2C/libf2c.a" ]; then
  bash "$TNTWEB_ROOT/toolchain/f2c/fetch-libf2c.sh" "$LIBF2C"
fi

# ---- 2. f2c translation (-R mandatory; see build-native-f2c.sh) ----
# Always regenerate after precision or Fortran source changes.
echo "== f2c -r8 -R translation"
for f in $FORTRAN_SOURCES; do
  cp "$BEM_DIR/$f" "$GEN/$(basename "${f%.F}").f"
done
( cd "$GEN" && f2c -r8 -R -w *.f > f2c.log 2>&1 ) || { tail -20 "$GEN/f2c.log"; exit 1; }

# ---- 3. compile ----
CXXFLAGS=(-O2 -DFORTRAN_UNDERBARS -DHAVE_GETLOGIN "-I$SRC_DIR" -std=gnu++14 -Wno-write-strings -fpermissive -w)
# stock (wasm32) f2c.h from libf2c build dir: long is 32-bit there, correct ABI
CFLAGS=(-O2 "-I$LIBF2C/src" -w)

echo "== em++ C++ ($(echo "$CPP_SOURCES" | wc -l) TUs)"
for f in $CPP_SOURCES; do
  o="$OUT/obj/$(basename "${f%.cpp}").o"
  em++ "${THREAD_FLAGS[@]}" "${LU_FLAGS[@]}" "${CXXFLAGS[@]}" -c "$BEM_DIR/$f" -o "$o"
done

if [ "${TNTWEB_OPTIMIZED_LU:-${TNTWEB_PTHREADS:-0}}" = 1 ]; then
  em++ "${THREAD_FLAGS[@]}" "${LU_FLAGS[@]}" "${CXXFLAGS[@]}" "${SIMD_FLAGS[@]}" -O3 -c "$SRC_DIR/optimized_lu.cpp" -o "$OUT/obj/optimized_lu.o"
else
  rm -f "$OUT/obj/optimized_lu.o"
fi

echo "== emcc f2c output"
for c in "$GEN"/*.c; do
  o="$OUT/obj/$(basename "${c%.c}")_f.o"
  emcc "${THREAD_FLAGS[@]}" "${CFLAGS[@]}" -c "$c" -o "$o"
done

# ---- 4. link (locally, then copy: Dropbox locks in-place renames on /mnt/d) ----
echo "== linking bem.mjs"
# Older Emscripten releases do not have the resizable-buffer setting.
MEMORY_FLAGS=(-sALLOW_MEMORY_GROWTH=1)
if grep -q 'var GROWABLE_ARRAYBUFFERS' "$(dirname "$(command -v emcc)")/src/settings.js"; then
  MEMORY_FLAGS+=(-sGROWABLE_ARRAYBUFFERS=0)
fi
# Keep memory growth without exposing resizable heap views to browser APIs.
em++ -O2 "${SIMD_FLAGS[@]}" "${LU_FLAGS[@]}" "${THREAD_FLAGS[@]}" "${LINK_THREAD_FLAGS[@]}" "$OUT"/obj/*.o "$LIBF2C/libf2c.a" \
  -o "$OUT/bem.mjs" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createBemModule \
  -sENVIRONMENT=web,worker,node \
  -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 \
  "${MEMORY_FLAGS[@]}" \
  -sINITIAL_MEMORY=67108864 -sSTACK_SIZE=4194304 \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain,PThread \
  -sASSERTIONS=0 2> "$OUT/link.log" || { cat "$OUT/link.log"; exit 1; }
if grep -q "signature mismatch" "$OUT/link.log"; then
  echo "FATAL: wasm-ld signature mismatches (would trap at runtime):"
  grep -A2 "signature mismatch" "$OUT/link.log"
  exit 1
fi
cp -f "$OUT/bem.mjs" "$OUT/bem.wasm" "$ASSET_DIR/"
if [ "${TNTWEB_PTHREADS:-0}" = 1 ]; then
  cp -f "$OUT/bem.worker.mjs" "$ASSET_DIR/"
fi
rm -f "$TNTWEB_ROOT/public/wasm/"*.temp-stream-* 2>/dev/null || true
python3 "$TNTWEB_ROOT/toolchain/record-solver-build.py" "${TNTWEB_PTHREADS:-0}" "${TNTWEB_OPTIMIZED_LU:-${TNTWEB_PTHREADS:-0}}" "${TNTWEB_LU_VALIDATE:-0}"
ls -la "$TNTWEB_ROOT/public/wasm/"
echo "OK"
