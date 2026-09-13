# Additional assembly optimizations and extreme-range validation

Implemented locally in both serial and threaded WASM:

- Cache quadrature weight times shape, retaining the existing multiplication order.
- Remove square roots that are immediately squared in dielectric derivative kernels. Conductor logarithmic kernels use half the logarithm of the squared-distance ratio, with the original expression as an overflow/underflow fallback.
- Reuse the free-space matrix LU for the dielectric RHS only when there are no dielectric-interface elements, node dimensions match, and every edge exponent matches. Unsupported transpose/BEM variants are excluded. This is reuse within a native solve, not between independent browser worker instances.
- Explicit reuse telemetry removes the skipped assembly/factorization from ETA work estimates without learning a near-zero rate for future nonuniform problems.

Singular self integration, mesh generation, quadrature order and precision are unchanged. Unlike the first geometry-cache stage, the square-root elimination can change floating-point rounding.

## Benchmark

Baseline: the previously geometry-cached solver, copied before these changes to `build/assembly-v2/baseline/wasm`.

78 paired native solves: 66 threaded and 12 serial (156 solver executions). Threaded coverage includes all six guided geometry/mode combinations, default, narrow, wide, tight-gap, asymmetric and air scenarios, plus all four recorded native passes for each of three freeform examples. There are 18 additional 90/90 refinements of the 45/45 narrow/wide/tight scenarios. Serial checks cover default and air cases for all six combinations.

Extreme guided inputs span width 0.6-80 mil, dielectric height 2-40 mil, trace thickness 0.1-2 mil, pair/CPW gaps 0.2-80 mil and relative permittivity 1-12. This is finite coverage, not exhaustive coverage of all user inputs or devices. It does not establish absolute physical accuracy or convergence at 400 segments.

Single paired wall-clock measurements, including module startup, on this device:

| Guided geometry | SE aggregate reduction | Differential aggregate reduction |
|---|---:|---:|
| Microstrip | 6.6% | 5.6% |
| Stripline | 45.7% | 49.1% |
| CPW | 5.7% | 6.9% |

Homogeneous stripline is approximately twice as fast. Across cases without reuse, median reduction is 3.3%. All 66 threaded cases together took 102.92 s before and 86.24 s after (16.2% less). These are native request times, not complete browser solve/view times; they are not a repeated statistical performance study.

## Numerical agreement and limitations

- Worst relative change in parsed electrical results (B, L, resistance, impedance, effective permittivity, velocity and delay): **4.43e-8**, or **0.00000443%**.
- Across all 18 refinement comparisons, the maximum electrical change caused by this optimization was less than 0.004% of the maximum electrical change from refining 45 to 90 segments.
- Crosstalk is compared as an absolute linear ratio because homogeneous-line far-end crosstalk cancels to nearly zero; its dB value is then dominated by rounding. Worst absolute linear change: **6.36e-9**.
- Fields are compared per solution and conductor/dielectric category as maximum absolute density difference divided by that category's peak magnitude. Worst change: **0.05491%** in tight-gap SE CPW at 90/90; differential tight-gap CPW was **0.01743%**.
- Those two cases exceed the initial strict field threshold of 0.001%; they remain explicitly flagged in the JSON summary. All electrical comparisons meet the 1e-7 relative threshold, and all crosstalk comparisons meet 1e-8 absolute. Field-distribution convergence has not been established by comparing different meshes.
- Some deliberately extreme geometries still need further mesh refinement: the very wide differential stripline changes impedance by about 1.9% between 45 and 90 segments. Agreement with the previous solver is not evidence that such a coarse mesh is physically converged.
- Serial checks: worst relative electrical change 1.49e-12, worst peak-normalized density change 4.46e-8; all initial tolerances passed.

Type checking, production build and 26 focused progress/ETA tests pass. Tests include explicit reuse telemetry and removal of only the repeated matrix costs.

## Recorded data and reproduction

`build/assembly-v2/extreme-results.json` contains every input, parsed electrical result, parsed field distribution and timestamped native log for both versions. `summary.json` contains the metrics and refinement comparisons. Serial data are under `build/assembly-v2/serial`. Build logs are also retained locally.

```text
node toolchain/benchmark-assembly-extremes.mjs
node toolchain/benchmark-assembly-extremes.mjs --serial --smoke
node toolchain/benchmark-assembly-extremes.mjs --replay-only
node toolchain/benchmark-assembly-extremes.mjs --serial --smoke --replay-only
```

Replay recomputes metrics from recorded data without running the solver. `--resume` reuses complete records and runs only missing cases. Reproduction needs the baseline assets and original freeform recordings in `build/eta-recordings`; these large local artifacts are not committed.
