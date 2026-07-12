#!/bin/bash
# Phase B: native build with f2c-translated FORTRAN (WSL).
# Isolates f2c translation semantics from wasm issues before Phase C.
#
# f2c -R is REQUIRED: nmmtl_find_nu.cpp passes a float(*)(float*) callback
# into FMIN; without -R, f2c makes REAL functions return double, which is a
# silent mismatch natively and a fatal call_indirect trap on wasm.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/sources.sh"

OUT="$TNTWEB_ROOT/build/native-f2c"
GEN="$OUT/f2c-gen"
mkdir -p "$OUT/obj" "$GEN"

command -v f2c >/dev/null || { echo "f2c not installed (apt install f2c libf2c2-dev)"; exit 1; }

echo "== f2c translation (-R) of $(echo "$FORTRAN_SOURCES" | wc -l) files"
for f in $FORTRAN_SOURCES; do
  base="$(basename "${f%.F}")"
  # .F files contain no cpp directives (verified) -> plain rename to .f
  cp "$BEM_DIR/$f" "$GEN/$base.f"
done
( cd "$GEN" && f2c -R -w *.f > f2c.log 2>&1 ) || { tail -20 "$GEN/f2c.log"; exit 1; }

CXXFLAGS=(-O2 -DFORTRAN_UNDERBARS -DHAVE_GETLOGIN "-I$SRC_DIR" -std=gnu++14 -Wno-write-strings -fpermissive -w)
# ilp32 f2c.h override shadows /usr/include/f2c.h (64-bit long integer there)
CFLAGS=(-O2 "-I$TNTWEB_ROOT/toolchain/f2c/include" -w)

echo "== compiling C++"
for f in $CPP_SOURCES; do
  o="$OUT/obj/$(basename "${f%.cpp}").o"
  [ "$o" -nt "$BEM_DIR/$f" ] && continue
  g++ "${CXXFLAGS[@]}" -c "$BEM_DIR/$f" -o "$o"
done

echo "== compiling f2c output"
for c in "$GEN"/*.c; do
  o="$OUT/obj/$(basename "${c%.c}")_f.o"
  [ "$o" -nt "$c" ] && continue
  gcc "${CFLAGS[@]}" -c "$c" -o "$o"
done

echo "== linking"
g++ "$OUT"/obj/*.o -lf2c -lm -o "$OUT/bem"
echo "OK: $OUT/bem"
