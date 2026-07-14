#!/bin/bash
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
OUT="$HOME/.cache/tnt-web/wasm"
GEN="$OUT/f2c-gen"
LIBF2C="$HOME/.cache/tnt-web/libf2c"
mkdir -p "$OUT/obj" "$GEN" "$TNTWEB_ROOT/public/wasm"

# ---- 1. libf2c for wasm (cached) ----
if [ ! -f "$LIBF2C/libf2c.a" ]; then
  bash "$TNTWEB_ROOT/toolchain/f2c/fetch-libf2c.sh" "$LIBF2C"
fi

# ---- 2. f2c translation (-R mandatory; see build-native-f2c.sh) ----
if ! ls "$GEN"/*.c >/dev/null 2>&1; then
  echo "== f2c -R translation"
  for f in $FORTRAN_SOURCES; do
    cp "$BEM_DIR/$f" "$GEN/$(basename "${f%.F}").f"
  done
  ( cd "$GEN" && f2c -R -w *.f > f2c.log 2>&1 ) || { tail -20 "$GEN/f2c.log"; exit 1; }
fi

# ---- 3. compile ----
CXXFLAGS=(-O2 -DFORTRAN_UNDERBARS -DHAVE_GETLOGIN "-I$SRC_DIR" -std=gnu++14 -Wno-write-strings -fpermissive -w)
# stock (wasm32) f2c.h from libf2c build dir: long is 32-bit there, correct ABI
CFLAGS=(-O2 "-I$LIBF2C/src" -w)

echo "== em++ C++ ($(echo "$CPP_SOURCES" | wc -l) TUs)"
for f in $CPP_SOURCES; do
  o="$OUT/obj/$(basename "${f%.cpp}").o"
  [ "$o" -nt "$BEM_DIR/$f" ] && continue
  em++ "${CXXFLAGS[@]}" -c "$BEM_DIR/$f" -o "$o"
done

echo "== emcc f2c output"
for c in "$GEN"/*.c; do
  o="$OUT/obj/$(basename "${c%.c}")_f.o"
  [ "$o" -nt "$c" ] && continue
  emcc "${CFLAGS[@]}" -c "$c" -o "$o"
done

# ---- 4. link (locally, then copy: Dropbox locks in-place renames on /mnt/d) ----
echo "== linking bem.mjs"
# Keep memory growth without exposing resizable heap views to browser APIs.
em++ -O2 "$OUT"/obj/*.o "$LIBF2C/libf2c.a" \
  -o "$OUT/bem.mjs" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createBemModule \
  -sENVIRONMENT=web,worker,node \
  -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 \
  -sALLOW_MEMORY_GROWTH=1 -sGROWABLE_ARRAYBUFFERS=0 \
  -sINITIAL_MEMORY=67108864 -sSTACK_SIZE=4194304 \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain \
  -sASSERTIONS=0 2> "$OUT/link.log" || { cat "$OUT/link.log"; exit 1; }
if grep -q "signature mismatch" "$OUT/link.log"; then
  echo "FATAL: wasm-ld signature mismatches (would trap at runtime):"
  grep -A2 "signature mismatch" "$OUT/link.log"
  exit 1
fi
cp -f "$OUT/bem.mjs" "$OUT/bem.wasm" "$TNTWEB_ROOT/public/wasm/"
rm -f "$TNTWEB_ROOT/public/wasm/"*.temp-stream-* 2>/dev/null || true
ls -la "$TNTWEB_ROOT/public/wasm/"
echo "OK"
