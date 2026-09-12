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

## Solver and license

The solver is [MMTL](https://mmtl.sourceforge.net/) from the Mayo Special
Purpose Processor Development Group, compiled to WebAssembly. This project is
GPL-2.0-or-later; see `vendor/mmtl/COPYING`. Vendored solver changes are
summarized in `PATCHES.md`.
