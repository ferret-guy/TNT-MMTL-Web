#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const {
  groundCurrentUsesSolvedMesh,
  microstripGroundCurrentDensityPerAmp,
  presetGroundCurrentDistribution,
  striplineGroundCurrentDensityPerAmp,
} = await import(
  pathToFileURL(join(root, 'src/analysis/groundCurrent.ts'))
);
const {
  presetReferencePlaneLossModel,
  referencePlaneModeValue,
  striplineReferencePlaneOverlapPerM,
} = await import(
  pathToFileURL(join(root, 'src/analysis/losses.ts'))
);
const { buildPreset, defaultParams } = await import(
  pathToFileURL(join(root, 'src/model/presets.ts'))
);
const { computeGeometry, computeViewport } = await import(
  pathToFileURL(join(root, 'src/ui/crossSection.ts'))
);
const {
  formatGroundCurrentPercent,
  groundCurrentAlignmentOffsetModelUnits,
  groundCurrentDisplayPeak,
  groundCurrentInterpolatedPercent,
  groundCurrentMagnitudePercent,
  groundCurrentSharedAmplitudePixels,
  groundCurrentSmoothedFaceMagnitudes,
  groundCurrentSurfaceFaceRuns,
  groundCurrentUnavailableLabel,
  groundCurrentXModelUnits,
} = await import(
  pathToFileURL(join(root, 'src/ui/groundCurrentPlot.ts'))
);
const { crossSectionProgressPresentation } = await import(
  pathToFileURL(join(root, 'src/ui/crossSectionProgress.ts'))
);
const { SolveProgressTracker } = await import(
  pathToFileURL(join(root, 'src/solver/solveProgress.ts'))
);

const UNIT_SCALE_M = 25.4e-6;

test('return-current progress suppresses the unavailable-state label', () => {
  assert.equal(
    groundCurrentUnavailableLabel({ suppressUnavailableMessage: true }),
    null,
  );
  assert.equal(
    groundCurrentUnavailableLabel({ unavailableMessage: 'Solve first.' }),
    'Solve first.',
  );
  assert.equal(
    groundCurrentUnavailableLabel({}),
    'Ground-current distribution is unavailable for this geometry.',
  );
});

test('guided presets retain continuous analytic plane-current profiles', () => {
  assert.equal(groundCurrentUsesSolvedMesh('preset', 'microstrip'), false);
  assert.equal(groundCurrentUsesSolvedMesh('preset', 'stripline'), false);
  assert.equal(groundCurrentUsesSolvedMesh('preset', 'cpw'), true);
  assert.equal(groundCurrentUsesSolvedMesh('freeform', 'microstrip'), true);
});

test('cross-section progress exposes indeterminate return-current work accessibly', () => {
  assert.deepEqual(
    crossSectionProgressPresentation('return-current'),
    {
      label: 'Calculating return-current density from the solved mesh...',
      indicator: 'progressbar',
      widthPercent: 100,
      ariaValueNow: null,
      ariaValueText: 'Calculating return-current density from the solved mesh...',
    },
  );
  assert.deepEqual(
    crossSectionProgressPresentation('complex-return-current'),
    {
      label: 'Calculating complex return-current mesh...',
      indicator: 'spinner',
      widthPercent: 100,
      ariaValueNow: null,
      ariaValueText: 'Calculating complex return-current mesh...',
    },
  );
});

test('cross-section progress clamps and rounds determinate field fractions', () => {
  const expected = [
    [-1, 0],
    [0, 0],
    [0.004, 0],
    [0.005, 1],
    [0.555, 56],
    [1, 100],
    [2, 100],
  ];
  for (const [fraction, percent] of expected) {
    assert.deepEqual(
      crossSectionProgressPresentation('field', fraction),
      {
        label: 'Computing potential field...',
        indicator: 'progressbar',
        widthPercent: percent,
        ariaValueNow: percent,
        ariaValueText: null,
      },
    );
  }
  assert.deepEqual(
    crossSectionProgressPresentation('field', Number.NaN),
    {
      label: 'Computing potential field...',
      indicator: 'progressbar',
      widthPercent: 100,
      ariaValueNow: null,
      ariaValueText: 'Computing potential field...',
    },
  );
});

