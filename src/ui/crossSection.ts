/**
 * Cross-section geometry + SVG rendering, reimplementing the solver parser's
 * placement semantics (nmmtl_parse_xsctn.cpp):
 *  - dielectric layers stack bottom->top from y=0, full domain width
 *  - conductor sets sit on the top of the last dielectric layer (+ yOffset);
 *    set members repeat every `pitch` starting at xOffset
 *  - rectangles are left-aligned at cx; trapezoids are centered at
 *    cx + max(top,bottom)/2; circles center at cx + d/2 -- all span
 *    [cx, cx + maxWidth]
 *  - RectangleDielectric blocks sit on the current layer top (the parser
 *    parses but IGNORES their yOffset) at [xOffset, xOffset+width]
 *  - domain (dielectric/ground extent) is x in [-totW, +2 totW], where
 *    totW = max over conductor sets of (xOffset + (n-1) pitch + maxWidth)
 *  - bottom ground plane at y=0; top ground plane (if 2) at the top of the
 *    highest dielectric layer
 */
import type { Stackup, StackupItem } from '../model/types.ts';
import { isConductor } from '../model/types.ts';

export interface PlacedPoly {
  kind: 'layer' | 'block' | 'conductor' | 'ground';
  item: StackupItem | null;
  /** polygon in stackup units */
  pts: Array<[number, number]>;
  /** bbox */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  isGroundConductor: boolean;
  er?: number;
  signalIndex?: number; // 0-based among signals, matches solver naming order
}

export interface Geometry {
  polys: PlacedPoly[];
  domainX0: number;
  domainX1: number;
  yTop: number; // top of highest dielectric
  totW: number;
  signalNames: string[];
}

const rectPts = (x0: number, y0: number, x1: number, y1: number): Array<[number, number]> => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

export function computeGeometry(s: Stackup): Geometry {
  let y = 0;
  let totW = 0;
  let yTop = 0;
  const polys: PlacedPoly[] = [];
  const signalNames: string[] = [];
  let groundPlanes = 0;
  let signalIdx = 0;

  // first pass: totW (domain) from conductor sets
  for (const it of s.items) {
    if (!isConductor(it)) continue;
    const w =
      it.kind === 'RectangleConductors'
        ? it.width
        : it.kind === 'TrapezoidConductors'
          ? Math.max(it.topWidth, it.bottomWidth)
          : it.diameter;
    totW = Math.max(totW, it.xOffset + (it.number - 1) * it.pitch + w);
  }
  if (totW <= 0) totW = 1;

  for (const it of s.items) {
    switch (it.kind) {
      case 'GroundPlane':
        groundPlanes++;
        break;
      case 'DielectricLayer': {
        polys.push({
          kind: 'layer',
          item: it,
          pts: rectPts(-totW, y, 2 * totW, y + it.thickness),
          x0: -totW,
          y0: y,
          x1: 2 * totW,
          y1: y + it.thickness,
          isGroundConductor: false,
          er: it.permittivity,
        });
        y += it.thickness;
        yTop = Math.max(yTop, y);
        break;
      }
      case 'RectangleDielectric': {
        // parser ignores yOffset for blocks: they sit on the current layer top
        polys.push({
          kind: 'block',
          item: it,
          pts: rectPts(it.xOffset, y, it.xOffset + it.width, y + it.height),
          x0: it.xOffset,
          y0: y,
          x1: it.xOffset + it.width,
          y1: y + it.height,
          isGroundConductor: false,
          er: it.permittivity,
        });
        break;
      }
      default: {
        // conductor set
        const cy = y + it.yOffset;
        for (let k = 0; k < it.number; k++) {
          const cx = it.xOffset + k * it.pitch;
          let pts: Array<[number, number]>;
          let x0: number;
          let x1: number;
          let y1: number;
          if (it.kind === 'RectangleConductors') {
            x0 = cx;
            x1 = cx + it.width;
            y1 = cy + it.height;
            pts = rectPts(x0, cy, x1, y1);
          } else if (it.kind === 'TrapezoidConductors') {
            const wmax = Math.max(it.topWidth, it.bottomWidth);
            const cxc = cx + wmax / 2;
            x0 = cx;
            x1 = cx + wmax;
            y1 = cy + it.height;
            pts = [
              [cxc - it.bottomWidth / 2, cy],
              [cxc + it.bottomWidth / 2, cy],
              [cxc + it.topWidth / 2, y1],
              [cxc - it.topWidth / 2, y1],
            ];
          } else {
            const r = it.diameter / 2;
            const ccx = cx + r;
            const ccy = cy + r;
            x0 = cx;
            x1 = cx + it.diameter;
            y1 = cy + it.diameter;
            pts = [];
            for (let a = 0; a < 24; a++) {
              const th = (a / 24) * 2 * Math.PI;
              pts.push([ccx + r * Math.cos(th), ccy + r * Math.sin(th)]);
            }
          }
          const sig = !it.isGround;
          polys.push({
            kind: 'conductor',
            item: it,
            pts,
            x0,
            y0: cy,
            x1,
            y1,
            isGroundConductor: it.isGround,
            signalIndex: sig ? signalIdx : undefined,
          });
          if (sig) {
            signalNames.push(`signal ${signalIdx + 1}`);
            signalIdx++;
          }
        }
      }
    }
  }

  // ground planes: bottom at y=0 (drawn below), top at yTop
  const gt = Math.max(yTop * 0.04, 0.5);
  if (groundPlanes >= 1) {
    polys.push({
      kind: 'ground',
      item: null,
      pts: rectPts(-totW, -gt, 2 * totW, 0),
      x0: -totW,
      y0: -gt,
      x1: 2 * totW,
      y1: 0,
      isGroundConductor: true,
    });
  }
  if (groundPlanes >= 2) {
    polys.push({
      kind: 'ground',
      item: null,
      pts: rectPts(-totW, yTop, 2 * totW, yTop + gt),
      x0: -totW,
      y0: yTop,
      x1: 2 * totW,
      y1: yTop + gt,
      isGroundConductor: true,
    });
  }

  return { polys, domainX0: -totW, domainX1: 2 * totW, yTop, totW, signalNames };
}

