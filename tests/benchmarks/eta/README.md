# Reusable ETA capture and offline tuning

Run commands from the repository root. Node >=23 and Python with NumPy are needed for fitting; Matplotlib is only needed for plots.

## Record once

`npm run benchmark:eta:record -- build/my-eta-recording`

Open the printed localhost URL and choose **Record missing cases**. The suite includes every About PCB example, every freeform example, all six guided geometry/mode combinations at 45 and 200 segments, and two 400-segment stress cases. Add `?cases=023,024,005` for an intentional integration-check subset.

The collector writes each completed case immediately. Restarting resumes missing cases. Existing files are not overwritten, and a changed source hash requires a new output directory. Failed solves are saved for diagnosis and rejected by the fitting validator.

Each recording includes exact inputs for every pass, planned pass roles, native output with worker timestamps, main-thread delivery timestamps, outputs, page start/end, and displayed samples. New captures also include unrounded displayed estimates. Source snapshots and hashes accompany the dataset. Field-plot text is not duplicated because it is unrelated to ETA; solver input, native timings, mesh metadata, progress counts and result matrices are retained.

## Replay without solving

For the default dataset:

```
npm run benchmark:eta:replay
npm run benchmark:eta:sweep
npm run benchmark:eta:report
```

For another directory:

```
python tests/benchmarks/eta/validate.py build/my-eta-recording
python tests/benchmarks/eta/fit.py build/my-eta-recording
node tests/benchmarks/eta/replay.mjs build/my-eta-recording
node tests/benchmarks/eta/sweep.mjs build/my-eta-recording 0.1,0.25,0.5,1,2,3
python tests/benchmarks/eta/report.py build/my-eta-recording
```

These commands never instantiate WebAssembly. `--allow-partial` permits validation of an intentional subset. Full tuning should use all 28 cases. The single smoothing parameter can also be supplied through `ETA_SETTLING` for an individual replay. `ETA_REPLAY_FILE` selects a derived output path relative to the recording directory.

Fitting only updates derived data by default. To explicitly replace the application's learned starting rates after reviewing validation, run `python tests/benchmarks/eta/fit.py build/my-eta-recording --write-model`. The default confidence time is `DEFAULT_SETTLING_SECONDS` in `src/solver/workEta.mjs`.

## Model and checks

The model has five fitted numbers: shared conductor-row assembly rate, shared dielectric-interface row rate, serial LU rate, Eigen LU rate, and one shared small overhead allowance. Assembly scales quadratically and factorization cubically. Rates are medians from measured work; there is no multivariable regression, first-pass correction, or per-geometry tuning. Uniform dielectric still incurs its second matrix assembly; an air pass has its own matrix dimensions. The old array-shaped model format is accepted only for replay compatibility.

Within a run, completed phases and observed row/pivot rates update the forecast. A shared settling time and a row-count confidence weight prevent the first slow row of a phase from controlling the entire forecast. No geometry name appears in the application estimator. Progress only advances on received work; timer ticks only update the ETA display.

Validation excludes an entire guided geometry/mode family, including its About examples and all mesh sizes, or an entire freeform example when fitting that family's prior. Future events of the test run are not visible to the estimator. This is development cross-validation, not an independent test set or a universal hardware guarantee.

Reports retain median, P90, maximum error, and finish-time corrections. Errors use total actual solve time as denominator and the middle 80% of elapsed time as the measurement window. Estimates are unrounded for algorithm comparisons; the application retains whole-second display formatting. The raw startup data remains available and is not included in a claim about middle-of-run accuracy.


## Other devices (HTTP LAN collector)

Run `npm run benchmark:eta:devices`. Open the printed LAN URL on each device, name the device, and choose **Start / resume benchmark**. Keep the benchmark visible. The page uploads each case automatically. **Device results** opens the central live report. **New run** starts a separate recording without replacing older data.

Plain HTTP on non-localhost origins disables SharedArrayBuffer in ordinary browsers, so those runs use serial WASM. Localhost can use the threaded/Eigen backend. The recordings retain isolation status, browser, logical CPU count, visibility interruptions, every native event, and exact inputs. Compare like backends; HTTP results do not validate the threaded path on other hardware.

The server binds port 5182 and serves a frozen copy of the production build. It keeps device runs in `build/eta-devices/<run-id>/`, with source snapshots and build hashes. Its connection token is scoped to this collector and persists across restarts. It does not serve arbitrary workspace files. The raw case files use the same format as the local replay tool. Validate a device directory, extract it, and replay with fixed reference rates to measure transfer; fitting on the target device first is calibration, not held-out device validation.

Acceptance by actual duration: under 10 seconds is ungraded; 10-30 seconds allows up to 50% error; 30-60 seconds is informational; above 60 seconds uses the stripline <10% and freeform <25% targets. All raw errors remain available. This dataset contains no >60-second stripline run on the original machine; that target still needs sufficiently slow/device stress measurements.

`ETA_TIME_SCALE` optionally scales all recorded clocks for a synthetic speed-adaptation check. This does not reproduce another device's kernel ratios, thread count, thermal throttling, or browser scheduling, and is not hardware validation.
