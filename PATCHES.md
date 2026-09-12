# Patches to vendored MMTL/TNT source

The solver source under `vendor/mmtl/bem/` is based on `mmtl-tnt-master`
(`tnt-1.2.2`). This file summarizes the original WebAssembly-port changes;
later geometry robustness fixes are covered by the physics tests and Git
history.

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

## vendor/mmtl/bem/src/nmmtl_combine_die.cpp

7. **Dielectric interfaces are reclassified from the completed material
   geometry after the legacy top/bottom/side merge.** The original rectangle
   merger can leave zero-length or dielectric-to-air fragments between
   touching same-permittivity trapezoids. Those fragments make the BEM matrix
   singular when a rounded dielectric is represented by a small, contiguous
   trapezoid decomposition. The added pass samples both sides of each merged
   segment, removes zero-contrast/zero-length interfaces, and retains the
   physical material boundary. This supports the frontend's exact-bounds
   octagonal approximation for circular cable insulation without adding a new
   native file-format primitive.

## Debug instrumentation (inactive unless -DTNTWEB_GEOM_TRACE)

`nmmtl_intersections.cpp`, `nmmtl_det_intersections.cpp`, and
`nmmtl_eval_conductors.cpp` carry `#ifdef TNTWEB_GEOM_TRACE` stderr dumps of
segment/intersection state used to bisect native-vs-wasm divergences
(see build/repro/trace*.sh). Not compiled into production builds.

## Numerical recipe v1 (local integration)

The shared solver now uses double precision through geometry, matrix assembly,
linear algebra, and Fortran callbacks. The Fortran sources are translated with
`f2c -r8 -R`; the gfortran reference uses `-fdefault-real-8 -fdefault-double-8`.
All three build scripts rebuild every object, including when only a header has
changed. Double builds have separate intermediate directories. Rebuilds record
source/asset hashes in `public/wasm/build-info.json` and update the paired browser
asset revision automatically.

The integration includes accurate 24-point Gauss-Legendre quadrature, fourth-order
panel grading for straight conductor and dielectric segments, geometric element
midpoints, local-coordinate self-integrals/Jacobians, and the corrected second
endpoint exponent. Straight dielectric self-panels use their analytically zero
direct normal kernel; the image term is retained. This is appropriate for the
solver's straight dielectric panels, including polygonal approximations to
circular insulation, and is not a curved dielectric-panel formula.

Accurate pi and a 1e-12 angular tolerance protect material classification near
straight intersections. Vacuum constants consistently use c=299792458 m/s and
the conventional mu0=4*pi*1e-7 H/m, including the JavaScript explicit-reference
adapter used by arbitrary-object and floating-pair modes. Matrix, impedance,
effective-permittivity, odd/even, propagation, and crosstalk result values retain
17 significant digits. JavaScript current/field Jacobians and endpoint distances
also use local differences on tiny graded panels.

These shared corrections apply to every guided and free-form mode. The optional
cross-section header `set EDGE_SEGMENTS n0 n1 n2 n3` supplies validated per-edge
counts (2..1000) to four-edge polygons. It replaces the candidate's hard-coded
`/work/case.mesh` file. Other polygons reject this option; without it they retain
automatic edge allocation. Rectangle and circle primitives retain their own
geometry-appropriate allocation. Auxiliary mesh refinement scales explicit edge
counts as well as CSEG.

The guided single-microstrip Advanced panel offers **Refined mesh and wider
domain**: it starts CSEG/DSEG at 400, uses polygon edge fractions 0.1/0.4/0.1/0.4,
and multiplies the lateral margin by eight. It is optional and saved in links.
The interactive default remains 45 segments. Other modes can adjust their mesh
density without being assigned a four-edge recipe. The single-microstrip recipe's
sampled convergence evidence is not a certification of arbitrary geometries,
other trace families, or the different loss post-processing used by this app.

The original handoff patch had a malformed hunk and selected quadrature 32 even
though its selected recipe specified 24. Integration used the hash-verified source
snapshot, retained the standard `float.h` headers, and completed the constant and
output-precision changes. Historical vendor goldens remain unchanged: intentional
model/numerical changes should be evaluated using independent physics checks and
matched native/WASM comparisons, not by rewriting historical results blindly.
