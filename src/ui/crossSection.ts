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
import { formatDim, type DimUnit } from './dimField.ts';

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
  /** top of the tallest feature incl. conductors/blocks */
  yMax: number;
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
  let yMax = 0;
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
        yMax = Math.max(yMax, y);
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
        yMax = Math.max(yMax, y + it.height);
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
          yMax = Math.max(yMax, y1);
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

  return { polys, domainX0: -totW, domainX1: 2 * totW, yTop, yMax, totW, signalNames };
}

/* ---------------- shared viewport ---------------- */

/** inner padding fraction of the SVG viewBox (field canvas aligns to this) */
export const VIEWPORT_PAD = 0.03;

export interface Viewport {
  vx0: number;
  vx1: number;
  vy0: number;
  vy1: number;
  W: number;
  H: number;
  sx: (x: number) => number;
  sy: (y: number) => number;
}

/**
 * Focus viewport centered on the conductors, with headroom above the tallest
 * feature so dimension callouts are never clipped.
 */
export function computeViewport(g: Geometry): Viewport {
  const conductors = g.polys.filter((p) => p.kind === 'conductor');
  let vx0 = g.domainX0;
  let vx1 = g.domainX1;
  if (conductors.length) {
    const cx0 = Math.min(...conductors.map((p) => p.x0));
    const cx1 = Math.max(...conductors.map((p) => p.x1));
    const focus = Math.max((cx1 - cx0) * 1.8, g.yMax * 4);
    vx0 = Math.max(g.domainX0, (cx0 + cx1) / 2 - focus / 2);
    vx1 = Math.min(g.domainX1, (cx0 + cx1) / 2 + focus / 2);
  }
  const gt = Math.max(g.yTop * 0.04, 0.5);
  const head = Math.max((g.yMax + gt) * 0.28, gt * 2); // callout headroom
  const vy0 = -gt * 1.6;
  const vy1 = g.yMax + head;
  const w = vx1 - vx0;
  const h = vy1 - vy0;
  const W = 640;
  const H = Math.max(220, Math.min(400, (W * h) / w));
  const pad = VIEWPORT_PAD;
  const sx = (x: number) => ((x - vx0) / w) * W * (1 - 2 * pad) + W * pad;
  const sy = (y: number) => H - (((y - vy0) / h) * H * (1 - 2 * pad) + H * pad);
  return { vx0, vx1, vy0, vy1, W, H, sx, sy };
}

/* ---------------- SVG rendering ---------------- */

const ER_COLORS = ['#d8ecd8', '#cfe4f4', '#efe3cd', '#e6d9ef', '#f4dede', '#d9efe9'];

function erColor(er: number, map: Map<number, string>): string {
  if (!map.has(er)) map.set(er, ER_COLORS[map.size % ER_COLORS.length]);
  return map.get(er)!;
}

export interface RenderOptions {
  /** show clickable w/s/t/h dimension callouts */
  showDims?: boolean;
  /** outline-only (for overlaying on the field heatmap) */
  outline?: boolean;
  /** dimension label clicked: focus the named form field */
  onDimClick?: (fieldId: string) => void;
  /** dimension hovered: glow the named form field so its mapping is obvious */
  onDimHover?: (fieldId: string, hovering: boolean) => void;
  /** display unit for callout labels (model values are mils) */
  displayUnit?: DimUnit;
}

