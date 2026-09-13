# Assembly geometry cache

This records the first optimization stage. See [assembly-extremes.md](assembly-extremes.md) for the subsequent kernel and matrix-reuse changes and their separate accuracy measurements.

Caches source-element coordinates, shape functions (including edge exponents), and Jacobians at the unchanged 24-point inner quadrature rule. Target-dependent Green functions and singular self integrals are unchanged. Each assembly worker owns its own cache, cleared on scope entry and exit. This preserves accumulation order and prevents reuse across changed meshes or dielectric/free-space exponents.

The change applies to both serial and threaded WASM builds. The cache is inactive outside assembly; existing interval calls retain the original path.

## Validation

Paired old/new builds, using the saved 45/45 benchmark inputs: all six guided modes and three freeform examples, including every air and loss-participation pass. 24 threaded pass pairs plus two serial CPWG pass pairs. Parsed numerical results and complete field output files compare exactly. Single paired timings are indicative, not a hardware-wide performance guarantee.

| Case | Backend | Assembly before | Assembly after | Time reduction |
|---|---|---:|---:|---:|
| Guided cpw se | threaded | 2.828 s | 2.355 s | 16.7% |
| Guided cpw diff | threaded | 5.065 s | 4.406 s | 13.0% |
| Guided microstrip se | threaded | 0.963 s | 0.712 s | 26.1% |
| Guided microstrip diff | threaded | 1.603 s | 1.228 s | 23.4% |
| Guided stripline se | threaded | 1.026 s | 0.873 s | 14.9% |
| Guided stripline diff | threaded | 2.447 s | 2.030 s | 17.0% |
| Belden 9R280 G-S-G ribbon benchmark | threaded | 6.504 s | 5.455 s | 16.1% |
| Belden 9R280 five-signal wide ribbon | threaded | 22.652 s | 20.373 s | 10.1% |
| Belden Cat5e pair | threaded | 5.274 s | 4.207 s | 20.2% |
| Guided cpw se | serial | 5.661 s | 4.497 s | 20.6% |

## Reproduce

Before rebuilding, copy the previous `public/wasm` directory to `build/assembly-cache/baseline/wasm`. Keep the original raw recordings in `build/eta-recordings`. Rebuild both WASM variants, then run:

```text
node toolchain/benchmark-assembly-cache.mjs
node toolchain/benchmark-assembly-cache.mjs 012 serial
```

The first optional argument is a comma-separated list of recorded case IDs; the second is the backend (`threaded` or `serial`). Per-pass timings, outputs, and native events are saved under `build/assembly-cache`.
