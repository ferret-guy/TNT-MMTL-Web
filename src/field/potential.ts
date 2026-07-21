/**
 * Reconstruct the 2D electrostatic potential from the solver's boundary
 * charge output (see parseFieldPlot.mjs).
 *
 * The solver's kernel (nmmtl_interval.cpp) is the grounded-half-plane
 * Green's function with an image across y = 0:
 *
 *     G(p, q) = ln( |p - q*| / |p - q| ),   q* = (qx, -qy)
 *
 * so the bottom ground plane is represented by images (not elements), the
 * y=0 equipotential is built in, and the 2D log gauge constant cancels.
 * We integrate the same kernel over every element in the plot file
 * (conductors, any top ground plane, dielectric interface bound charge):
 *
 *   phi(p) ∝ SUM_elements INT sigma(xi) ln(d_img/d_dir) J(xi) dxi
 *
 * Elements are quadratic (3 nodes). We integrate with 8-point Gauss-Legendre
 * per element and subdivide when the field point is close (log kernel
 * near-singularity). Conductor elements carry free charge; dividing by the
 * contacting dielectric constant (emitted by our patched plot writer) turns
 * it into the total charge the kernel needs.
 *
 * The remaining normalization is fixed by probing conductor-interior points
 * (see calibrate()). Grounded solutions need only a scale; isolated-reference
 * solutions use an affine scale and offset because their common-mode voltage
 * is arbitrary. The spread of the probes doubles as an accuracy metric shown
 * in the UI.
 */
import type { FieldElement, FieldSolution } from '../solver/parseFieldPlot.mjs';

const GAUSS8_X = [
  -0.9602898564975363, -0.7966664774136267, -0.525532409916329, -0.1834346424956498,
  0.1834346424956498, 0.525532409916329, 0.7966664774136267, 0.9602898564975363,
];
const GAUSS8_W = [
  0.1012285362903763, 0.2223810344533745, 0.3137066458778873, 0.3626837833783620,
  0.3626837833783620, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763,
];

/** quadratic Lagrange shape functions on xi in [-1,1] for nodes at -1,0,1 */
function shape(xi: number): [number, number, number] {
  return [0.5 * xi * (xi - 1), 1 - xi * xi, 0.5 * xi * (xi + 1)];
}
function dShape(xi: number): [number, number, number] {
  return [xi - 0.5, -2 * xi, xi + 0.5];
}

interface PreppedElement {
  x: [number, number, number];
  y: [number, number, number];
  sigma: [number, number, number];
  length: number;
  cx: number;
  cy: number;
  isConductor: boolean;
}

export type FieldCalibrationMode = 'grounded' | 'isolated';

/**
 * Overrides for field reconstruction.
 *
 * `imagePlaneYM` is the Y coordinate of the solver's implicit image plane in
 * the same (metre) coordinate system as the field elements.  The historical
 * MMTL geometry uses zero, which remains the default.
 *
 * Isolated-reference solutions have an arbitrary common-mode voltage after
 * their remote helper plane is projected out.  They therefore need an affine
 * calibration.  Callers may provide the physical potential of each conductor
 * contour explicitly, or request `isolated` mode, which identifies the
 * positive-charge driven contour as 1 V and assigns every other contour 0 V.
 */
export interface FieldPotentialOptions {
  imagePlaneYM?: number;
  calibrationMode?: FieldCalibrationMode;
  contourPotentials?: readonly number[];
}

export function prepElements(sol: FieldSolution): PreppedElement[] {
  return sol.elements.map((e: FieldElement) => {
    const x = e.x as [number, number, number];
    const y = e.y as [number, number, number];
    const length = Math.hypot(x[2] - x[0], y[2] - y[0]);
    // In this BEM formulation the conductor unknowns are already the
    // free-space-equivalent (total) charge and the interface elements carry
    // the bound charge, so both integrate against the kernel as-is.
    // (Dividing conductor sigma by the contacting eps_r was tested and makes
    // the boundary-condition check ~10x worse on coupled lines.)
    return {
      x,
      y,
      sigma: e.sigma as [number, number, number],
      length: Math.max(length, 1e-30),
      cx: x[1],
      cy: y[1],
      isConductor: e.type === 'conductor',
    };
  });
}

