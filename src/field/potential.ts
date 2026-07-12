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
 * The remaining unknown is a single scale (BEM sigma normalization), fixed
 * by probing conductor-interior points (see calibrate()); the spread of
 * those probes doubles as an accuracy metric shown in the UI.
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
function elementPotential(el: PreppedElement, px: number, py: number, depth: number): number {
  const d = Math.hypot(px - el.cx, py - el.cy);
  if (depth < 4 && d < 3 * el.length) {
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
  if (depth < 7 && Math.hypot(px - mx, py - my) < 1.5 * span) {
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
    // solver kernel: ln(d_image / d_direct), image across y=0
    const r2dir = (px - gx) ** 2 + (py - gy) ** 2;
    const r2img = (px - gx) ** 2 + (py + gy) ** 2;
    acc += GAUSS8_W[k] * sig * Math.log(Math.max(r2img, 1e-40) / Math.max(r2dir, 1e-40)) * jac;
  }
  // ln = 0.5 ln(^2); overall scale folded into calibration
  return 0.5 * acc * half;
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
 * Calibrate the reconstruction scale against conductor boundary conditions.
 *
 * The solver's image kernel makes phi(y=0) = 0 exactly, so no offset is
 * needed (b = 0). For the scale: conductor interiors are field-free, so the
 * potential at each conductor's centroid equals its surface potential
 * exactly (and the quadrature there is smooth -- unlike on-surface points).
 * Elements of one conductor form an end-to-end chain in the plot file, so we
 * group them by endpoint adjacency, evaluate each contour's centroid, scale
 * the largest |phi| (the driven line, at 1 V) to 1, and report how far the
 * other contours sit from their expected {0, 1} values.
 */
export function calibrate(els: PreppedElement[]): Calibration {
  const conductorEls = els.filter((e) => e.isConductor);
  if (!conductorEls.length) return { a: 1, b: 0, maxResidual: NaN };

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
    probes.map((p) => potentialAt(els, p.x, p.y)),
  );
  const centroidValues = groupValues.map((v) => v[0]);
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
