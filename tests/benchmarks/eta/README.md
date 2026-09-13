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


## Existing device recordings

Previously collected device traces remain in `build/eta-devices/<run-id>/` and use the same raw format as local recordings. The LAN collector has been removed. Recordings retain browser and isolation metadata; plain HTTP LAN captures use serial WASM and do not validate threaded performance on other hardware.

Acceptance by actual duration: under 10 seconds is ungraded; 10-30 seconds allows up to 50% error; 30-60 seconds is informational; above 60 seconds uses stripline <10% and freeform <25% targets.

`ETA_TIME_SCALE` scales recorded clocks for a synthetic speed-adaptation check, not hardware validation.
