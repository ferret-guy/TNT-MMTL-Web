# Web-MMTL

Browser-based PCB transmission-line solver for single-ended and differential
microstrip, stripline, coplanar, and free-form cross-sections. The 2-D
quasi-static field solve runs locally, and configurations can be shared by URL.

## Run

```sh
npm ci
npm run dev
```

## Check and build

```sh
npm test
npm run build
```

Serve `dist/` with any static host, or run `npm run preview`.

## Numerical solver update

The shared double-precision solver and 24-point quadrature apply to all guided
and free-form modes. Single-ended microstrip also has an optional **Advanced →
Refined mesh and wider domain** control. It starts at 400 segments and may take
minutes per solve. Other modes retain geometry-appropriate meshing; increase
their segment counts to check convergence. See `PATCHES.md` for the scope and
limitations of the numerical recipe.

With the existing WSL Emscripten/f2c/gfortran toolchain, rebuild using:

```sh
bash toolchain/build-wasm.sh
bash toolchain/build-native-f2c.sh
bash toolchain/build-native-gfortran.sh
```

The WASM build updates browser asset hashes automatically. Native executables
are written to `build/native-f2c-double-q24-v1/bem` and
`build/native-gfortran-double-q24-v1/bem`. The local integration backup and
before/after evidence are under `build/numerical-v1/`.

## Parallel matrix assembly

Large solves use up to four WebAssembly pthreads for free-space and dielectric
matrix assembly. The threaded asset also uses Eigen 3.4.0 blocked LU with
WebAssembly SIMD; factorization runs on one thread. Small meshes retain the serial
solver to avoid thread-pool startup overhead. Threads own disjoint matrix columns,
including shared endpoint nodes, preserving each entry's accumulation order.

Build both assets with the existing Emscripten toolchain:

```sh
bash toolchain/build-wasm.sh
TNTWEB_PTHREADS=1 bash toolchain/build-wasm.sh
node toolchain/check-optimized-lu-parity.mjs
```

Vite development and preview servers supply the required COOP/COEP headers.
Production hosts must send `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` to enable threading. Hosts without
cross-origin isolation, including ordinary GitHub Pages, use the serial asset.
The serial asset retains LINPACK and requires no SIMD. Set
`TNTWEB_OPTIMIZED_LU=0` when building to reproduce the older factorization.
Both variants must remain under `wasm/` in the deployed output. Completed solves
release their pthread pools; cancellation terminates the containing solver worker.

Local 400-segment measurements and progress replay checks are in
`build/parallel-assembly/`. Run `toolchain/benchmark-parallel-assembly.mjs` with
its saved pre-change baseline to reproduce the comparison.

## Solver and license

The solver is [MMTL](https://mmtl.sourceforge.net/) from the Mayo Special
Purpose Processor Development Group, compiled to WebAssembly. This project is
GPL-2.0-or-later; see `vendor/mmtl/COPYING`. Vendored solver changes are
summarized in `PATCHES.md`.

### Optimized LU validation

The local benchmark and numeric comparisons are under `build/optimized-lu/`.
`toolchain/benchmark-optimized-lu.mjs` compares against its saved four-worker
LINPACK baseline. `toolchain/check-optimized-lu-parity.mjs` compares the shipped
serial and threaded assets, including electrical results and sampled potentials.
A validation-only build (`TNTWEB_LU_VALIDATE=1`) retains the original dense
matrix to measure backward error; this extra memory is not used in normal builds.
Eigen provenance, licenses, and compatibility/progress changes are recorded in
`vendor/eigen-3.4.0/TNT-PATCHES.md`.