/* ---------------- SVG rendering ---------------- */

const ER_COLORS = ['#d8ecd8', '#cfe4f4', '#efe3cd', '#e6d9ef', '#f4dede', '#d9efe9'];

function erColor(er: number, map: Map<number, string>): string {
  if (!map.has(er)) map.set(er, ER_COLORS[map.size % ER_COLORS.length]);
  return map.get(er)!;
}

export interface RenderOptions {
  /** show w/s/t/h dimension callouts (preset mode) */
  showDims?: boolean;
}

export function renderCrossSection(svg: SVGSVGElement, s: Stackup, opts: RenderOptions = {}) {
  const g = computeGeometry(s);
  const pad = 0.06;
  // focus view: center on conductors with margins, not the whole 3*totW domain
  const conductors = g.polys.filter((p) => p.kind === 'conductor');
  let vx0 = g.domainX0;
  let vx1 = g.domainX1;
  if (conductors.length) {
    const cx0 = Math.min(...conductors.map((p) => p.x0));
    const cx1 = Math.max(...conductors.map((p) => p.x1));
    const focus = Math.max((cx1 - cx0) * 1.8, g.yTop * 4);
    vx0 = Math.max(g.domainX0, (cx0 + cx1) / 2 - focus / 2);
    vx1 = Math.min(g.domainX1, (cx0 + cx1) / 2 + focus / 2);
  }
  const gt = Math.max(g.yTop * 0.04, 0.5);
  const vy0 = -gt * 1.5;
  const vy1 = g.yTop + gt * 1.5;
  const w = vx1 - vx0;
  const h = vy1 - vy0;
  const W = 640;
  const H = Math.max(200, Math.min(360, (W * h) / w));
  const sx = (x: number) => ((x - vx0) / w) * W * (1 - 2 * pad) + W * pad;
  const sy = (y: number) => H - (((y - vy0) / h) * H * (1 - 2 * pad) + H * pad);

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = '';
  const ns = 'http://www.w3.org/2000/svg';
  const erMap = new Map<number, string>();

  const defs = document.createElementNS(ns, 'defs');
  defs.innerHTML = `<pattern id="gndhatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="6" height="6" fill="#8a97a8"/><line x1="0" y1="0" x2="0" y2="6" stroke="#5c6b7e" stroke-width="2"/>
    </pattern>`;
  svg.appendChild(defs);

  const poly = (pts: Array<[number, number]>, fill: string, stroke: string, title?: string) => {
    const el = document.createElementNS(ns, 'polygon');
    el.setAttribute('points', pts.map(([x, y]) => `${sx(x).toFixed(2)},${sy(y).toFixed(2)}`).join(' '));
    el.setAttribute('fill', fill);
    el.setAttribute('stroke', stroke);
    el.setAttribute('stroke-width', '1');
    if (title) {
      const t = document.createElementNS(ns, 'title');
      t.textContent = title;
      el.appendChild(t);
    }
    svg.appendChild(el);
    return el;
  };

  // layers first, then blocks, then grounds + conductors on top
  for (const p of g.polys.filter((p) => p.kind === 'layer')) {
    poly(p.pts, erColor(p.er!, erMap), '#b3c2ce', `εr = ${p.er}`);
  }
  for (const p of g.polys.filter((p) => p.kind === 'block')) {
    poly(p.pts, erColor(p.er!, erMap), '#9fb2c0', `dielectric block εr = ${p.er}`);
  }
  for (const p of g.polys.filter((p) => p.kind === 'ground')) {
    poly(p.pts, 'url(#gndhatch)', '#5c6b7e', 'ground plane');
  }
  for (const p of g.polys.filter((p) => p.kind === 'conductor')) {
    poly(
      p.pts,
      p.isGroundConductor ? 'url(#gndhatch)' : '#e8b64c',
      p.isGroundConductor ? '#5c6b7e' : '#a97e17',
      p.isGroundConductor ? 'ground strip' : `signal conductor`,
    );
  }

  // dimension callouts
  if (opts.showDims && conductors.length) {
    const sigs = conductors.filter((c) => !c.isGroundConductor);
    const text = (x: number, y: number, str: string, anchor = 'middle') => {
      const t = document.createElementNS(ns, 'text');
      t.setAttribute('x', String(x));
      t.setAttribute('y', String(y));
      t.setAttribute('text-anchor', anchor);
      t.setAttribute('class', 'cs-dim');
      t.textContent = str;
      svg.appendChild(t);
    };
    const arrow = (x0: number, y0: number, x1: number, y1: number) => {
      const l = document.createElementNS(ns, 'line');
      l.setAttribute('x1', String(x0));
      l.setAttribute('y1', String(y0));
      l.setAttribute('x2', String(x1));
      l.setAttribute('y2', String(y1));
      l.setAttribute('class', 'cs-dimline');
      svg.appendChild(l);
    };
    const c0 = sigs[0] ?? conductors[0];
    // w
    arrow(sx(c0.x0), sy(c0.y1) - 6, sx(c0.x1), sy(c0.y1) - 6);
    text((sx(c0.x0) + sx(c0.x1)) / 2, sy(c0.y1) - 10, `w = ${(c0.x1 - c0.x0).toPrecision(3)} ${s.units}`);
    // s (gap) for 2 signals
    if (sigs.length >= 2) {
      const gap = sigs[1].x0 - sigs[0].x1;
      arrow(sx(sigs[0].x1), sy(c0.y1) - 6, sx(sigs[1].x0), sy(c0.y1) - 6);
      text((sx(sigs[0].x1) + sx(sigs[1].x0)) / 2, sy(c0.y1) - 10, `s = ${gap.toPrecision(3)}`);
    }
    // h (first layer below conductors)
    const firstLayer = g.polys.find((p) => p.kind === 'layer');
    if (firstLayer) {
      const lx = sx(vx1) - 14;
      arrow(lx, sy(firstLayer.y0), lx, sy(firstLayer.y1));
      text(lx - 4, (sy(firstLayer.y0) + sy(firstLayer.y1)) / 2 + 4, `h = ${(firstLayer.y1 - firstLayer.y0).toPrecision(3)}`, 'end');
    }
  }
}
