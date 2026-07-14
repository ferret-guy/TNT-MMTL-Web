#!/bin/bash
# Build libf2c.a for wasm with emcc.
# - arith.h must describe the TARGET (wasm32): compile arithchk to wasm and
#   run it under node (per the f2c README cross-compilation procedure).
# - Drop archive members that are Fortran-main / unix-process stubs; since no
#   .F file in this project does any I/O, only small math/support members are
#   ever pulled at link time.
set -euo pipefail
# Work in WSL-local storage: the project lives in a Dropbox folder whose
# Windows-side sync locks files mid-build (rm: Permission denied on /mnt/d).
OUT="${1:-$HOME/.cache/tnt-web/libf2c}"
mkdir -p "$OUT"
cd "$OUT"

if [ ! -f libf2c.zip ]; then
  curl -fsSLO https://www.netlib.org/f2c/libf2c.zip
fi
rm -rf src && mkdir src && ( cd src && unzip -oq ../libf2c.zip )
cd src

# f2c.h used both to build libf2c and later to compile f2c output
cp f2c.h0 f2c.h

# arith.h for wasm32: build arithchk with emcc, run under node
emcc -O0 -DNO_LONG_LONG -DNO_FPINIT arithchk.c -sEXIT_RUNTIME=1 -o arithchk.mjs
# A .mjs output is an ES module factory in pinned Emscripten 3.1.61; merely
# executing the file defines the factory but never runs arithchk's main().
node -e "import('./arithchk.mjs').then((module) => module.default())" > arith.h
echo "-- arith.h:"; cat arith.h

# signal1.h wanted by some members
cp signal1.h0 signal1.h 2>/dev/null || true
sed 's/^#define TYSUBROUTINE.*/#define TYSUBROUTINE 14/' -i sysdep1.h0 2>/dev/null || true
cp sysdep1.h0 sysdep1.h 2>/dev/null || true

# Build every .c we can; skip known process/unix-ism members outright.
SKIP='main.c getarg_.c iargc_.c signal_.c s_paus.c system_.c exit_.c abort_.c getenv_.c dtime_.c etime_.c pow_qq.c qbitbits.c qbitshft.c ftell64_.c'
rm -f *.o
ok=0; skipped=""
for c in *.c; do
  case " $SKIP " in *" $c "*) continue;; esac
  if emcc -O2 -DNON_UNIX_STDIO -c "$c" -o "${c%.c}.o" 2>/dev/null; then
    ok=$((ok+1))
  else
    skipped="$skipped $c"
  fi
done
emar rcs ../libf2c.a *.o
emranlib ../libf2c.a
echo "libf2c.a: $ok members$([ -n "$skipped" ] && echo "; failed->omitted:$skipped")"
cp f2c.h arith.h ..
