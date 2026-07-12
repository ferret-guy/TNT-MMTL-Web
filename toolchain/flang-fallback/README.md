# Flang-wasm fallback (not currently needed)

The production build translates the 47 netlib `.F` files with `f2c -R` and
links a wasm-built libf2c (`toolchain/build-wasm.sh`). That path is proven:
the wasm module reproduces the native f2c build to every printed digit and
passes the golden gate.

If f2c ever becomes a liability (e.g. source changes introduce Fortran
constructs f2c mishandles), the alternative is George Stagg's patched LLVM
Flang targeting `wasm32-unknown-emscripten`, per
https://gws.phd/posts/fortran_wasm/ — prebuilt toolchain published at
`ghcr.io/r-wasm/flang-wasm` (used by webR to build BLAS/LAPACK for wasm).

Sketch (Docker Desktop required):

```bash
# 1. compile the .F files with patched flang
docker run --rm -v "$PWD:/src" -w /src ghcr.io/r-wasm/flang-wasm:main bash -c '
  mkdir -p build/flang-obj
  for f in vendor/mmtl/bem/src/*.F; do
    b=$(basename "${f%.F}")
    /opt/flang/host/bin/flang-new --target=wasm32-unknown-emscripten -O2 \
      -c "$f" -o "build/flang-obj/$b.o"
  done'

# 2. link with the emscripten-built Fortran runtime instead of libf2c
em++ -O2 <cpp objects> build/flang-obj/*.o /opt/flang/wasm/lib/libFortranRuntime.a \
  -o public/wasm/bem.mjs <same -s flags as toolchain/build-wasm.sh>
```

ABI notes (both paths agree with the codebase's `-DFORTRAN_UNDERBARS`):
- symbol naming: trailing underscore (`sgefa_`)
- all arguments passed by reference
- REAL function results return `float` (matches our patched `extern "C" int`
  subroutine declarations; flang subroutines return void — if switching,
  revert patch #3 in PATCHES.md for the flang build or keep a shim)
- COMPLEX values: struct-of-two, 4-byte alignment

Keep the emcc `-s` link flags identical to `toolchain/build-wasm.sh`.