/** raw (uncalibrated) potential at a point, integrating one element */
function elementPotential(
  el: PreppedElement,
  px: number,
  py: number,
  depth: number,
  imagePlaneYM: number,
): number {
  const d = Math.hypot(px - el.cx, py - el.cy);
  if (depth < 4 && d < 3 * el.length) {
    // subdivide in xi: integrate two halves with mapped quadrature
    return subIntegrate(el, px, py, -1, 0, depth + 1, imagePlaneYM) +
      subIntegrate(el, px, py, 0, 1, depth + 1, imagePlaneYM);
  }
  return subIntegrate(el, px, py, -1, 1, depth + 1, imagePlaneYM);
}

function subIntegrate(
  el: PreppedElement,
  px: number,
  py: number,
  a: number,
  b: number,
  depth: number,
  imagePlaneYM: number,
): number {
  // if still very close relative to sub-span, keep splitting (bounded depth)
  const mid = (a + b) / 2;
  const [sm0, sm1, sm2] = shape(mid);
  const mx = sm0 * el.x[0] + sm1 * el.x[1] + sm2 * el.x[2];
  const my = sm0 * el.y[0] + sm1 * el.y[1] + sm2 * el.y[2];
  const span = (el.length * (b - a)) / 2;
  if (depth < 7 && Math.hypot(px - mx, py - my) < 1.5 * span) {
    return subIntegrate(el, px, py, a, mid, depth + 1, imagePlaneYM) +
      subIntegrate(el, px, py, mid, b, depth + 1, imagePlaneYM);
  }
  let acc = 0;
  const half = (b - a) / 2;
  for (let k = 0; k < 8; k++) {
    const xi = mid + half * GAUSS8_X[k];
    const [n0, n1, n2] = shape(xi);
    const [d0, d1, d2] = dShape(xi);
    const gx = n0 * el.x[0] + n1 * el.x[1] + n2 * el.x[2];
    const gy = n0 * el.y[0] + n1 * el.y[1] + n2 * el.y[2];
    const jx = d0 * el.x[0] + d1 * el.x[1] + d2 * el.x[2];
    const jy = d0 * el.y[0] + d1 * el.y[1] + d2 * el.y[2];
    const jac = Math.hypot(jx, jy);
    const sig = n0 * el.sigma[0] + n1 * el.sigma[1] + n2 * el.sigma[2];
    // solver kernel: ln(d_image / d_direct), with the source reflected
    // across the configured image plane.
    const r2dir = (px - gx) ** 2 + (py - gy) ** 2;
    const imageY = 2 * imagePlaneYM - gy;
    const r2img = (px - gx) ** 2 + (py - imageY) ** 2;
    acc += GAUSS8_W[k] * sig * Math.log(Math.max(r2img, 1e-40) / Math.max(r2dir, 1e-40)) * jac;
  }
  // ln = 0.5 ln(^2); overall scale folded into calibration
  return 0.5 * acc * half;
}

export function potentialAt(
  els: PreppedElement[],
  px: number,
  py: number,
  imagePlaneYM = 0,
): number {
  let phi = 0;
  for (const el of els) phi += elementPotential(el, px, py, 0, imagePlaneYM);
  return phi;
}

export interface Calibration {
  a: number;
  b: number;
  maxResidual: number; // vs 0/1 BCs, after calibration
}

/**
 * Calibrate the reconstruction scale against conductor boundary conditions.
 *
 * In the legacy grounded mode the image plane fixes zero, so only a scale is
 * needed. In isolated mode we affine-fit both scale and common-mode offset to
 * 0/1 conductor targets. Conductor interiors are field-free, making their
 * centroids smooth and accurate probes. Elements of one conductor form an
 * end-to-end chain in the plot file and are grouped by endpoint adjacency.
 */
