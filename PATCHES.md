# Patches to vendored MMTL/TNT source

The solver source under `vendor/mmtl/bem/` is vendored from `mmtl-tnt-master`
(byte-identical to the `tnt-1.2.2` release for everything under `bem/`).
Every deviation from pristine upstream is logged here.

## vendor/mmtl/bem/src/magicad.h

1. **Line ~103**: `#include <iostream.h>` → `#include <iostream>` + `using namespace std;`
   The pre-standard header was removed in GCC 6+/clang/Emscripten. The code uses
   unqualified `ostream` in inline operators, hence the using-directive.
2. **Line ~135**: removed `#include <rw/defs.h>` (Rogue Wave Tools.h++, commercial).
   No compiled translation unit references any Rogue Wave symbol; the only mentions
   are in headers that are never included by the `bem` target
   (`node_database.h`, `DesignData.h`) and a harmless forward declaration in
   `general_prototype.h`.

## vendor/mmtl/bem/src/math_library.h and nmmtl_find_nu.cpp

3. **FORTRAN extern declarations `void` → `int`** for the 13 routines declared
   in `math_library.h` (FFT, CEIGV, CMTMS, MTMS, CMSLV1, MSLV, DMSLV, DCMSLV,
   SGEFA, SGECO, SGESL, DGEFA, DGESL) and `FMIN` in `nmmtl_find_nu.cpp`.
   f2c-translated FORTRAN subroutines return `int` (always 0). Declaring them
   `void` is tolerated by native x86 ABIs but is a *function signature
   mismatch* on WebAssembly: wasm-ld replaces such direct calls with trap
   stubs, so the solver would abort at the first LU factorization. Calling an
   int-returning function and ignoring the result is valid everywhere, so the
   `int` declarations are correct for gfortran builds too.

## vendor/mmtl/bem/src/nmmtl_angle_of_intersection.cpp

4. **Angle computation rewritten from `acos(dot/(|a||b|))` to `atan2(cross, dot)`.**
   The acos form is ill-conditioned near anti-parallel vectors, and callers
   (`nmmtl_det_intersections.cpp`) guard the straight-through case with exact
   `turn_angle < PI` comparisons. glibc and Emscripten's libm/overload
   resolution differ by an ulp there, so under WebAssembly an uncovered
   trapezoid's bottom corner "turn" came out just under π, stealing the
   air-side epsilon for the conductor's bottom face (Z₀ 82 Ω instead of 52 Ω,
   εeff ~1.2 instead of ~3.0). `atan2(cross, dot)` returns exactly ±π for
   anti-parallel vectors on every IEEE libm, so the guards exclude the case
   deterministically. Verified: native gfortran, native f2c, and wasm builds
   agree to every printed digit on uncovered rectangle and trapezoid cases,
   and all golden gates still pass.

## vendor/mmtl/bem/src/nmmtl_write_plot_data.cpp

5. **Field-plot file additions**: each conductor element also prints
   `Epsilon: <e>` and each dielectric element `EpsilonPM: <e+> <e->`.
   Used by the web field renderer and for geometry debugging; TNT's original
   post-processor is not part of this project, and the harness parsers skip
   unknown lines.

## vendor/mmtl/bem/src/nmmtl.cpp

6. **`fclose(plotFile)` added at the end of `main`.** Upstream never closed
   the field-plot file and relied on `exit()` flushing stdio; under
   Emscripten with `EXIT_RUNTIME=0` nothing flushes, so the plot data was
   truncated mid-line. `.result` and the dump file were already closed
   explicitly.

## vendor/mmtl/calcRL/src/calcRL.cpp

7. **argv off-by-ones**: upstream tested `argc > 0` / `argc > 1` before
   dereferencing `argv[1]` / `argv[2]` (argc counts argv[0]), crashing when
   run with one argument. Corrected to `argc > 1` / `argc > 2`.
8. **Resistance matrix truncated in the .out file**: an xmgr-export block sat
   inside the resistance-row loop and reused its `i2` loop variable, so only
   the first matrix row was ever written (the shipped `jc.out_save` predates
   the bug). The block now runs once, after the loop. Restored output matches
   the 2004 golden to every printed digit.

## Debug instrumentation (inactive unless -DTNTWEB_GEOM_TRACE)

`nmmtl_intersections.cpp`, `nmmtl_det_intersections.cpp`, and
`nmmtl_eval_conductors.cpp` carry `#ifdef TNTWEB_GEOM_TRACE` stderr dumps of
segment/intersection state used to bisect native-vs-wasm divergences
(see build/repro/trace*.sh). Not compiled into production builds.

No other source file is modified. FORTRAN `.F` files are consumed as-is
(translated by `f2c -R` at build time; see `toolchain/`).
