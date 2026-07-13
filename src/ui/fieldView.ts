/**
 * Field visualization for the main cross-section view.
 *
 * The heatmap is computed on a fine grid in the worker, drawn to a canvas at
 * grid resolution, and scaled up by the browser with smoothing (no visible
 * pixels). Equipotential lines come from marching squares at grid resolution
 * but are emitted as crisp SVG vector paths into the overlay, so they stay
 * sharp at any size.
 */
import type { FieldGrid } from '../field/potential.ts';
import type { Viewport } from './crossSection.ts';

/** cool-warm diverging colormap for t in [0,1] */
function colorFor(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t));
  const r = Math.round(255 * Math.min(1, 0.25 + 1.5 * x));
  const g = Math.round(255 * (0.3 + 0.68 * (1 - Math.abs(x - 0.5) * 2) ** 1.35));
  const b = Math.round(255 * Math.min(1, 1.75 - 1.5 * x));
  return [r, g, b];
}

export function drawFieldHeatmap(canvas: HTMLCanvasElement, grid: FieldGrid) {
  const { nx, ny, phi } = grid;
  canvas.width = nx;
  canvas.height = ny;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(nx, ny);
  const lo = grid.phiMin;
  const span = grid.phiMax - grid.phiMin || 1;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const v = phi[j * nx + i];
      const o = ((ny - 1 - j) * nx + i) * 4; // grid j=0 is bottom
      if (Number.isNaN(v)) {
        img.data[o + 3] = 0; // transparent inside conductors
        continue;
      }
      const [r, g, b] = colorFor((v - lo) / span);
      img.data[o] = r;
      img.data[o + 1] = g;
      img.data[o + 2] = b;
      img.data[o + 3] = 235;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Marching-squares equipotential contours as SVG path strings.
 * Coordinates come out in the given viewport's SVG space.
 */
export function contourPaths(
  grid: FieldGrid,
  vp: Viewport,
  scaleMilsPerMeter: number,
  nContours = 14,
): Array<{ d: string; level: number; t: number }> {
  const { nx, ny, phi } = grid;
  const lo = grid.phiMin;
  const span = grid.phiMax - grid.phiMin || 1;
  // grid index -> stackup units (mils) -> svg
  const gx = (i: number) => vp.sx((grid.x0 + i * grid.dx) * scaleMilsPerMeter);
  const gy = (j: number) => vp.sy((grid.y0 + j * grid.dy) * scaleMilsPerMeter);

  const out: Array<{ d: string; level: number; t: number }> = [];
  for (let c = 1; c < nContours; c++) {
    const t = c / nContours;
    const level = lo + span * t;
    let d = '';
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const v00 = phi[j * nx + i];
        const v10 = phi[j * nx + i + 1];
        const v01 = phi[(j + 1) * nx + i];
        const v11 = phi[(j + 1) * nx + i + 1];
        if ([v00, v10, v01, v11].some(Number.isNaN)) continue;
        const pts: Array<[number, number]> = [];
        const edge = (va: number, vb: number, ax: number, ay: number, bx: number, by: number) => {
          if ((va < level) !== (vb < level)) {
            const f = (level - va) / (vb - va);
            pts.push([ax + (bx - ax) * f, ay + (by - ay) * f]);
          }
        };
        edge(v00, v10, i, j, i + 1, j);
        edge(v10, v11, i + 1, j, i + 1, j + 1);
        edge(v11, v01, i + 1, j + 1, i, j + 1);
        edge(v01, v00, i, j + 1, i, j);
        if (pts.length === 2) {
          d += `M${gx(pts[0][0]).toFixed(1)},${gy(pts[0][1]).toFixed(1)}L${gx(pts[1][0]).toFixed(1)},${gy(pts[1][1]).toFixed(1)}`;
        }
      }
    }
    if (d) out.push({ d, level, t });
  }
  return out;
}

