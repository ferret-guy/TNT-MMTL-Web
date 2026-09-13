# Eigen 3.4.0 source provenance

Official source: https://gitlab.com/libeigen/eigen/-/archive/3.4.0/eigen-3.4.0.tar.gz
Archive SHA-256: 8586084f71f9bde545ee7fa6d00288b264a2b7ac3607b974e54d13e7162c1c72

The Eigen/ headers and upstream COPYING files are vendored. Only Core and LU
are used; EIGEN_MPL2_ONLY excludes non-MPL2 modules from the compilation.

Local changes:
- ConfigureVectorization.h: do not include the x86-only MMX header on Emscripten.
  Emscripten supplies the SSE/SSE2 compatibility intrinsics used here.
- SSE/PacketMath.h: exclude legacy GCC x86 inline-assembly workarounds on
  Emscripten; use the existing intrinsic implementation instead.
- LU/PartialPivLU.h: under EIGEN_TNT_LU_PROGRESS, split trailing matrix updates
  into 64-column chunks and notify the caller after each completed chunk.
  The pivoting algorithm is unchanged. Without the macro, upstream behavior
  is retained. The application explicitly requests 64-column LU panels.

No fast-math or relaxed SIMD flags are used. Arithmetic grouping differs from
LINPACK, so numeric regression tests use tolerances rather than bit equality.
