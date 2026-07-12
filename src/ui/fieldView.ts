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