export function renderContoursInto(
  svg: SVGSVGElement,
  paths: Array<{ d: string; level: number; t: number }>,
  colored: boolean,
) {
  const ns = 'http://www.w3.org/2000/svg';
  for (const p of paths) {
    const el = document.createElementNS(ns, 'path');
    el.setAttribute('d', p.d);
    el.setAttribute('fill', 'none');
    if (colored) {
      const [r, g, b] = colorFor(p.t);
      el.setAttribute('stroke', `rgb(${Math.round(r * 0.82)},${Math.round(g * 0.82)},${Math.round(b * 0.82)})`);
      el.setAttribute('stroke-width', '1.6');
    } else {
      el.setAttribute('stroke', 'rgba(25,25,25,0.5)');
      el.setAttribute('stroke-width', '0.9');
    }
    const t = document.createElementNS(ns, 'title');
    t.textContent = `${(p.t * 100).toFixed(0)} % of driven potential`;
    el.appendChild(t);
    svg.appendChild(el);
  }
}

/**
 * E-field streamlines: start just off the driven conductor (seeded along the
 * phi = seedLevel equipotential), integrate along E = -grad(phi) — i.e.
 * perpendicular to the equipotentials — until the line lands on ground
 * (phi -> 0), another conductor (masked cell), or leaves the view.
 */