export function calibrate(
  els: PreppedElement[],
  options: FieldPotentialOptions = {},
): Calibration {
  const conductorEls = els.filter((e) => e.isConductor);
  if (!conductorEls.length) return { a: 1, b: 0, maxResidual: NaN };
  const imagePlaneYM = options.imagePlaneYM ?? 0;

  // group into contours: a new contour starts when the element's start point
  // is not the previous element's end point
  const groups: PreppedElement[][] = [];
  let cur: PreppedElement[] = [];
  let prev: PreppedElement | null = null;
  for (const el of conductorEls) {
    if (
      prev &&
      Math.hypot(el.x[0] - prev.x[2], el.y[0] - prev.y[2]) > 0.25 * (el.length + prev.length)
    ) {
      groups.push(cur);
      cur = [];
    }
    cur.push(el);
    prev = el;
  }
  if (cur.length) groups.push(cur);

  // several interior probes per contour: centroid plus points nudged along
  // the contour's x extent -- a conductor interior is an equipotential, so
  // their spread is an independent accuracy measure even with one conductor
  const probesPerGroup = groups.map((g) => {
    let sx = 0;
    let sy = 0;
    for (const el of g) {
      sx += el.cx;
      sy += el.cy;
    }
    const cx = sx / g.length;
    const cy = sy / g.length;
    const xs = g.flatMap((el) => [el.x[0], el.x[2]]);
    const spanX = Math.max(...xs) - Math.min(...xs);
    return [
      { x: cx, y: cy },
      { x: cx - 0.25 * spanX, y: cy },
      { x: cx + 0.25 * spanX, y: cy },
    ];
  });
  const groupValues = probesPerGroup.map((probes) =>
    probes.map((p) => potentialAt(els, p.x, p.y, imagePlaneYM)),
  );
  const centroidValues = groupValues.map((v) => v[0]);

  let targets: readonly number[] | undefined = options.contourPotentials;
  if (targets) {
    if (targets.length !== groups.length) {
      throw new Error(
        `field contour-potential count ${targets.length} does not match ${groups.length} conductor contours`,
      );
    }
    if (targets.some((target) => !Number.isFinite(target))) {
      throw new Error('field contour potentials must all be finite');
    }
  } else if (options.calibrationMode === 'isolated') {
    // In the combined charge solution for a physical 1 V excitation, the
    // driven conductor is the contour with the greatest positive integrated
    // charge; explicit return conductors carry negative charge.  Selecting by
    // the signed integral is substantially more robust than selecting by raw
    // reconstructed potential when the helper plane is very remote.
    const charges = groups.map((group) =>
      group.reduce((sum, element) => sum + integratedCharge(element), 0),
    );
    let drivenIndex = 0;
    for (let index = 1; index < charges.length; index++) {
      if (charges[index] > charges[drivenIndex]) drivenIndex = index;
    }
    targets = groups.map((_, index) => index === drivenIndex ? 1 : 0);
  }

  if (targets) {
    const { a, b } = affineCalibration(centroidValues, targets);
    let maxResidual = 0;
    for (let groupIndex = 0; groupIndex < groupValues.length; groupIndex++) {
      const target = targets[groupIndex];
      for (const value of groupValues[groupIndex]) {
        maxResidual = Math.max(maxResidual, Math.abs(a * value + b - target));
      }
    }
    return { a, b, maxResidual };
  }

  const driven = Math.max(...centroidValues.map((v) => Math.abs(v)));
  if (!(driven > 0)) return { a: 1, b: 0, maxResidual: NaN };
  const a = 1 / centroidValues[centroidValues.map((v) => Math.abs(v)).indexOf(driven)];

  let maxResidual = 0;
  for (const vals of groupValues) {
    for (const v of vals) {
      const s = a * v;
      maxResidual = Math.max(maxResidual, Math.min(Math.abs(s), Math.abs(s - 1)));
    }
  }
  return { a, b: 0, maxResidual };
}

/** Integral of sigma ds over one quadratic boundary element. */
function integratedCharge(el: PreppedElement): number {
  let charge = 0;
  for (let k = 0; k < GAUSS8_X.length; k++) {
    const xi = GAUSS8_X[k];
    const [n0, n1, n2] = shape(xi);
    const [d0, d1, d2] = dShape(xi);
    const jx = d0 * el.x[0] + d1 * el.x[1] + d2 * el.x[2];
    const jy = d0 * el.y[0] + d1 * el.y[1] + d2 * el.y[2];
    const sigma = n0 * el.sigma[0] + n1 * el.sigma[1] + n2 * el.sigma[2];
    charge += GAUSS8_W[k] * sigma * Math.hypot(jx, jy);
  }
  return charge;
}

