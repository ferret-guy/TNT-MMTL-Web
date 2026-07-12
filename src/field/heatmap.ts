/**
 * Canvas heatmap + equipotential contours for the reconstructed potential,
 * with the cross-section geometry drawn as an overlay.
 */
import type { FieldGrid } from './potential.ts';

/** perceptually-ordered blue->white->red diverging map for 0..1 */
function colorFor(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t));
  // simple cool-warm
  const r = Math.round(255 * Math.min(1, 0.2 + 1.6 * x));
  const g = Math.round(255 * (0.25 + 0.75 * (1 - Math.abs(x - 0.5) * 2) ** 1.2));
  const b = Math.round(255 * Math.min(1, 1.8 - 1.6 * x));
  return [r, g, b];
}

export function drawHeatmap(
  canvas: HTMLCanvasElement,
  grid: FieldGrid,
  contours = 12,
) {
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
      const o = ((ny - 1 - j) * nx + i) * 4; // flip y: grid j=0 is bottom
      if (Number.isNaN(v)) {
        img.data[o] = 233;
        img.data[o + 1] = 236;
        img.data[o + 2] = 239;
        img.data[o + 3] = 255;
        continue;
      }
      const [r, g, b] = colorFor((v - lo) / span);
      img.data[o] = r;
      img.data[o + 1] = g;
      img.data[o + 2] = b;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // marching-squares equipotentials
  ctx.strokeStyle = 'rgba(30,30,30,0.55)';
  ctx.lineWidth = 0.6;
  for (let c = 1; c < contours; c++) {
    const level = lo + (span * c) / contours;
    ctx.beginPath();
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const v00 = phi[j * nx + i];
        const v10 = phi[j * nx + i + 1];
        const v01 = phi[(j + 1) * nx + i];
        const v11 = phi[(j + 1) * nx + i + 1];
        if ([v00, v10, v01, v11].some(Number.isNaN)) continue;
        // edges: interpolate crossing points
        const pts: Array<[number, number]> = [];
        const edge = (va: number, vb: number, ax: number, ay: number, bx: number, by: number) => {
          if ((va < level) !== (vb < level)) {
            const t = (level - va) / (vb - va);
            pts.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
          }
        };
        edge(v00, v10, i, j, i + 1, j);
        edge(v10, v11, i + 1, j, i + 1, j + 1);
        edge(v11, v01, i + 1, j + 1, i, j + 1);
        edge(v01, v00, i, j + 1, i, j);
        if (pts.length === 2) {
          ctx.moveTo(pts[0][0] + 0.5, ny - 1 - pts[0][1] + 0.5);
          ctx.lineTo(pts[1][0] + 0.5, ny - 1 - pts[1][1] + 0.5);
        }
      }
    }
    ctx.stroke();
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