export function streamlinePaths(
  grid: FieldGrid,
  vp: Viewport,
  scaleMilsPerMeter: number,
  nSeeds = 32,
): string[] {
  const { nx, ny, phi } = grid;
  const lo = grid.phiMin;
  const span = grid.phiMax - grid.phiMin || 1;
  const norm = (v: number) => (v - lo) / span;

  /** bilinear phi in grid coords; NaN if any corner is masked */
  const sample = (x: number, y: number): number => {
    const i = Math.floor(x);
    const j = Math.floor(y);
    if (i < 0 || j < 0 || i >= nx - 1 || j >= ny - 1) return NaN;
    const fx = x - i;
    const fy = y - j;
    const v00 = phi[j * nx + i];
    const v10 = phi[j * nx + i + 1];
    const v01 = phi[(j + 1) * nx + i];
    const v11 = phi[(j + 1) * nx + i + 1];
    return v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
  };
  /** central differences, falling back to one-sided next to masked cells so
   *  lines keep their direction all the way to a conductor surface */
  const grad = (x: number, y: number): [number, number] => {
    const e = 0.6;
    const c = sample(x, y);
    let gx = (sample(x + e, y) - sample(x - e, y)) / (2 * e);
    if (!Number.isFinite(gx)) {
      const r = (sample(x + e, y) - c) / e;
      const l = (c - sample(x - e, y)) / e;
      gx = Number.isFinite(r) ? r : l;
    }
    let gy = (sample(x, y + e) - sample(x, y - e)) / (2 * e);
    if (!Number.isFinite(gy)) {
      const u = (sample(x, y + e) - c) / e;
      const d = (c - sample(x, y - e)) / e;
      gy = Number.isFinite(u) ? u : d;
    }
    return [gx, gy];
  };
  /** last valid point -> first invalid point: bisect onto the boundary */
  const snapToBoundary = (x0: number, y0: number, x1: number, y1: number): [number, number] => {
    let a: [number, number] = [x0, y0];
    let b: [number, number] = [x1, y1];
    for (let k = 0; k < 14; k++) {
      const m: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (Number.isFinite(sample(m[0], m[1]))) a = m;
      else b = m;
    }
    return b;
  };

  // seeds: midpoints of the phi = seedLevel contour cells (a ring hugging the
  // driven line), ordered by angle around the ring so the chosen subset is
  // spread evenly all the way around (top, sides AND bottom face)
  const seedLevel = lo + span * 0.9;
  const seeds: Array<[number, number]> = [];
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const v00 = phi[j * nx + i];
      const v10 = phi[j * nx + i + 1];
      const v01 = phi[(j + 1) * nx + i];
      const v11 = phi[(j + 1) * nx + i + 1];
      if ([v00, v10, v01, v11].some(Number.isNaN)) continue;
      const min = Math.min(v00, v10, v01, v11);
      const max = Math.max(v00, v10, v01, v11);
      if (min < seedLevel && max >= seedLevel) seeds.push([i + 0.5, j + 0.5]);
    }
  }
  if (!seeds.length) return [];
  const mx = seeds.reduce((a, s) => a + s[0], 0) / seeds.length;
  const my = seeds.reduce((a, s) => a + s[1], 0) / seeds.length;
  seeds.sort((a, b) => Math.atan2(a[1] - my, a[0] - mx) - Math.atan2(b[1] - my, b[0] - mx));
  const stride = Math.max(1, Math.floor(seeds.length / nSeeds));
  const chosen = seeds.filter((_, k) => k % stride === 0);

  // grid coords -> svg coords
  const toSvg = (x: number, y: number): [number, number] => [
    vp.sx((grid.x0 + x * grid.dx) * scaleMilsPerMeter),
    vp.sy((grid.y0 + y * grid.dy) * scaleMilsPerMeter),
  ];

  const aspect = grid.dy / grid.dx; // physical anisotropy of grid cells
  const stopLo = 0.005;

  /** integrate from a point along +/-E; returns grid-coordinate polyline
   *  ending exactly on the terminating boundary */
  const trace = (x0: number, y0: number, sign: 1 | -1): Array<[number, number]> => {
    const pts: Array<[number, number]> = [[x0, y0]];
    let x = x0;
    let y = y0;
    for (let step = 0; step < 6000; step++) {
      const v = sample(x, y);
      if (!Number.isFinite(v)) break;
      if (sign > 0 && norm(v) < stopLo) break; // reached ground potential
      if (sign < 0 && norm(v) > 0.999) break; // reached the driven surface
      const [gx, gy] = grad(x, y);
      if (!Number.isFinite(gx) || !Number.isFinite(gy)) break;
      let ex = -sign * gx / grid.dx;
      let ey = -sign * gy / grid.dy;
      const stepLen = 0.45 / (Math.hypot(ex, ey * aspect) || 1);
      ex *= stepLen;
      ey *= stepLen;
      const [gx2, gy2] = grad(x + ex / 2, y + ey / 2);
      if (Number.isFinite(gx2) && Number.isFinite(gy2)) {
        const ex2 = -sign * gx2 / grid.dx;
        const ey2 = -sign * gy2 / grid.dy;
        const s2 = 0.45 / (Math.hypot(ex2, ey2 * aspect) || 1);
        ex = ex2 * s2;
        ey = ey2 * s2;
      }
      const xN = x + ex;
      const yN = y + ey;
      if (xN < 0 || yN < 0 || xN > nx - 1 || yN > ny - 1) {
        pts.push([xN, yN]);
        break;
      }
      if (!Number.isFinite(sample(xN, yN))) {
        // land exactly on the conductor/ground boundary
        pts.push(snapToBoundary(x, y, xN, yN));
        break;
      }
      x = xN;
      y = yN;
      pts.push([x, y]);
    }
    return pts;
  };

  const paths: string[] = [];
  for (const [sx0, sy0] of chosen) {
    // backward to the driven surface, forward to ground/other conductor
    const back = trace(sx0, sy0, -1).reverse();
    const fwd = trace(sx0, sy0, 1);
    const pts = [...back, ...fwd.slice(1)];
    if (pts.length < 4) continue;
    let d = '';
    for (let k = 0; k < pts.length; k++) {
      const [px, py] = toSvg(pts[k][0], pts[k][1]);
      d += `${k === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`;
    }
    paths.push(d);
  }
  return paths;
}

export function renderStreamlinesInto(svg: SVGSVGElement, paths: string[]) {
  const ns = 'http://www.w3.org/2000/svg';
  for (const d of paths) {
    const el = document.createElementNS(ns, 'path');
    el.setAttribute('d', d);
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke', '#b3593a');
    el.setAttribute('stroke-width', '1.3');
    el.setAttribute('opacity', '0.85');
    svg.appendChild(el);
  }
}

export function drawColorbar(canvas: HTMLCanvasElement) {
  const W = (canvas.width = 160);
  const H = (canvas.height = 12);
  const ctx = canvas.getContext('2d')!;
  for (let i = 0; i < W; i++) {
    const [r, g, b] = colorFor(i / (W - 1));
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(i, 0, 1, H);
  }
}
