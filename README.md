# TNT-Web — PCB trace impedance simulator in the browser

Design single-ended and differential PCB traces (microstrip, stripline,
coplanar waveguide, or a free-form TNT-style stackup) and simulate them
entirely in your browser. The field solver is **MMTL** — the Mayo Clinic
SPPDG *Multilayer Multiconductor Transmission Line* 2-D boundary-element
quasi-static solver from the [TNT](https://mmtl.sourceforge.net/) package
(GPL) — compiled to WebAssembly. No backend; nothing leaves the page.

![solver: MMTL BEM via WebAssembly](https://img.shields.io/badge/solver-MMTL%20BEM%20%2F%20WebAssembly-2b6cb0)

## Features

- **Presets**: microstrip / stripline / grounded-or-plain CPW, each
  single-ended or differential — with trapezoidal trace cross-section
  (etch factor), cover dielectric (solder mask), TNT's conductor/laminate
  material lists, and mesh controls (CSEG/DSEG).
- **Free-form stackup editor**: TNT's full object set — ground planes,
  dielectric layers, dielectric blocks, rectangle/trapezoid/circle conductor
  sets (with "ground wires" toggle), in any order.
- **Results**: Z₀ per line, odd/even/differential/common-mode impedance,
  effective εr, propagation velocity/delay, Maxwell capacitance and
  inductance matrices, R<sub>dc</sub>, near/far-end crosstalk.
- **Goal seek**: secant + bisection auto-tuning of trace width or pair gap
  to a target Z₀ / Z<sub>diff</sub> / Z<sub>odd</sub> / Z<sub>even</sub>
  (typically < 10 solves).
- **Loss vs frequency**: analytic W-element-style post-processing —
  R(f) = √(R²dc + (K·Rs√f)²) with Hammerstad–Jensen or Huray surface
  roughness, G(f) = 2πf·C·tanδ. (The BEM itself is quasi-static; TNT never
  had a roughness parameter — this layer adds it.)
- **Field views** on the main cross-section: potential heatmap with
  equipotentials, or E-field streamlines running from the driven trace to
  ground / the other conductor — reconstructed from the solver's boundary
  charges using its own grounded-half-plane image kernel; a
  conductor-interior probe check reports the reconstruction accuracy
  (typ. ~1%).
- **Shareable links**: the full configuration lives in the URL hash
  (kept in sync as you edit); the **Share** button copies a link that
  reopens the exact setup on any machine.

## Running

Any static file server can host `dist/`:

```bash
npm install
npm run build
npx vite preview          # or: python -m http.server -d dist
```

Dev server: `npm run dev`. No special headers needed (single-threaded wasm,
no COOP/COEP).

## Repository layout

| Path | What |
|---|---|
| `vendor/mmtl/bem/` | vendored MMTL BEM solver source (C++ + netlib FORTRAN) — see `PATCHES.md` for the six documented deviations from upstream |
| `toolchain/` | build scripts: native reference builds (gfortran, f2c) and the Emscripten build (`build-wasm.sh`), golden-fixture gates |
| `public/wasm/bem.mjs/.wasm` | the compiled solver (committed artifact) |
| `src/` | Vite + TypeScript app (Bootstrap 5, Atkinson Hyperlegible) |
| `tests/golden/` | node harness: wasm vs TNT's shipped `.result_save` fixtures |
| `tests/physics/` | closed-form sanity: Hammerstad-Jensen, Cohn stripline, IPC-2141 diff pairs, goal-seek convergence |

## Rebuilding the solver (WSL/Linux)

```bash
# one-time: apt install build-essential gfortran f2c; install emsdk 3.1.61
bash toolchain/rebuild-all.sh   # builds native+wasm, runs all golden gates
npm run golden                  # wasm vs fixtures (node)
npm run sanity                  # physics checks vs closed forms
```

The FORTRAN (47 netlib LINPACK/EISPACK/NSWC routines) is translated with
`f2c -R` — `-R` is load-bearing; see `toolchain/build-native-f2c.sh`. A
patched-LLVM-Flang alternative is documented in `toolchain/flang-fallback/`
(per [gws.phd/posts/fortran_wasm](https://gws.phd/posts/fortran_wasm/)).

## Validation

- **Golden gate**: all three builds (native gfortran, native f2c, wasm)
  reproduce TNT's 1999–2002 golden results for 9/10 shipped fixtures within
  1% (several to every printed digit); `w20t5`'s save is documented as stale
  (its own header shows a mis-parsed input; the fixture's coarse-mesh
  off-diagonals swing >20% with mesh density in any build).
- **wasm == native f2c to every printed digit** on all fixtures.
- **Physics sanity** (13 checks): microstrip vs Hammerstad-Jensen (≤4%),
  stripline vs Cohn (≤5%), differential pair vs IPC-2141 (≤10%), goal-seek
  convergence, and a regression test for the uncovered-trapezoid corner case
  fixed in `PATCHES.md` #4.

## Known limits

- The solver is quasi-static: no frequency-dependent R/L from the field
  solve itself (TNT's separate calcRL wavelet solver is not ported).
  Loss curves are analytic estimates on top of the static solution.
- Mesh caps at CSEG/DSEG = 100 in the UI; very fine meshes (400+) run but
  take minutes in wasm.
- Field-plot reconstruction quality is reported in the UI; geometries whose
  bottom ground plane is absent (plain CPW mode uses a distant plane) still
  satisfy the image-kernel assumption since the solver always images across
  y = 0.

## License

The vendored MMTL solver is GPL (Mayo Foundation, 2002–2004) — see
`vendor/mmtl/COPYING`. The web application code follows under GPL terms
accordingly.