export function renderCrossSection(
  svg: SVGSVGElement,
  s: Stackup,
  opts: RenderOptions = {},
): Viewport {
  const g = computeGeometry(s);
  const vp = computeViewport(g);
  const { sx, sy, W, H } = vp;

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = '';
  const ns = 'http://www.w3.org/2000/svg';
  const erMap = new Map<number, string>();
  const outline = !!opts.outline;

  const defs = document.createElementNS(ns, 'defs');
  defs.innerHTML = `<pattern id="gndhatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="6" height="6" fill="#8a97a8"/><line x1="0" y1="0" x2="0" y2="6" stroke="#5c6b7e" stroke-width="2"/>
    </pattern>`;
  svg.appendChild(defs);

  const poly = (pts: Array<[number, number]>, fill: string, stroke: string, title?: string) => {
    const el = document.createElementNS(ns, 'polygon');
    el.setAttribute('points', pts.map(([x, y]) => `${sx(x).toFixed(2)},${sy(y).toFixed(2)}`).join(' '));
    el.setAttribute('fill', outline ? 'none' : fill);
    el.setAttribute('stroke', outline ? 'rgba(30,30,30,0.8)' : stroke);
    el.setAttribute('stroke-width', outline ? '1.2' : '1');
    if (title && !outline) {
      const t = document.createElementNS(ns, 'title');
      t.textContent = title;
      el.appendChild(t);
    }
    svg.appendChild(el);
    return el;
  };

  // preset-generated conformal mask pieces render as ONE seamless outline
  // (drawn last, translucent, sides angled like the copper) instead of a
  // layer rect + lump rects with visible seams
  const isCoverPoly = (p: PlacedPoly) =>
    p.item != null && 'id' in p.item && /^cover(Layer|Lump)/.test((p.item as { id: string }).id);
  const coverLayer = g.polys.find((p) => p.kind === 'layer' && isCoverPoly(p));
  const coverLumps = g.polys.filter((p) => p.kind === 'block' && isCoverPoly(p));

  // layers first, then blocks, then grounds + conductors on top
  for (const p of g.polys.filter((p) => p.kind === 'layer' && !isCoverPoly(p))) {
    poly(p.pts, erColor(p.er!, erMap), '#b3c2ce', `εr = ${p.er}`);
  }
  for (const p of g.polys.filter((p) => p.kind === 'block' && !isCoverPoly(p))) {
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

  if (coverLayer) {
    // side slope matched to the first signal trapezoid's etch angle
    const trap = s.items.find((i) => i.kind === 'TrapezoidConductors');
    const slope =
      trap && trap.kind === 'TrapezoidConductors' && trap.height > 0
        ? Math.max(0, (trap.bottomWidth - trap.topWidth) / (2 * trap.height))
        : 0;
    const yB = coverLayer.y0;
    const yL = coverLayer.y1;
    const pts: Array<[number, number]> = [[coverLayer.x0, yB], [coverLayer.x0, yL]];
    for (const lump of [...coverLumps].sort((a, b) => a.x0 - b.x0)) {
      const hl = lump.y1 - lump.y0;
      const inset = Math.min(slope * hl, (lump.x1 - lump.x0) / 2 - 1e-9);
      pts.push([lump.x0, yL], [lump.x0 + inset, lump.y1], [lump.x1 - inset, lump.y1], [lump.x1, yL]);
    }
    pts.push([coverLayer.x1, yL], [coverLayer.x1, yB]);
    const el = poly(pts, erColor(coverLayer.er!, erMap), '#8aa5b8', `solder mask εr = ${coverLayer.er}`);
    if (!outline) el.setAttribute('fill-opacity', '0.55');
  }

  // dimension callouts: line + label grouped, hover glows the mapped form
  // field, click focuses it to edit
  const conductors = g.polys.filter((p) => p.kind === 'conductor');
  if (opts.showDims && !outline && conductors.length) {
    const sigs = conductors.filter((c) => !c.isGroundConductor);
    const unit = opts.displayUnit ?? 'mils';
    const unitLabel = unit === 'um' ? 'µm' : unit === 'inch' ? 'in' : unit;
    const fmt = (v: number) => formatDim(v, unit);

    /** one callout: dimension line + label + fat invisible hit line */
    const dim = (
      fieldId: string,
      lx0: number,
      ly0: number,
      lx1: number,
      ly1: number,
      tx: number,
      ty: number,
      label: string,
      anchor = 'middle',
    ) => {
      const grp = document.createElementNS(ns, 'g');
      grp.setAttribute('class', 'cs-dim-group');
      const mk = (cls: string) => {
        const l = document.createElementNS(ns, 'line');
        l.setAttribute('x1', String(lx0));
        l.setAttribute('y1', String(ly0));
        l.setAttribute('x2', String(lx1));
        l.setAttribute('y2', String(ly1));
        l.setAttribute('class', cls);
        grp.appendChild(l);
      };
      mk('cs-dimline');
      mk('cs-dim-hit'); // wide transparent stroke: generous hover/click target
      const t = document.createElementNS(ns, 'text');
      t.setAttribute('x', String(tx));
      t.setAttribute('y', String(ty));
      t.setAttribute('text-anchor', anchor);
      t.setAttribute('class', 'cs-dim');
      t.textContent = label;
      grp.appendChild(t);
      const tt = document.createElementNS(ns, 'title');
      tt.textContent = 'click to edit';
      grp.appendChild(tt);
      if (opts.onDimClick) grp.addEventListener('click', () => opts.onDimClick!(fieldId));
      if (opts.onDimHover) {
        grp.addEventListener('mouseenter', () => opts.onDimHover!(fieldId, true));
        grp.addEventListener('mouseleave', () => opts.onDimHover!(fieldId, false));
      }
      svg.appendChild(grp);
    };

    const c0 = sigs[0] ?? conductors[0];
    // w: above the first signal trace (headroom guaranteed by computeViewport)
    const yW = sy(c0.y1) - 8;
    dim('pf-w', sx(c0.x0), yW, sx(c0.x1), yW,
        (sx(c0.x0) + sx(c0.x1)) / 2, yW - 4, `w = ${fmt(c0.x1 - c0.x0)} ${unitLabel}`);
    // s (gap) for 2 signals
    if (sigs.length >= 2) {
      const yS = sy(sigs[0].y1) - 8;
      dim('pf-s', sx(sigs[0].x1), yS, sx(sigs[1].x0), yS,
          (sx(sigs[0].x1) + sx(sigs[1].x0)) / 2, yS - 4, `s = ${fmt(sigs[1].x0 - sigs[0].x1)}`);
    }
    // t: right of the first trace
    const xT = sx(c0.x1) + 8;
    dim('pf-t', xT, sy(c0.y0), xT, sy(c0.y1),
        xT + 4, (sy(c0.y0) + sy(c0.y1)) / 2 + 4, `t = ${fmt(c0.y1 - c0.y0)}`, 'start');
    // h (first layer below conductors)
    const firstLayer = g.polys.find((p) => p.kind === 'layer');
    if (firstLayer) {
      const lx = sx(vp.vx1) - 12;
      dim('pf-h', lx, sy(firstLayer.y0), lx, sy(firstLayer.y1),
          lx - 4, (sy(firstLayer.y0) + sy(firstLayer.y1)) / 2 + 4,
          `h = ${fmt(firstLayer.y1 - firstLayer.y0)}`, 'end');
    }
  }
  return vp;
}
