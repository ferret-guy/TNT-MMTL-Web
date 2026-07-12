#!/bin/bash
# Phase A: native reference build with g++ + gfortran (WSL).
# gfortran (not f2c) natively: 64-bit f2c defaults INTEGER to 8-byte long,
# mismatching the C++ `int*` args; gfortran keeps INTEGER=32-bit and REAL
# function returns = float, matching math_library.h's extern "C" decls.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/sources.sh"

OUT="$TNTWEB_ROOT/build/native-gfortran"
mkdir -p "$OUT/obj"

CXXFLAGS=(-O2 -DFORTRAN_UNDERBARS -DHAVE_GETLOGIN "-I$SRC_DIR" -std=gnu++14 -Wno-write-strings -fpermissive -w)
FFLAGS=(-O2 -std=legacy -w)

echo "== compiling C++ ($(echo "$CPP_SOURCES" | wc -l) TUs)"
for f in $CPP_SOURCES; do
  o="$OUT/obj/$(basename "${f%.cpp}").o"
  [ "$o" -nt "$BEM_DIR/$f" ] && continue
  g++ "${CXXFLAGS[@]}" -c "$BEM_DIR/$f" -o "$o"
done

echo "== compiling FORTRAN ($(echo "$FORTRAN_SOURCES" | wc -l) files)"
for f in $FORTRAN_SOURCES; do
  o="$OUT/obj/$(basename "${f%.F}")_f.o"
  [ "$o" -nt "$BEM_DIR/$f" ] && continue
  gfortran "${FFLAGS[@]}" -c "$BEM_DIR/$f" -o "$o"
done

echo "== linking"
g++ "$OUT"/obj/*.o -lgfortran -lm -o "$OUT/bem"
echo "OK: $OUT/bem"
