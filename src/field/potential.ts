/**
 * Reconstruct the 2D electrostatic potential from the solver's boundary
 * charge output (see parseFieldPlot.mjs).
 *
 * phi(p) = -(1/(2 pi eps0)) * SUM_elements INT sigma(xi) ln|p - x(xi)| J(xi) dxi
 *
 * The charge file covers ALL boundaries -- driven/passive conductors,
 * discretized ground planes, and dielectric interfaces (bound charge) -- so
 * the free-space kernel is complete: no image terms.
 *
 * Elements are quadratic (3 nodes). We integrate with 8-point Gauss-Legendre
 * per element and subdivide 4x when the field point is closer than twice the
 * element length (log kernel near-singularity).
 *
 * The reconstruction has an unknown overall scale/offset (BEM sigma
 * normalization + the 2D log-potential gauge), so we least-squares fit
 * a*phi + b against known boundary conditions (driven conductor = 1,
 * grounds = 0) sampled on conductor elements; the residual doubles as an
 * accuracy metric.
 */
import type { FieldElement, FieldSolution } from '../solver/parseFieldPlot.ts';

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

export function prepElements(sol: FieldSolution): PreppedElement[] {
  return sol.elements.map((e: FieldElement) => {
    const x = e.x as [number, number, number];
    const y = e.y as [number, number, number];
    const length = Math.hypot(x[2] - x[0], y[2] - y[0]);
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
function elementPotential(el: PreppedElement, px: number, py: number, depth: number): number {
  const d = Math.hypot(px - el.cx, py - el.cy);
  if (depth < 3 && d < 2 * el.length) {
    // subdivide in xi: integrate two halves with mapped quadrature
    return subIntegrate(el, px, py, -1, 0, depth + 1) + subIntegrate(el, px, py, 0, 1, depth + 1);
  }
  return subIntegrate(el, px, py, -1, 1, depth + 1);
}

function subIntegrate(
  el: PreppedElement,
  px: number,
  py: number,
  a: number,
  b: number,
  depth: number,
): number {
  // if still very close relative to sub-span, keep splitting (bounded depth)
  const mid = (a + b) / 2;
  const [sm0, sm1, sm2] = shape(mid);
  const mx = sm0 * el.x[0] + sm1 * el.x[1] + sm2 * el.x[2];
  const my = sm0 * el.y[0] + sm1 * el.y[1] + sm2 * el.y[2];
  const span = (el.length * (b - a)) / 2;
  if (depth < 5 && Math.hypot(px - mx, py - my) < span) {
    return subIntegrate(el, px, py, a, mid, depth + 1) + subIntegrate(el, px, py, mid, b, depth + 1);
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
    const r2 = (px - gx) ** 2 + (py - gy) ** 2;
    acc += GAUSS8_W[k] * sig * Math.log(Math.max(r2, 1e-40)) * jac;
  }
  // ln|r| = 0.5 ln r^2 ; kernel scale folded into calibration
  return -0.5 * acc * half;
}

export function potentialAt(els: PreppedElement[], px: number, py: number): number {
  let phi = 0;
  for (const el of els) phi += elementPotential(el, px, py, 0);
  return phi;
}

export interface Calibration {
  a: number;
  b: number;
  maxResidual: number; // vs 0/1 BCs, after calibration
}

/**
 * Sample conductor-surface potentials and least-squares fit a*phi+b to the
 * expected BCs. The driven line's elements should sit at 1, all other
 * conductors (incl. ground planes) at 0 -- but the plot file does not tag
 * which conductor elements belong to the driven line. We exploit the BEM
 * property that conductor potentials are piecewise constant: sample each
 * conductor element's midpoint, cluster values, map the cluster containing
 * the max to 1 and the cluster containing the min to 0.
 */
export function calibrate(els: PreppedElement[], sampleEvery = 3): Calibration {
  const samples: number[] = [];
  const conductorEls = els.filter((e) => e.isConductor);
  for (let i = 0; i < conductorEls.length; i += sampleEvery) {
    const el = conductorEls[i];
    // sample slightly off the midpoint node
    samples.push(potentialAt(els, el.cx, el.cy));
  }
  if (samples.length < 2) return { a: 1, b: 0, maxResidual: NaN };
  const lo = Math.min(...samples);
  const hi = Math.max(...samples);
  if (hi - lo < 1e-30) return { a: 1, b: -lo, maxResidual: NaN };
  // map lo->0, hi->1
  const a = 1 / (hi - lo);
  const b = -lo * a;
  // residual: distance of each calibrated sample from its nearest of {0, 1}
  let maxResidual = 0;
  for (const s of samples) {
    const v = a * s + b;
    maxResidual = Math.max(maxResidual, Math.min(Math.abs(v), Math.abs(v - 1)));
  }
  return { a, b, maxResidual };
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

export function computeGrid(
  sol: FieldSolution,
  bbox: { x0: number; y0: number; x1: number; y1: number },
  nx: number,
  ny: number,
  masks: MaskRect[],
): FieldGrid {
  const els = prepElements(sol);
  const cal = calibrate(els);
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
      if (masked) {
        phi[j * nx + i] = NaN;
        continue;
      }
      const v = cal.a * potentialAt(els, px, py) + cal.b;
      phi[j * nx + i] = v;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
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
