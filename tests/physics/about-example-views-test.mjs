#!/usr/bin/env node
/**
 * Cross-section view regression for every calculator example exposed by
 * about.html.  Browser DOM painting is covered by the live UI smoke test; this
 * file exercises the exact production geometry, potential-grid, vector-path,
 * and return-current view models that feed those four rendered tabs.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Importing store.ts creates its browser store singleton.
globalThis.window = { location: { hash: '' } };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const { FREEFORM_EXAMPLES_BY_ID } = await import(
  '../../src/model/freeformExamples.ts'
);
const { currentStackup, decodeHash, defaultState } = await import(
  '../../src/model/store.ts'
);
const {
  isExplicitReferenceStackup,
  prepareExplicitReferenceStackup,
  reduceExplicitReferenceResults,
} = await import('../../src/analysis/explicitReference.ts');
const { transformExplicitReferenceFieldText } = await import(
  '../../src/analysis/explicitReferenceField.ts'
);
const {
  freeSpaceStackup,
  meshExplicitReferenceAnalysis,
  meshGroundCurrentDistribution,
  meshReferenceAnalysis,
} = await import('../../src/analysis/meshReferenceLoss.ts');
const {
  groundCurrentUsesSolvedMesh,
  presetGroundCurrentDistribution,
} = await import('../../src/analysis/groundCurrent.ts');
const {
  computeGeometry,
  computeViewport,
  VIEWPORT_PAD,
} = await import('../../src/ui/crossSection.ts');
const {
  contourPaths,
  streamlinePaths,
} = await import('../../src/ui/fieldView.ts');
const {
  groundCurrentAlignmentOffsetModelUnits,
  groundCurrentDisplayPeak,
  groundCurrentMagnitudePercent,
  groundCurrentSmoothedFaceMagnitudes,
  groundCurrentSurfaceFaceRuns,
} = await import('../../src/ui/groundCurrentPlot.ts');
const { computeGrid, calibrate, prepElements } = await import(
  '../../src/field/potential.ts'
);
const { parseFieldPlot } = await import(
  '../../src/solver/parseFieldPlot.mjs'
);
const { parseResult } = await import('../../src/solver/parseResult.mjs');
const { generateXsctn, validateStackup } = await import(
  '../../src/xsctn/generate.ts'
);
const createBemModule = (
  await import(new URL('../../public/wasm/bem.mjs', import.meta.url).href)
).default;

const UNIT_SCALE_M = Object.freeze({
  mils: 25.4e-6,
  mm: 1e-3,
});
const aboutHtml = await readFile(
  new URL('../../about.html', import.meta.url),
  'utf8',
);

function decodeHtmlAttribute(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&#38;', '&')
    .replaceAll('&#x26;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

function attribute(tag, name) {
  const match = tag.match(
    new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'),
  );
  return match ? decodeHtmlAttribute(match[2]) : null;
}

function anchors(fragment) {
  return [...fragment.matchAll(/<a\b[^>]*>/gi)].map(([tag]) => ({
    href: attribute(tag, 'href'),
    freeformId: attribute(tag, 'data-freeform-example'),
  }));
}

function stateFromHref(href, label) {
  assert.equal(typeof href, 'string', `${label} has no href`);
  const hashIndex = href.indexOf('#');
  assert.ok(hashIndex >= 0, `${label} has no calculator hash`);
  const decoded = decodeHash(href.slice(hashIndex));
  assert.ok(decoded, `${label} did not decode`);
  const defaults = defaultState();
  return {
    ...defaults,
    ...decoded,
    presetParams: {
      ...defaults.presetParams,
      ...(decoded.presetParams ?? {}),
    },
    freeform: {
      ...defaults.freeform,
      ...(decoded.freeform ?? {}),
    },
    lossParams: {
      ...defaults.lossParams,
      ...(decoded.lossParams ?? {}),
    },
    lastSolve: null,
    solving: false,
  };
}

function examplesFromAboutPage() {
  const staticExamples = anchors(aboutHtml)
    .filter(({ href }) => href?.includes('#v='))
    .map(({ href }, index) => ({
      label: `About PCB model ${index + 1}`,
      state: stateFromHref(href, `About PCB model ${index + 1}`),
    }));
  assert.ok(staticExamples.length > 0, 'About page has no static PCB models');

  const freeformIds = [
    ...new Set(
      anchors(aboutHtml)
        .map(({ freeformId }) => freeformId)
        .filter(Boolean),
    ),
  ];
  assert.deepEqual(
    [...freeformIds].sort(),
    Object.keys(FREEFORM_EXAMPLES_BY_ID).sort(),
    'About free-form links and shared fixtures must stay in sync',
  );
  const freeformExamples = freeformIds.map((id) => {
    const example = FREEFORM_EXAMPLES_BY_ID[id];
    assert.ok(example, `unknown About free-form model ${id}`);
    return {
      label: example.title,
      state: stateFromHref(example.href, example.title),
    };
  });
  return [...staticExamples, ...freeformExamples];
}

async function solveNative(stackup, caseName) {
  const stdout = [];
  const mod = await createBemModule({
    print: (line) => stdout.push(line),
    printErr: (line) => stdout.push(line),
  });
  mod.FS.mkdir('/work');
  mod.FS.writeFile(`/work/${caseName}.xsctn`, generateXsctn(stackup));
  mod.FS.chdir('/work');
  let exitCode = 0;
  try {
    exitCode = mod.callMain([
      `/work/${caseName}`,
      String(stackup.cseg),
      String(stackup.dseg),
    ]);
  } catch (error) {
    if (error?.name === 'ExitStatus') exitCode = error.status;
    else throw error;
  }
  const log = stdout.join('\n');
  assert.equal(exitCode ?? 0, 0, `${caseName}: ${log}`);
  assert.match(log, /MMTL is done/, `${caseName}: ${log}`);
  const resultText = mod.FS.readFile(
    `/work/${caseName}.result`,
    { encoding: 'utf8' },
  );
  const fieldText = mod.FS.readFile(
    `/work/${caseName}.result_field_plot_data`,
    { encoding: 'utf8' },
  );
  return {
    ok: true,
    exitCode: exitCode ?? 0,
    stdout: log,
    resultText,
    fieldText,
    elapsedMs: 0,
    result: parseResult(resultText),
  };
}

async function solveViewModel(example, index) {
  const stackup = currentStackup(example.state);
  assert.deepEqual(
    validateStackup(stackup),
    [],
    `${example.label} has invalid solver geometry`,
  );
  const explicit = isExplicitReferenceStackup(stackup);
  if (explicit) {
    const preparation = prepareExplicitReferenceStackup(stackup);
    const primary = await solveNative(
      preparation.solverStackup,
      `view-${index + 1}-primary`,
    );
    const airStackup = freeSpaceStackup(preparation.solverStackup);
    const air = generateXsctn(airStackup) === generateXsctn(preparation.solverStackup)
      ? primary
      : await solveNative(airStackup, `view-${index + 1}-air`);
    const reduction = reduceExplicitReferenceResults(
      preparation,
      primary.result,
      air.result,
    );
    const fieldText = transformExplicitReferenceFieldText(
      primary.fieldText,
      preparation,
      reduction,
    );
    const mesh = meshExplicitReferenceAnalysis(
      stackup,
      air,
      preparation,
      reduction,
    );
    return {
      ...example,
      stackup,
      explicit,
      result: reduction.result,
      fieldText,
      currentBasis: mesh.currentBasis,
    };
  }

  const primary = await solveNative(stackup, `view-${index + 1}-primary`);
  let currentBasis = null;
  if (
    groundCurrentUsesSolvedMesh(
      example.state.mode,
      example.state.presetKind,
    )
  ) {
    const airStackup = freeSpaceStackup(stackup);
    const air = generateXsctn(airStackup) === generateXsctn(stackup)
      ? primary
      : await solveNative(airStackup, `view-${index + 1}-air`);
    currentBasis = meshReferenceAnalysis(stackup, air).currentBasis;
  }
  return {
    ...example,
    stackup,
    explicit,
    result: primary.result,
    fieldText: primary.fieldText,
    currentBasis,
  };
}

function finiteNumber(value, label) {
  assert.ok(Number.isFinite(value), `${label} is not finite: ${value}`);
}

function assertGeometryView(model) {
  const geometry = computeGeometry(model.stackup);
  assert.ok(geometry.polys.length > 0, `${model.label} has no drawn geometry`);
  assert.ok(geometry.domainX1 > geometry.domainX0, model.label);
  assert.ok(geometry.yMax >= geometry.yTop, model.label);
  const conductorPolys = geometry.polys.filter(
    (poly) => poly.kind === 'conductor',
  );
  assert.ok(conductorPolys.length > 0, `${model.label} draws no conductors`);
  for (const [polyIndex, poly] of geometry.polys.entries()) {
    assert.ok(poly.pts.length >= 3, `${model.label} polygon ${polyIndex}`);
    assert.ok(poly.x1 >= poly.x0 && poly.y1 >= poly.y0, model.label);
    for (const [pointIndex, point] of poly.pts.entries()) {
      finiteNumber(point[0], `${model.label} polygon ${polyIndex} x${pointIndex}`);
      finiteNumber(point[1], `${model.label} polygon ${polyIndex} y${pointIndex}`);
    }
  }

  const equalAxis =
    model.state.mode === 'freeform' &&
    model.stackup.items.some(
      (item) =>
        item.kind === 'CircleConductors' || item.kind === 'CircleDielectric',
    );
  const viewport = computeViewport(geometry, 1, equalAxis);
  for (const key of ['vx0', 'vx1', 'vy0', 'vy1', 'W', 'H']) {
    finiteNumber(viewport[key], `${model.label} viewport ${key}`);
  }
  assert.ok(viewport.vx1 > viewport.vx0, model.label);
  assert.ok(viewport.vy1 > viewport.vy0, model.label);
  assert.ok(viewport.W > 0 && viewport.H > 0, model.label);
  assert.ok(
    Math.abs(viewport.sx(viewport.vx0) - viewport.W * VIEWPORT_PAD) < 1e-8,
    `${model.label} x viewport transform`,
  );
  assert.ok(
    Math.abs(
      viewport.sy(viewport.vy0) - viewport.H * (1 - VIEWPORT_PAD),
    ) < 1e-8,
    `${model.label} y viewport transform`,
  );
  if (equalAxis) {
    const xPixelsPerUnit = Math.abs(viewport.sx(1) - viewport.sx(0));
    const yPixelsPerUnit = Math.abs(viewport.sy(1) - viewport.sy(0));
    assert.ok(
      Math.abs(xPixelsPerUnit - yPixelsPerUnit) <=
        Math.max(xPixelsPerUnit, yPixelsPerUnit) * 1e-10,
      `${model.label} circular geometry is not displayed at 1:1 scale`,
    );
  }
  for (const poly of geometry.polys) {
    for (const [x, y] of poly.pts) {
      finiteNumber(viewport.sx(x), `${model.label} rendered polygon x`);
      finiteNumber(viewport.sy(y), `${model.label} rendered polygon y`);
    }
  }
  return { geometry, viewport, equalAxis };
}

function fieldViewInputs(model, geometry, viewport) {
  const unitScaleM = UNIT_SCALE_M[model.stackup.units];
  assert.ok(unitScaleM > 0, `${model.label} has unsupported view units`);
  const bbox = {
    x0: viewport.vx0 * unitScaleM,
    x1: viewport.vx1 * unitScaleM,
    y0: viewport.vy0 * unitScaleM,
    y1: viewport.vy1 * unitScaleM,
  };
  const masks = [
    ...(!model.explicit
      ? [{
          x0: bbox.x0 - 1,
          y0: bbox.y0 - 1,
          x1: bbox.x1 + 1,
          y1: 0,
        }]
      : []),
    ...geometry.polys
      .filter((poly) => poly.kind === 'ground')
      .map((poly) => ({
        x0: poly.x0 * unitScaleM,
        y0: poly.y0 * unitScaleM,
        x1: poly.x1 * unitScaleM,
        y1: poly.y1 * unitScaleM,
      })),
  ];
  const maskPolys = geometry.polys
    .filter((poly) => poly.kind === 'conductor')
    .map((poly) => poly.pts.map(
      ([x, y]) => [x * unitScaleM, y * unitScaleM],
    ));
  return { unitScaleM, bbox, masks, maskPolys };
}

function assertFieldViews(model, geometry, viewport) {
  const solutions = parseFieldPlot(model.fieldText);
  assert.deepEqual(
    solutions.map((solution) => solution.line),
    model.result.names,
    `${model.label} field bases do not match solver port order`,
  );
  assert.ok(solutions.length > 0, `${model.label} has no field solutions`);
  for (const [solutionIndex, solution] of solutions.entries()) {
    assert.ok(
      solution.elements.length > 0,
      `${model.label} field ${solutionIndex + 1} has no boundary mesh`,
    );
    for (const [elementIndex, element] of solution.elements.entries()) {
      assert.equal(element.x.length, 3, model.label);
      assert.equal(element.y.length, 3, model.label);
      assert.equal(element.sigma.length, 3, model.label);
      assert.ok(
        [...element.x, ...element.y, ...element.sigma].every(Number.isFinite),
        `${model.label} field ${solutionIndex + 1} element ${elementIndex + 1} is non-finite`,
      );
    }
    const calibration = calibrate(prepElements(solution), {
      imagePlaneYM: solution.imagePlaneYM,
      calibrationMode: solution.calibrationMode,
    });
    finiteNumber(calibration.a, `${model.label} calibration scale`);
    finiteNumber(calibration.b, `${model.label} calibration offset`);
    finiteNumber(calibration.maxResidual, `${model.label} calibration residual`);
    assert.ok(
      Math.abs(calibration.a) > Number.EPSILON,
      `${model.label} field ${solutionIndex + 1} has a singular calibration`,
    );
    assert.ok(
      calibration.maxResidual < 0.35,
      `${model.label} field ${solutionIndex + 1} boundary residual is ${(100 * calibration.maxResidual).toFixed(1)}%`,
    );
  }

  // The UI only reconstructs the selected driven line.  Render its exact
  // production grid/path models here; every other selectable line above is
  // independently parsed and boundary-calibrated.
  const { unitScaleM, bbox, masks, maskPolys } = fieldViewInputs(
    model,
    geometry,
    viewport,
  );
  const nx = 180;
  const ny = Math.max(
    60,
    Math.min(
      140,
      Math.round(nx * (bbox.y1 - bbox.y0) / (bbox.x1 - bbox.x0)),
    ),
  );
  const grid = computeGrid(
    solutions[0],
    bbox,
    nx,
    ny,
    masks,
    maskPolys,
  );
  assert.equal(grid.phi.length, nx * ny, model.label);
  const finitePhi = [...grid.phi].filter(Number.isFinite);
  assert.ok(
    finitePhi.length > grid.phi.length * 0.1,
    `${model.label} potential field is mostly masked`,
  );
  finiteNumber(grid.phiMin, `${model.label} potential minimum`);
  finiteNumber(grid.phiMax, `${model.label} potential maximum`);
  finiteNumber(grid.maxResidual, `${model.label} grid boundary residual`);
  assert.ok(
    grid.phiMax - grid.phiMin > 1e-5,
    `${model.label} potential field has no visible range`,
  );
  assert.ok(grid.maxResidual < 0.35, `${model.label} field residual`);

  const modelUnitsPerMeter = 1 / unitScaleM;
  const contours = contourPaths(grid, viewport, modelUnitsPerMeter, 12);
  assert.ok(contours.length > 0, `${model.label} has no potential contours`);
  for (const contour of contours) {
    assert.match(contour.d, /^M/, `${model.label} malformed contour path`);
    assert.doesNotMatch(contour.d, /NaN|Infinity/, model.label);
    finiteNumber(contour.level, `${model.label} contour level`);
    assert.ok(contour.t > 0 && contour.t < 1, model.label);
  }

  const fieldLines = streamlinePaths(
    grid,
    viewport,
    modelUnitsPerMeter,
    24,
  );
  assert.ok(fieldLines.length > 0, `${model.label} has no field-line paths`);
  for (const path of fieldLines) {
    assert.match(path, /^M/, `${model.label} malformed field-line path`);
    assert.doesNotMatch(path, /NaN|Infinity/, model.label);
    assert.match(path, /L/, `${model.label} field line has fewer than two points`);
  }
}

function assertCurrentDistribution(model, geometry, distribution, driveTotalA) {
  assert.ok(distribution, `${model.label} has no return-current view model`);
  assert.ok(distribution.signals.length > 0, `${model.label} has no drive bands`);
  assert.ok(
    distribution.planes.length + (distribution.surfaces?.length ?? 0) > 0,
    `${model.label} has no return-current surfaces`,
  );
  for (const signal of distribution.signals) {
    assert.ok(
      [signal.centerM, signal.widthM, signal.currentA].every(Number.isFinite),
      `${model.label} has a non-finite current drive band`,
    );
    assert.ok(signal.widthM > 0, model.label);
  }
  for (let index = 1; index < distribution.xM.length; index++) {
    assert.ok(
      distribution.xM[index] > distribution.xM[index - 1],
      `${model.label} return-current x samples are not ordered`,
    );
  }
  for (const plane of distribution.planes) {
    assert.equal(plane.densityAPerM.length, distribution.xM.length, model.label);
    assert.ok(plane.densityAPerM.every(Number.isFinite), model.label);
    finiteNumber(plane.netCurrentA, `${model.label} plane return current`);
  }
  for (const surface of distribution.surfaces ?? []) {
    assert.ok(surface.elements.length > 0, `${model.label} empty current surface`);
    finiteNumber(surface.netCurrentA, `${model.label} surface return current`);
    const faces = groundCurrentSurfaceFaceRuns(surface.elements);
    assert.ok(faces.length > 0, `${model.label} current surface has no face runs`);
    for (const face of faces) {
      const smoothed = groundCurrentSmoothedFaceMagnitudes(face);
      assert.equal(smoothed.length, face.length, model.label);
      assert.ok(smoothed.every(Number.isFinite), model.label);
    }
    for (const element of surface.elements) {
      assert.ok(element.samples.length > 0, model.label);
      for (const sample of element.samples) {
        assert.ok(
          [
            sample.xM,
            sample.yM,
            sample.nx,
            sample.ny,
            sample.densityAPerM,
          ].every(Number.isFinite),
          `${model.label} has non-finite solved surface current`,
        );
        assert.ok(
          Math.abs(Math.hypot(sample.nx, sample.ny) - 1) < 1e-9,
          `${model.label} current-surface normal is not normalized`,
        );
      }
    }
  }
  const peak = groundCurrentDisplayPeak(distribution);
  assert.ok(
    Number.isFinite(peak) && peak > 0,
    `${model.label} return-current plot has no finite peak`,
  );
  const displayedValues = [
    ...distribution.planes.flatMap((plane) => plane.densityAPerM),
    ...(distribution.surfaces ?? []).flatMap((surface) =>
      groundCurrentSurfaceFaceRuns(surface.elements).flatMap((face) =>
        groundCurrentSmoothedFaceMagnitudes(face),
      ),
    ),
  ];
  assert.ok(
    displayedValues.some((value) =>
      groundCurrentMagnitudePercent(value, peak) > 0),
    `${model.label} normalized return-current plot is empty`,
  );
  assert.ok(
    displayedValues.every((value) => {
      const percent = groundCurrentMagnitudePercent(value, peak);
      return Number.isFinite(percent) && percent >= 0 && percent <= 100 + 1e-9;
    }),
    `${model.label} normalized return-current percentages are invalid`,
  );

  const modelUnitScaleM = UNIT_SCALE_M[model.stackup.units];
  const alignment = groundCurrentAlignmentOffsetModelUnits(
    geometry,
    distribution,
    modelUnitScaleM,
  );
  finiteNumber(alignment, `${model.label} current/geometry alignment`);
  const currentViewport = computeViewport(
    geometry,
    2,
    model.state.mode === 'freeform' &&
      model.stackup.items.some(
        (item) =>
          item.kind === 'CircleConductors' || item.kind === 'CircleDielectric',
      ),
  );
  assert.ok(currentViewport.vx1 > currentViewport.vx0, model.label);

  const displayedReturnA = distribution.planes.reduce(
    (sum, plane) => sum + plane.netCurrentA,
    0,
  ) + (distribution.surfaces ?? []).reduce(
    (sum, surface) => sum + surface.netCurrentA,
    0,
  );
  assert.ok(
    Math.abs(displayedReturnA - driveTotalA) <=
      Math.max(2e-5, Math.abs(driveTotalA) * 2e-5),
    `${model.label} return-current closure is ${displayedReturnA} A for ${driveTotalA} A drive`,
  );
}

function assertReturnCurrentView(model, geometry) {
  const unitScaleM = UNIT_SCALE_M[model.stackup.units];
  if (
    model.state.mode === 'preset' &&
    !groundCurrentUsesSolvedMesh(
      model.state.mode,
      model.state.presetKind,
    )
  ) {
    const distribution = presetGroundCurrentDistribution(
      model.state.presetKind,
      model.state.presetVariant,
      model.state.presetParams,
      unitScaleM,
    );
    const driveTotalA = distribution.signals.reduce(
      (sum, signal) => sum + signal.currentA,
      0,
    );
    assertCurrentDistribution(model, geometry, distribution, driveTotalA);
    return;
  }

  assert.ok(model.currentBasis, `${model.label} has no solved mesh-current basis`);
  assert.deepEqual(
    model.currentBasis.signalNames,
    model.result.names,
    `${model.label} mesh-current basis lost solver port order`,
  );
  // A free-form UI drive selector can choose every published signal. Exercise
  // each selection, which is particularly important for the 5-port ribbon.
  for (let driven = 0; driven < model.currentBasis.signalNames.length; driven++) {
    const currents = Array(model.currentBasis.signalNames.length).fill(0);
    currents[driven] = 1;
    const distribution = meshGroundCurrentDistribution(
      model.currentBasis,
      currents,
    );
    assertCurrentDistribution(model, geometry, distribution, 1);
  }
}

test(
  'every About example produces valid geometry, field, field-line, and return-current views',
  { timeout: 180_000 },
  async () => {
    const examples = examplesFromAboutPage();
    assert.ok(examples.length >= 7, 'expected PCB, cable, and many-port examples');
    const models = [];
    for (const [index, example] of examples.entries()) {
      models.push(await solveViewModel(example, index));
    }
    for (const model of models) {
      const { geometry, viewport } = assertGeometryView(model);
      assertFieldViews(model, geometry, viewport);
      assertReturnCurrentView(model, geometry);
    }
  },
);
