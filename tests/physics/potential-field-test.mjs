import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calibrate,
  computeGrid,
  potentialAt,
  prepElements,
} from '../../src/field/potential.ts';

function element(type, x, y, sigma) {
  return {
    type,
    x,
    y,
    sigma,
    edges: [],
    epsilon: 1,
    epsilonPlus: 1,
    epsilonMinus: 1,
  };
}

function translated(solution, dy) {
  return {
    ...solution,
    elements: solution.elements.map((entry) => ({
      ...entry,
      x: [...entry.x],
      y: entry.y.map((value) => value + dy),
      sigma: [...entry.sigma],
    })),
  };
}

function square(cx, cy, half, sigma) {
  const edge = (x0, y0, x1, y1) => element(
    'conductor',
    [x0, (x0 + x1) / 2, x1],
    [y0, (y0 + y1) / 2, y1],
    [sigma, sigma, sigma],
  );
  return [
    edge(cx - half, cy - half, cx + half, cy - half),
    edge(cx + half, cy - half, cx + half, cy + half),
    edge(cx + half, cy + half, cx - half, cy + half),
    edge(cx - half, cy + half, cx - half, cy - half),
  ];
}

function isolatedFixture() {
  return {
    line: 'signal',
    elements: [
      ...square(-1, 1, 0.2, -1),
      ...square(1, 1, 0.2, 1),
    ],
  };
}

function near(actual, expected, tolerance = 1e-11) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)),
    `${actual} != ${expected}`,
  );
}

test('arbitrary image plane is an equipotential and is translation invariant', () => {
  const solution = {
    line: 'line',
    elements: [element('conductor', [-1, 0, 1], [3, 3, 3], [1, 1, 1])],
  };
  const elements = prepElements(solution);
  const imagePlaneYM = 1.5;

  near(potentialAt(elements, 0.25, imagePlaneYM, imagePlaneYM), 0, 1e-14);
  near(potentialAt(elements, 0.25, 4, 0), potentialAt(elements, 0.25, 4));

  const dy = 7.25;
  const shiftedElements = prepElements(translated(solution, dy));
  near(
    potentialAt(elements, 0.25, 4, imagePlaneYM),
    potentialAt(shiftedElements, 0.25, 4 + dy, imagePlaneYM + dy),
  );
});

test('isolated calibration affine-fits return contours to 0 V and driven contour to 1 V', () => {
  const solution = isolatedFixture();
  const elements = prepElements(solution);
  const options = { imagePlaneYM: -3, calibrationMode: 'isolated' };
  const calibration = calibrate(elements, options);
  const returnRaw = potentialAt(elements, -1, 1, options.imagePlaneYM);
  const drivenRaw = potentialAt(elements, 1, 1, options.imagePlaneYM);

  near(calibration.a * returnRaw + calibration.b, 0);
  near(calibration.a * drivenRaw + calibration.b, 1);
  assert.ok(Math.abs(calibration.b) > 1e-6, 'isolated calibration needs a nonzero gauge offset');
  assert.ok(Number.isFinite(calibration.maxResidual));

  const explicit = calibrate(elements, {
    imagePlaneYM: options.imagePlaneYM,
    contourPotentials: [0, 1],
  });
  near(explicit.a, calibration.a);
  near(explicit.b, calibration.b);
});

test('computeGrid passes image-plane and affine calibration options through', () => {
  const solution = isolatedFixture();
  const grid = computeGrid(
    solution,
    { x0: -0.5, y0: 0.25, x1: 0.5, y1: 1.75 },
    7,
    5,
    [],
    [],
    undefined,
    { imagePlaneYM: -3, contourPotentials: [0, 1] },
  );

  assert.equal(grid.phi.length, 35);
  assert.ok([...grid.phi].every(Number.isFinite));
  assert.ok(Number.isFinite(grid.phiMin));
  assert.ok(Number.isFinite(grid.phiMax));
  assert.ok(grid.phiMax > grid.phiMin);
  assert.ok(Number.isFinite(grid.maxResidual));
});

test('explicit contour calibration rejects an order/count mismatch', () => {
  const elements = prepElements(isolatedFixture());
  assert.throws(
    () => calibrate(elements, { contourPotentials: [0] }),
    /does not match 2 conductor contours/,
  );
});