test('cross-section progress markup exposes one labelled ARIA progressbar', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  for (const id of [
    'cs-progress',
    'cs-progress-track',
    'cs-progress-bar',
    'cs-progress-spinner',
    'cs-progress-label',
  ]) {
    assert.equal(
      (html.match(new RegExp(`id=["']${id}["']`, 'g')) ?? []).length,
      1,
      `${id} must occur exactly once`,
    );
  }
  const track = html.match(/<[^>]+id=["']cs-progress-track["'][^>]*>/)?.[0];
  assert.ok(track);
  assert.match(track, /role=["']progressbar["']/);
  assert.match(track, /aria-labelledby=["']cs-progress-label["']/);
  assert.match(track, /aria-valuemin=["']0["']/);
  assert.match(track, /aria-valuemax=["']100["']/);
  assert.doesNotMatch(track, /aria-valuenow=/);
  const label = html.match(/<[^>]+id=["']cs-progress-label["'][^>]*>/)?.[0];
  assert.ok(label);
  const liveRegion = html.match(/<[^>]+aria-live=["']polite["'][^>]*>/)?.[0];
  assert.ok(liveRegion);
  const spinner = html.match(/<[^>]+id=["']cs-progress-spinner["'][^>]*>/)?.[0];
  assert.ok(spinner);
  assert.match(spinner, /spinner-border/);
  assert.match(spinner, /aria-hidden=["']true["']/);
});

test('one-conductor MMTL transcript reports exact coarse solve milestones', () => {
  const tracker = new SolveProgressTracker();
  const transcript = [
    'bot_grnd_thck: 1  num_sig: 1  num_grounds: 2',
    '655 elements and 1316 nodes were generated',
    '  largest matrix to be inverted is 1316 X 1316',
    'Calculate LHS (assemble) matrix in free space',
    'calculate RHS (load) matrix for conductor 1',
    'Solve system of equations',
    'Integrate charge density',
    'Calculate LHS (assemble) matrix in dielectric',
    'calculate RHS (load) matrix for conductor 1',
    'Solve system of equations',
    'Integrate charge density',
    'MMTL is done',
  ];
  const events = transcript
    .map((line) => tracker.feed(line))
    .filter((event) => event !== null);

  assert.deepEqual(events, [
    { fraction: 0.04, phase: 'meshing' },
    { fraction: 0.05, phase: 'free-space-assembly' },
    { fraction: 0.45, phase: 'free-space-solves' },
    { fraction: 0.49, phase: 'free-space-solves' },
    { fraction: 0.50, phase: 'dielectric-assembly' },
    { fraction: 0.95, phase: 'dielectric-solves' },
    { fraction: 0.98, phase: 'finalizing' },
    { fraction: 1, phase: 'complete' },
  ]);
});

test('multi-conductor MMTL progress is monotonic through repeated solve phases', () => {
  const tracker = new SolveProgressTracker();
  const transcript = [
    'bot_grnd_thck: 1  num_sig: 3  num_grounds: 2',
    '900 elements and 1804 nodes were generated',
    'Calculate LHS (assemble) matrix in free space',
    'calculate RHS (load) matrix for conductor 1',
    'Solve system of equations',
    'Integrate charge density',
    'calculate RHS (load) matrix for conductor 2',
    'Solve system of equations',
    'Integrate charge density',
    'calculate RHS (load) matrix for conductor 3',
    'Solve system of equations',
    'Integrate charge density',
    'Calculate LHS (assemble) matrix in dielectric',
    'calculate RHS (load) matrix for conductor 1',
    'Solve system of equations',
    'Integrate charge density',
    'calculate RHS (load) matrix for conductor 2',
    'Solve system of equations',
    'Integrate charge density',
    'calculate RHS (load) matrix for conductor 3',
    'Solve system of equations',
    'Integrate charge density',
    'MMTL is done',
  ];
  const events = transcript
    .map((line) => tracker.feed(line))
    .filter((event) => event !== null);

  assert.deepEqual(events, [
    { fraction: 0.04, phase: 'meshing' },
    { fraction: 0.05, phase: 'free-space-assembly' },
    { fraction: 0.45, phase: 'free-space-solves' },
    { fraction: 0.45 + 0.04 / 3, phase: 'free-space-solves' },
    { fraction: 0.45 + 0.08 / 3, phase: 'free-space-solves' },
    { fraction: 0.49, phase: 'free-space-solves' },
    { fraction: 0.50, phase: 'dielectric-assembly' },
    { fraction: 0.95, phase: 'dielectric-solves' },
    { fraction: 0.96, phase: 'dielectric-solves' },
    { fraction: 0.97, phase: 'dielectric-solves' },
    { fraction: 0.98, phase: 'finalizing' },
    { fraction: 1, phase: 'complete' },
  ]);
  for (let index = 1; index < events.length; index++) {
    assert.ok(
      events[index].fraction >= events[index - 1].fraction,
      `progress regressed at event ${index}`,
    );
  }
  assert.equal(events.at(-1).phase, 'complete');
  assert.equal(events.at(-1).fraction, 1);
});

test('solve progress ignores unrelated output and suppresses duplicate milestones', () => {
  const tracker = new SolveProgressTracker();
  for (const line of [
    '',
    'largest matrix to be inverted is 1316 X 1316',
    'calculate RHS (load) matrix for conductor 1',
    'Solve system of equations',
    'Integrate charge density',
    '* Warning: lossTangent and frequency are not used in this simulation!',
  ]) {
    assert.equal(tracker.feed(line), null, line);
  }

  assert.deepEqual(
    tracker.feed('100 elements and 202 nodes were generated'),
    { fraction: 0.04, phase: 'meshing' },
  );
  assert.equal(
    tracker.feed('100 elements and 202 nodes were generated'),
    null,
  );
  assert.deepEqual(
    tracker.feed('Calculate LHS (assemble) matrix in free space'),
    { fraction: 0.05, phase: 'free-space-assembly' },
  );
  assert.equal(
    tracker.feed('Calculate LHS (assemble) matrix in free space'),
    null,
  );
  assert.deepEqual(
    tracker.feed('MMTL is done'),
    { fraction: 1, phase: 'complete' },
  );
  assert.equal(tracker.feed('MMTL is done'), null);
});

function assertNear(actual, expected, label, rel = 1e-8) {
  const tolerance = Math.max(1e-14, Math.abs(expected) * rel);
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} != ${expected} (tol ${tolerance})`,
  );
}

function surfaceElement(
  densities,
  { x0 = 0, y0 = 0, x1 = 1, y1 = 0 } = {},
) {
  return {
    samples: densities.map((densityAPerM, index) => {
      const fraction = densities.length > 1
        ? index / (densities.length - 1)
        : 0;
      return {
        xM: x0 + (x1 - x0) * fraction,
        yM: y0 + (y1 - y0) * fraction,
        nx: 0,
        ny: 1,
        densityAPerM,
      };
    }),
  };
}

function simpson(fn, low, high, requestedIntervals = 40000) {
  const intervals =
    requestedIntervals + (requestedIntervals % 2);
  const step = (high - low) / intervals;
  let sum = fn(low) + fn(high);
  for (let index = 1; index < intervals; index++) {
    sum += (index % 2 === 0 ? 2 : 4) * fn(low + index * step);
  }
  return sum * step / 3;
}

test('microstrip ground-current basis integrates to one ampere', () => {
  const widthM = 6 * UNIT_SCALE_M;
  const distanceM = 4 * UNIT_SCALE_M;
  const limit = widthM / 2 + 1000 * distanceM;
  const integral = simpson(
    (x) =>
      microstripGroundCurrentDensityPerAmp(
        x,
        0,
        widthM,
        distanceM,
      ),
    -limit,
    limit,
  );
  assertNear(integral, 1, 'microstrip current normalization', 7e-4);
});

test('single-ended displayed return current is positive', () => {
  const distribution = presetGroundCurrentDistribution(
    'microstrip',
    'se',
    defaultParams('microstrip', 'se'),
    UNIT_SCALE_M,
  );
  assert.ok(distribution);
  assert.equal(distribution.planes[0].netCurrentA, 1);
  assert.ok(
    distribution.planes[0].densityAPerM.every((density) => density >= 0),
  );
  const center = distribution.xM.findIndex((x) => x === 0);
  assert.ok(center >= 0);
  assert.ok(distribution.planes[0].densityAPerM[center] > 0);
});

test('current curves align with rendered conductors without horizontal stretching', () => {
  for (const variant of ['se', 'diff']) {
    const params = defaultParams('microstrip', variant);
    const distribution = presetGroundCurrentDistribution(
      'microstrip',
      variant,
      params,
      UNIT_SCALE_M,
    );
    assert.ok(distribution);
    const geometry = computeGeometry(
      buildPreset('microstrip', variant, params),
    );
    const viewport = computeViewport(geometry);
    const origin = groundCurrentAlignmentOffsetModelUnits(
      geometry,
      distribution,
      UNIT_SCALE_M,
    );
    assert.notEqual(origin, null);
    const conductors = geometry.polys
      .filter(
        (poly) =>
          poly.kind === 'conductor' &&
          !poly.isGroundConductor &&
          poly.signalIndex != null,
      )
      .sort((left, right) => left.signalIndex - right.signalIndex);
    for (let index = 0; index < conductors.length; index++) {
      const conductorCenter =
        (conductors[index].x0 + conductors[index].x1) / 2;
      const currentCenter = groundCurrentXModelUnits(
        distribution.signals[index].centerM,
        origin,
        UNIT_SCALE_M,
      );
      assertNear(
        currentCenter,
        conductorCenter,
        `${variant} model center ${index}`,
        1e-12,
      );
      assertNear(
        viewport.sx(currentCenter),
        viewport.sx(conductorCenter),
        `${variant} pixel center ${index}`,
        1e-12,
      );
    }

    const deltaModelUnits = 2.75;
    const leftCurrent = groundCurrentXModelUnits(
      0,
      origin,
      UNIT_SCALE_M,
    );
    const rightCurrent = groundCurrentXModelUnits(
      deltaModelUnits * UNIT_SCALE_M,
      origin,
      UNIT_SCALE_M,
    );
    assertNear(
      viewport.sx(rightCurrent) - viewport.sx(leftCurrent),
      viewport.sx(origin + deltaModelUnits) - viewport.sx(origin),
      `${variant} shared horizontal scale`,
      1e-12,
    );
  }
});

test('alignment rejects mismatched signals and supports non-mil model units', () => {
  const params = defaultParams('microstrip', 'diff');
  const distribution = presetGroundCurrentDistribution(
    'microstrip',
    'diff',
    params,
    UNIT_SCALE_M,
  );
  assert.ok(distribution);
  const geometry = computeGeometry(
    buildPreset('microstrip', 'diff', params),
  );
  assert.equal(
    groundCurrentAlignmentOffsetModelUnits(
      geometry,
      {
        ...distribution,
        signals: distribution.signals.slice(0, 1),
      },
      UNIT_SCALE_M,
    ),
    null,
  );
  assert.equal(
    groundCurrentXModelUnits(50e-6, 200, 1e-6),
    250,
  );
  assert.equal(groundCurrentMagnitudePercent(-2, 4), 50);
  assert.equal(groundCurrentMagnitudePercent(4, 4), 100);
  assert.equal(groundCurrentMagnitudePercent(0, 0), 0);
  assertNear(
    groundCurrentSharedAmplitudePixels([100, 20]),
    16,
    'shared plane amplitude',
  );
  assert.equal(groundCurrentSharedAmplitudePixels([1000, 500]), 450);
  assert.equal(groundCurrentSharedAmplitudePixels([5]), 1);
  assert.equal(groundCurrentSharedAmplitudePixels([3]), 0);
  assert.equal(groundCurrentSharedAmplitudePixels([]), 0);
});

test('alignment matches a reduced floating-pair mode by solver name', () => {
  const params = defaultParams('microstrip', 'diff');
  const distribution = presetGroundCurrentDistribution(
    'microstrip',
    'diff',
    params,
    UNIT_SCALE_M,
  );
  assert.ok(distribution);
  const geometry = computeGeometry(
    buildPreset('microstrip', 'diff', params),
  );
  const reducedDistribution = {
    ...distribution,
    signals: [{
      ...distribution.signals[0],
      label: geometry.signalNames[0],
    }],
  };
  const origin = groundCurrentAlignmentOffsetModelUnits(
    geometry,
    reducedDistribution,
    UNIT_SCALE_M,
  );
  assert.notEqual(origin, null);
  const driven = geometry.polys.find(
    (poly) => poly.kind === 'conductor' && poly.signalIndex === 0,
  );
  assert.ok(driven);
  assertNear(
    groundCurrentXModelUnits(
      reducedDistribution.signals[0].centerM,
      origin,
      UNIT_SCALE_M,
    ),
    (driven.x0 + driven.x1) / 2,
    'floating-pair driven-conductor alignment',
    1e-12,
  );
});

test('ground-current hover interpolates the rendered percent profile', () => {
  const x = [0, 1, 4];
  const percent = [0, 20, 80];
  assert.equal(groundCurrentInterpolatedPercent(0, x, percent), 0);
  assert.equal(groundCurrentInterpolatedPercent(1, x, percent), 20);
  assert.equal(groundCurrentInterpolatedPercent(2, x, percent), 40);
  assert.equal(groundCurrentInterpolatedPercent(4, x, percent), 80);
  assert.equal(groundCurrentInterpolatedPercent(-1, x, percent), null);
  assert.equal(groundCurrentInterpolatedPercent(5, x, percent), null);
  assert.equal(groundCurrentInterpolatedPercent(Number.NaN, x, percent), null);
  assert.equal(groundCurrentInterpolatedPercent(1, [0], []), null);
  assert.equal(groundCurrentInterpolatedPercent(1, [0, 0], [10, 20]), null);
  assert.equal(
    groundCurrentInterpolatedPercent(0.5, [0, 1], [0, 120]),
    60,
  );
});

test('ground-current percentages retain useful precision at each scale', () => {
  const cases = [
    [88, '88%'],
    [8.8, '8.8%'],
    [0.88, '0.88%'],
    [9.96, '10%'],
    [9.94, '9.9%'],
    [0.999, '1.0%'],
    [0.099, '0.10%'],
    [0.01, '0.01%'],
    [0.0099, '<0.01%'],
    [-0.0099, '<0.01%'],
    [0, '0%'],
    [-0, '0%'],
    [99.6, '100%'],
    [120, '100%'],
    [Number.NaN, '0%'],
    [Number.POSITIVE_INFINITY, '0%'],
  ];

  for (const [value, expected] of cases) {
    assert.equal(
      formatGroundCurrentPercent(value),
      expected,
      `format ${String(value)}`,
    );
  }
});

test('surface display smoothing suppresses quadrature ringing without mutation', () => {
  const elements = [
    surfaceElement([
      7.68,
      1.74,
      1.93,
      4,
      6.84,
      8.22,
      6.46,
      3.21,
    ], { x0: 0, x1: 1 }),
    surfaceElement([-20, 20, Number.NaN, Number.POSITIVE_INFINITY], {
      x0: 1,
      x1: 2,
    }),
    surfaceElement([100, 100], { x0: 2, x1: 3 }),
  ];
  const snapshot = structuredClone(elements);

  const smoothed = groundCurrentSmoothedFaceMagnitudes(elements);

  // Element medians are [5.23, 20, 100], followed by the face-local
  // triangular [1, 2, 1] / 4 filter with clamped endpoints.
  assertNear(smoothed[0], 8.9225, 'first filtered magnitude');
  assertNear(smoothed[1], 36.3075, 'middle filtered magnitude');
  assertNear(smoothed[2], 80, 'last filtered magnitude');
  assert.deepEqual(elements, snapshot);

  assert.deepEqual(
    groundCurrentSmoothedFaceMagnitudes([
      surfaceElement([-1, 1, 1, 100]),
    ]),
    [1],
  );
  assert.deepEqual(
    groundCurrentSmoothedFaceMagnitudes([
      surfaceElement([-1, 3]),
    ]),
    [2],
  );
  assert.deepEqual(
    groundCurrentSmoothedFaceMagnitudes([
      surfaceElement([Number.NaN, Number.NEGATIVE_INFINITY]),
    ]),
    [0],
  );
});

test('surface display filtering does not cross a right-angle corner', () => {
  const horizontalLow = surfaceElement([10, 10], {
    x0: 0,
    y0: 0,
    x1: 1,
    y1: 0,
  });
  const horizontalPeak = surfaceElement([1000, 1000], {
    x0: 1,
    y0: 0,
    x1: 2,
    y1: 0,
  });
  const verticalLow = surfaceElement([20, 20], {
    x0: 2,
    y0: 0,
    x1: 2,
    y1: 1,
  });
  const verticalLow2 = surfaceElement([20, 20], {
    x0: 2,
    y0: 1,
    x1: 2,
    y1: 2,
  });
  const elements = [
    horizontalLow,
    horizontalPeak,
    verticalLow,
    verticalLow2,
  ];
  const snapshot = structuredClone(elements);

  const runs = groundCurrentSurfaceFaceRuns(elements);

  assert.equal(runs.length, 2);
  assert.deepEqual(runs.map((run) => run.length), [2, 2]);
  assert.equal(runs[0][0], horizontalLow);
  assert.equal(runs[0][1], horizontalPeak);
  assert.equal(runs[1][0], verticalLow);
  assert.equal(runs[1][1], verticalLow2);
  assert.deepEqual(runs.flat(), elements);
  assert.deepEqual(
    runs.map(groundCurrentSmoothedFaceMagnitudes),
    [[257.5, 752.5], [20, 20]],
  );
  assert.deepEqual(elements, snapshot);
});

test('surface face runs isolate collinear physical gaps', () => {
  const near = surfaceElement([1, 1], { x0: 0, x1: 1 });
  const far = surfaceElement([100, 100], { x0: 10, x1: 11 });
  const runs = groundCurrentSurfaceFaceRuns([near, far]);

  assert.equal(runs.length, 2);
  assert.equal(runs[0][0], near);
  assert.equal(runs[1][0], far);
  assert.deepEqual(
    runs.map(groundCurrentSmoothedFaceMagnitudes),
    [[1], [100]],
  );
});

test('all current traces share the post-filter display peak', () => {
  const quietSurfaceElement = surfaceElement([1, 1, 1, 100]);
  const peakSurfaceElement = surfaceElement([8, 8]);
  const distribution = {
    mode: 'single-ended',
    normalizationLabel: '1 A signal current',
    xM: [0],
    planes: [{
      id: 'bottom',
      label: 'bottom',
      netCurrentA: 1,
      densityAPerM: [-7],
    }],
    signals: [{
      centerM: 0,
      widthM: 1,
      currentA: 1,
      label: 'signal',
    }],
    surfaces: [
      {
        id: 'quiet',
        label: 'quiet ground',
        netCurrentA: 0.25,
        elements: [quietSurfaceElement],
      },
      {
        id: 'peak',
        label: 'peak ground',
        netCurrentA: 0.75,
        elements: [peakSurfaceElement],
      },
    ],
  };
  const snapshot = structuredClone(distribution);

  const peak = groundCurrentDisplayPeak(distribution);

  // The isolated raw 100 A/m quadrature value collapses to a 1 A/m
  // element median. The second surface therefore supplies the one shared
  // 8 A/m denominator, while the plane remains on that same percent scale.
  assert.equal(peak, 8);
  assert.equal(groundCurrentMagnitudePercent(-7, peak), 87.5);
  assert.equal(groundCurrentMagnitudePercent(
    groundCurrentSmoothedFaceMagnitudes([quietSurfaceElement])[0],
    peak,
  ), 12.5);
  assert.equal(groundCurrentMagnitudePercent(
    groundCurrentSmoothedFaceMagnitudes([peakSurfaceElement])[0],
    peak,
  ), 100);
  assert.deepEqual(distribution, snapshot);

  assert.equal(groundCurrentDisplayPeak({
    ...distribution,
    planes: [],
    surfaces: [],
  }), 0);
});

test('ground-current view doubles only the lateral geometry span', () => {
  const params = defaultParams('microstrip', 'diff');
  const geometry = computeGeometry(
    buildPreset('microstrip', 'diff', params),
  );
  const normal = computeViewport(geometry);
  const current = computeViewport(geometry, 2);
  assertNear(
    current.vx1 - current.vx0,
    2 * (normal.vx1 - normal.vx0),
    'double current-view width',
    1e-12,
  );
  assert.equal(current.W, normal.W);
  assertNear(
    (current.vx0 + current.vx1) / 2,
    (normal.vx0 + normal.vx1) / 2,
    'current-view center',
    1e-12,
  );
  assert.equal(current.vy0, normal.vy0);
  assert.equal(current.vy1, normal.vy1);
});

test('microstrip current energy reproduces the reference-loss overlap matrix', () => {
  const params = {
    ...defaultParams('microstrip', 'diff'),
    w: 6,
    s: 5,
    h: 4,
    t: 1.4,
    etch: 0.5,
  };
  const distribution = presetGroundCurrentDistribution(
    'microstrip',
    'diff',
    params,
    UNIT_SCALE_M,
  );
  const model = presetReferencePlaneLossModel(
    'microstrip',
    'diff',
    params,
    UNIT_SCALE_M,
  );
  assert.ok(distribution);
  assert.ok(model);
  const [left, right] = distribution.signals;
  const distanceM = (params.h + params.t / 2) * UNIT_SCALE_M;
  const widthM = left.widthM;
  const limit =
    Math.abs(right.centerM) + widthM / 2 + 200 * distanceM;
  const energy = simpson((x) => {
    const qLeft = microstripGroundCurrentDensityPerAmp(
      x,
      left.centerM,
      widthM,
      distanceM,
    );
    const qRight = microstripGroundCurrentDensityPerAmp(
      x,
      right.centerM,
      widthM,
      distanceM,
    );
    return (qLeft - qRight) ** 2;
  }, -limit, limit);
  assertNear(
    energy,
    2 * referencePlaneModeValue(model.geometryPerM, 'odd'),
    'differential current energy',
    2e-7,
  );
});

test('differential ground current is antisymmetric with zero net current', () => {
  const distribution = presetGroundCurrentDistribution(
    'microstrip',
    'diff',
    defaultParams('microstrip', 'diff'),
    UNIT_SCALE_M,
  );
  assert.ok(distribution);
  assert.equal(distribution.mode, 'differential odd mode');
  assert.equal(distribution.planes[0].netCurrentA, 0);
  const { xM } = distribution;
  const density = distribution.planes[0].densityAPerM;
  for (let index = 0; index < xM.length; index++) {
    const opposite = xM.length - 1 - index;
    assertNear(xM[index], -xM[opposite], `x symmetry ${index}`, 1e-11);
    assertNear(
      density[index],
      -density[opposite],
      `Kret antisymmetry ${index}`,
      1e-10,
    );
  }
});

test('symmetric stripline splits the return equally across both planes', () => {
  const params = {
    ...defaultParams('stripline', 'se'),
    h: 8,
    h2: 8,
  };
  const distribution = presetGroundCurrentDistribution(
    'stripline',
    'se',
    params,
    UNIT_SCALE_M,
  );
  assert.ok(distribution);
  assert.equal(distribution.planes.length, 2);
  assertNear(
    distribution.planes[0].netCurrentA,
    0.5,
    'bottom-plane return share',
  );
  assertNear(
    distribution.planes[1].netCurrentA,
    0.5,
    'top-plane return share',
  );
  for (let index = 0; index < distribution.xM.length; index++) {
    assertNear(
      distribution.planes[0].densityAPerM[index],
      distribution.planes[1].densityAPerM[index],
      `equal plane density ${index}`,
    );
  }
});

test('stripline plane profiles integrate to their exact current shares', () => {
  const widthM = 6 * UNIT_SCALE_M;
  const bottomDistanceM = 5 * UNIT_SCALE_M;
  const topDistanceM = 9 * UNIT_SCALE_M;
  const heightM = bottomDistanceM + topDistanceM;
  const limit = widthM / 2 + 30 * heightM;
  const bottom = simpson(
    (x) =>
      striplineGroundCurrentDensityPerAmp(
        x,
        0,
        widthM,
        bottomDistanceM,
        heightM,
      ),
    -limit,
    limit,
  );
  const top = simpson(
    (x) =>
      striplineGroundCurrentDensityPerAmp(
        x,
        0,
        widthM,
        topDistanceM,
        heightM,
      ),
    -limit,
    limit,
  );
  assertNear(
    bottom,
    topDistanceM / heightM,
    'bottom-plane current share',
  );
  assertNear(
    top,
    bottomDistanceM / heightM,
    'top-plane current share',
  );
  assertNear(bottom + top, 1, 'total stripline return');
});

test('extremely wide stripline loss uses the exact plotted current energy', () => {
  const params = {
    ...defaultParams('stripline', 'se'),
    w: 1000,
    h: 0.05,
    h2: 0.1,
    t: 0.01,
    etch: 0,
  };
  const widthM = params.w * UNIT_SCALE_M;
  const bottomDistanceM =
    (params.h + params.t / 2) * UNIT_SCALE_M;
  const topDistanceM =
    (
      Math.max(params.h2 + params.t, params.t * 1.05) -
      params.t / 2
    ) * UNIT_SCALE_M;
  const heightM = bottomDistanceM + topDistanceM;
  const edge = widthM / 2;
  const transitionSpan = 20 * heightM;
  const energyAt = (x) => {
    const bottom = striplineGroundCurrentDensityPerAmp(
      x,
      0,
      widthM,
      bottomDistanceM,
      heightM,
    );
    const top = striplineGroundCurrentDensityPerAmp(
      x,
      0,
      widthM,
      topDistanceM,
      heightM,
    );
    return bottom * bottom + top * top;
  };
  // Integrate the broad uniform interior and both edge transitions
  // separately, so this regression remains independent of width/height.
  const spatialEnergy =
    simpson(
      energyAt,
      -edge - transitionSpan,
      -edge + transitionSpan,
      20000,
    ) +
    simpson(
      energyAt,
      -edge + transitionSpan,
      edge - transitionSpan,
      2000,
    ) +
    simpson(
      energyAt,
      edge - transitionSpan,
      edge + transitionSpan,
      20000,
    );
  const directOverlap = striplineReferencePlaneOverlapPerM(
    widthM,
    0,
    bottomDistanceM,
    topDistanceM,
  );
  const model = presetReferencePlaneLossModel(
    'stripline',
    'se',
    params,
    UNIT_SCALE_M,
  );
  assert.ok(model);
  assertNear(
    directOverlap,
    spatialEnergy,
    'wide-strip spatial overlap',
    2e-7,
  );
  assertNear(
    model.geometryPerM[0][0],
    spatialEnergy,
    'wide-strip loss/plot consistency',
    2e-7,
  );

  const lowerShare = topDistanceM / heightM;
  const upperShare = bottomDistanceM / heightM;
  const wideStripLimit =
    (lowerShare * lowerShare + upperShare * upperShare) / widthM;
  assertNear(
    spatialEnergy,
    wideStripLimit,
    'wide-strip asymptote',
    2e-4,
  );
});

test('coplanar geometry has no fabricated plane-current plot', () => {
  assert.equal(
    presetGroundCurrentDistribution(
      'cpw',
      'se',
      defaultParams('cpw', 'se'),
      UNIT_SCALE_M,
    ),
    null,
  );
});