/** Least-squares affine map from raw contour potentials to physical volts. */
function affineCalibration(
  raw: readonly number[],
  targets: readonly number[],
): { a: number; b: number } {
  if (!raw.length || raw.length !== targets.length) {
    throw new Error('affine field calibration needs matching non-empty samples and targets');
  }
  if (raw.some((value) => !Number.isFinite(value))) {
    throw new Error('raw field calibration potentials must all be finite');
  }
  if (raw.length === 1) {
    if (Math.abs(raw[0]) <= Number.EPSILON) {
      throw new Error('field calibration is singular');
    }
    return { a: targets[0] / raw[0], b: 0 };
  }
  const rawMean = raw.reduce((sum, value) => sum + value, 0) / raw.length;
  const targetMean = targets.reduce((sum, value) => sum + value, 0) / targets.length;
  let covariance = 0;
  let rawVariance = 0;
  for (let index = 0; index < raw.length; index++) {
    const dx = raw[index] - rawMean;
    covariance += dx * (targets[index] - targetMean);
    rawVariance += dx * dx;
  }
  const scale = Math.max(Number.MIN_VALUE, ...raw.map((value) => Math.abs(value)));
  if (!(rawVariance > Number.EPSILON * Math.max(Number.MIN_VALUE, scale * scale))) {
    throw new Error('field calibration is singular: conductor contours have indistinguishable potentials');
  }
  const a = covariance / rawVariance;
  const b = targetMean - a * rawMean;
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) <= Number.EPSILON) {
    throw new Error('field calibration did not produce a finite nonzero scale');
  }
  return { a, b };
}

export interface FieldGrid {
  nx: number;
  ny: number;
  x0: number;
  y0: number;
  dx: number;
  dy: number;
  phi: Float32Array; // calibrated, row-major [j*nx + i], NaN where masked
  phiMin: number;
  phiMax: number;
  maxResidual: number;
}

export interface MaskRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** conductor cross-sections as polygons (so etched/trapezoid edges mask true) */
export type MaskPoly = Array<[number, number]>;

function pointInPoly(px: number, py: number, poly: MaskPoly): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function computeGrid(
  sol: FieldSolution,
  bbox: { x0: number; y0: number; x1: number; y1: number },
  nx: number,
  ny: number,
  masks: MaskRect[],
  polys: MaskPoly[] = [],
  onProgress?: (frac: number) => void,
  options: FieldPotentialOptions = {},
): FieldGrid {
  const els = prepElements(sol);
  const metadata = sol as FieldSolution & {
    imagePlaneYM?: number;
    calibrationMode?: FieldCalibrationMode;
  };
  const resolvedOptions: FieldPotentialOptions = {
    imagePlaneYM: options.imagePlaneYM ?? metadata.imagePlaneYM,
    calibrationMode: options.calibrationMode ?? metadata.calibrationMode,
    contourPotentials: options.contourPotentials,
  };
  const cal = calibrate(els, resolvedOptions);
  const imagePlaneYM = resolvedOptions.imagePlaneYM ?? 0;
  const dx = (bbox.x1 - bbox.x0) / (nx - 1);
  const dy = (bbox.y1 - bbox.y0) / (ny - 1);
  const phi = new Float32Array(nx * ny);
  let mn = Infinity;
  let mx = -Infinity;
  for (let j = 0; j < ny; j++) {
    const py = bbox.y0 + j * dy;
    for (let i = 0; i < nx; i++) {
      const px = bbox.x0 + i * dx;
      let masked = false;
      for (const m of masks) {
        if (px >= m.x0 && px <= m.x1 && py >= m.y0 && py <= m.y1) {
          masked = true;
          break;
        }
      }
      if (!masked) {
        for (const poly of polys) {
          if (pointInPoly(px, py, poly)) {
            masked = true;
            break;
          }
        }
      }
      if (masked) {
        phi[j * nx + i] = NaN;
        continue;
      }
      const v = cal.a * potentialAt(els, px, py, imagePlaneYM) + cal.b;
      phi[j * nx + i] = v;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (onProgress && (j & 7) === 0) onProgress(j / ny);
  }
  return {
    nx,
    ny,
    x0: bbox.x0,
    y0: bbox.y0,
    dx,
    dy,
    phi,
    phiMin: mn,
    phiMax: mx,
    maxResidual: cal.maxResidual,
  };
}
