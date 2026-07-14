/**
 * Cross-section geometry + SVG rendering, reimplementing the solver parser's
 * placement semantics (nmmtl_parse_xsctn.cpp):
 *  - dielectric layers stack bottom->top from y=0, full domain width
 *  - conductor sets sit on the top of the last dielectric layer (+ yOffset);
 *    set members repeat every `pitch` starting at xOffset
 *  - rectangles are left-aligned at cx; trapezoids are centered at
 *    cx + max(top,bottom)/2; circles center at cx + d/2 -- all span
 *    [cx, cx + maxWidth]
 *  - dielectric blocks sit above the current layer top plus yOffset;
 *    trapezoids are centered in max(topWidth,bottomWidth), matching the
 *    conductor placement convention
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
        const by = y + it.yOffset;
        polys.push({
          kind: 'block',
          item: it,
          pts: rectPts(it.xOffset, by, it.xOffset + it.width, by + it.height),
          x0: it.xOffset,
          y0: by,
          x1: it.xOffset + it.width,
          y1: by + it.height,
          isGroundConductor: false,
          er: it.permittivity,
        });
        yMax = Math.max(yMax, by + it.height);
        break;
      }
      case 'TrapezoidDielectric': {
        const wmax = Math.max(it.topWidth, it.bottomWidth);
        const cxc = it.xOffset + wmax / 2;
        const by = y + it.yOffset;
        const ty = by + it.height;
        const bx0 = cxc - it.bottomWidth / 2;
        const bx1 = cxc + it.bottomWidth / 2;
        const tx0 = cxc - it.topWidth / 2;
        const tx1 = cxc + it.topWidth / 2;
        polys.push({
          kind: 'block',
          item: it,
          pts: [[bx0, by], [bx1, by], [tx1, ty], [tx0, ty]],
          x0: it.xOffset,
          y0: by,
          x1: it.xOffset + wmax,
          y1: ty,
          isGroundConductor: false,
          er: it.permittivity,
        });
        yMax = Math.max(yMax, ty);
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
  // Three horizontal callout lanes are needed by differential CPW
  // (width/ground width, coplanar gap, pair gap).
  const head = Math.max((g.yMax + gt) * 0.38, gt * 2); // callout headroom
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
  /** preset mask thicknesses used for mask dimension callouts */
  coverProfile?: { tCopper: number; tBase: number; tBetween: number };
  /** active guided preset, used to map geometry-specific callouts */
  presetKind?: 'microstrip' | 'stripline' | 'cpw';
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

  // Preset-generated mask blocks render as one seamless profile instead of
  // several touching rectangles with artificial internal strokes. The
  // resulting polygon follows the exact same region tops used by the BEM.
  const coverId = (p: PlacedPoly) =>
    p.item != null && 'id' in p.item ? (p.item as { id: string }).id : '';
  const isLegacyCoverPoly = (p: PlacedPoly) => /^cover(Layer|Lump)/.test(coverId(p));
  const isCoverRegion = (p: PlacedPoly) => /^coverRegion/.test(coverId(p));
  const isExactCoverPoly = (p: PlacedPoly) => /^cover(BaseLayer|Shoulder)/.test(coverId(p));
  const isCoverPoly = (p: PlacedPoly) =>
    isLegacyCoverPoly(p) || isCoverRegion(p) || isExactCoverPoly(p);
  const coverLayer = g.polys.find((p) => p.kind === 'layer' && isLegacyCoverPoly(p));
  const exactCoverLayer = g.polys.find(
    (p) => p.kind === 'layer' && coverId(p) === 'coverBaseLayer',
  );
  const coverLumps = g.polys.filter((p) => p.kind === 'block' && isLegacyCoverPoly(p));
  const coverRegions = g.polys
    .filter((p) => p.kind === 'block' && isCoverRegion(p))
    .sort((a, b) => a.x0 - b.x0);

  // layers first, then blocks, then grounds + conductors on top
  for (const p of g.polys.filter((p) => p.kind === 'layer' && !isCoverPoly(p))) {
    poly(p.pts, erColor(p.er!, erMap), '#b3c2ce', `εr = ${p.er}`);
  }
  for (const p of g.polys.filter((p) => p.kind === 'block' && !isCoverPoly(p))) {
    poly(p.pts, erColor(p.er!, erMap), '#9fb2c0', `dielectric block εr = ${p.er}`);
  }
  // The production solve's tied C1/C3 base layer and mitered C2 shoulders are
  // already the exact desired polygons. Paint those same polygons without
  // internal strokes so they read as one conformal mask profile in the SVG.
  for (const p of g.polys.filter(isExactCoverPoly)) {
    const el = poly(p.pts, erColor(p.er!, erMap), 'none', `solder mask εr = ${p.er}`);
    if (!outline) el.setAttribute('fill-opacity', '0.55');
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

  if (coverRegions.length) {
    const first = coverRegions[0];
    const last = coverRegions[coverRegions.length - 1];
    const pts: Array<[number, number]> = [
      [first.x0, first.y0],
      [first.x0, first.y1],
    ];
    for (let i = 0; i < coverRegions.length; i++) {
      const region = coverRegions[i];
      pts.push([region.x1, region.y1]);
      const next = coverRegions[i + 1];
      if (next && Math.abs(next.y1 - region.y1) > 1e-9) {
        pts.push([region.x1, next.y1]);
      }
    }
    pts.push([last.x1, last.y0]);
    const el = poly(pts, erColor(first.er!, erMap), '#8aa5b8', `solder mask εr = ${first.er}`);
    if (!outline) el.setAttribute('fill-opacity', '0.55');
  } else if (coverLayer) {
    // side slope matched to the first signal trapezoid's etch angle
    const trap = s.items.find((i) => i.kind === 'TrapezoidConductors');
    const slope =
      trap && trap.kind === 'TrapezoidConductors' && trap.height > 0
        ? Math.max(0, (trap.bottomWidth - trap.topWidth) / (2 * trap.height))
        : 0;
    const yB = coverLayer.y0;
    const pts: Array<[number, number]> = [];
    const prof = opts.coverProfile;
    if (prof) {
      // true conformal profile: tBase on the laminate, tBetween in the gaps,
      // tCopper riding over each conductor with etch-angled shoulders
      const spans: Array<{ x0: number; x1: number; top: number }> = [];
      for (const c of g.polys
        .filter((q) => q.kind === 'conductor' && q.y0 >= yB - 1e-9)
        .sort((a, b) => a.x0 - b.x0)) {
        const last = spans[spans.length - 1];
        if (last && c.x0 <= last.x1 + 2 * prof.tCopper) {
          last.x1 = Math.max(last.x1, c.x1);
          last.top = Math.max(last.top, c.y1);
        } else spans.push({ x0: c.x0, x1: c.x1, top: c.y1 });
      }
      pts.push([coverLayer.x0, yB], [coverLayer.x0, yB + prof.tBase]);
      let xPrev = coverLayer.x0;
      const push = (x: number, y: number) => {
        pts.push([Math.max(x, xPrev), y]); // keep the surface x-monotonic
        xPrev = Math.max(x, xPrev);
      };
      for (let i = 0; i < spans.length; i++) {
        const sp = spans[i];
        const hIn = yB + (i === 0 ? prof.tBase : prof.tBetween);
        const hOut = yB + (i === spans.length - 1 ? prof.tBase : prof.tBetween);
        const hTop = sp.top + prof.tCopper;
        const inset = Math.min(slope * (sp.top - yB), (sp.x1 - sp.x0) / 2 - 1e-9);
        push(sp.x0 - prof.tCopper, hIn);
        push(sp.x0 + inset, hTop);
        push(sp.x1 - inset, hTop);
        push(sp.x1 + prof.tCopper, hOut);
      }
      push(coverLayer.x1, yB + prof.tBase);
      pts.push([coverLayer.x1, yB]);
    } else {
      // free-form: profile straight off the slab + lump solver geometry
      const yL = coverLayer.y1;
      pts.push([coverLayer.x0, yB], [coverLayer.x0, yL]);
      for (const lump of [...coverLumps].sort((a, b) => a.x0 - b.x0)) {
        const hl = lump.y1 - lump.y0;
        const inset = Math.min(slope * hl, (lump.x1 - lump.x0) / 2 - 1e-9);
        pts.push([lump.x0, yL], [lump.x0 + inset, lump.y1], [lump.x1 - inset, lump.y1], [lump.x1, yL]);
      }
      pts.push([coverLayer.x1, yL], [coverLayer.x1, yB]);
    }
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
      textClass = '',
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
      t.setAttribute('class', `cs-dim${textClass ? ` ${textClass}` : ''}`);
      t.textContent = label;
      grp.appendChild(t);
      const tt = document.createElementNS(ns, 'title');
      tt.textContent = `${label}; click to edit`;
      grp.appendChild(tt);
      if (opts.onDimClick) grp.addEventListener('click', () => opts.onDimClick!(fieldId));
      if (opts.onDimHover) {
        grp.addEventListener('mouseenter', () => opts.onDimHover!(fieldId, true));
        grp.addEventListener('mouseleave', () => opts.onDimHover!(fieldId, false));
      }
      svg.appendChild(grp);
    };

    const c0 = sigs[0] ?? conductors[0];
    const isCpw = opts.presetKind === 'cpw';
    const groundStrips = conductors
      .filter((c) => c.isGroundConductor)
      .sort((a, b) => a.x0 - b.x0);
    const leftGround = groundStrips
      .filter((ground) => ground.x1 <= c0.x0 + 1e-9)
      .at(-1);
    const lastSignal = sigs[sigs.length - 1] ?? c0;
    const rightGround = groundStrips.find(
      (ground) => ground.x0 >= lastSignal.x1 - 1e-9,
    );
    // Keep horizontal dimensions in explicit lanes.  Narrow differential
    // traces can have labels wider than both w and s, so relying on their x
    // positions alone makes the two labels collide.
    const topSurface = sy(c0.y1 + (opts.coverProfile?.tCopper ?? 0));
    const yW = topSurface - 9;
    const ySecondary = topSurface - 27;
    const yTertiary = topSurface - 45;
    dim('pf-w', sx(c0.x0), yW, sx(c0.x1), yW,
        (sx(c0.x0) + sx(c0.x1)) / 2, yW - 4, `w = ${fmt(c0.x1 - c0.x0)} ${unitLabel}`);
    // s (gap) for 2 signals
    if (sigs.length >= 2) {
      const yS = ySecondary;
      dim('pf-s', sx(sigs[0].x1), yS, sx(sigs[1].x0), yS,
          (sx(sigs[0].x1) + sx(sigs[1].x0)) / 2, yS - 4, `s = ${fmt(sigs[1].x0 - sigs[0].x1)}`);
    }
    // CPW-specific dimensions use the left ground/signal opening. Both
    // flanks share the same width and gap fields, so one callout is enough.
    if (isCpw && leftGround) {
      const yCpw = sigs.length >= 2 ? yTertiary : ySecondary;
      const widthGround = rightGround ?? leftGround;
      dim('pf-cpwGroundWidth', sx(widthGround.x0), yCpw, sx(widthGround.x1), yCpw,
          (sx(widthGround.x0) + sx(widthGround.x1)) / 2, yCpw - 4,
          `wg = ${fmt(widthGround.x1 - widthGround.x0)}`);
      dim('pf-cpwGap', sx(leftGround.x1), yCpw, sx(c0.x0), yCpw,
          (sx(leftGround.x1) + sx(c0.x0)) / 2, yCpw - 4,
          `g = ${fmt(c0.x0 - leftGround.x1)}`);
    }
    // t: centered on the copper instead of sharing the crowded mask lanes.
    // The compact label deliberately omits the unit (w already establishes
    // it); the full value remains available in the callout's SVG title.
    const xT = (sx(c0.x0) + sx(c0.x1)) / 2;
    const yT = (sy(c0.y0) + sy(c0.y1)) / 2;
    dim('pf-t', xT, sy(c0.y0), xT, sy(c0.y1),
        xT, yT, `t=${fmt(c0.y1 - c0.y0)}`, 'middle', 'cs-dim-on-copper');
    // h is the substrate below the trace. Plain CPW has a synthetic air
    // spacer below that substrate, so identify the preset layer by id rather
    // than blindly dimensioning the first dielectric.
    const hLayerId = opts.presetKind === 'stripline' ? 'sub1' : 'sub';
    const hLayer = g.polys.find(
      (p) => p.kind === 'layer' && p.item != null && 'id' in p.item && p.item.id === hLayerId,
    ) ?? g.polys.find((p) => p.kind === 'layer');
    if (hLayer) {
      const lx = sx(vp.vx1) - 12;
      dim('pf-h', lx, sy(hLayer.y0), lx, sy(hLayer.y1),
          lx - 4, (sy(hLayer.y0) + sy(hLayer.y1)) / 2 + 4,
          `h = ${fmt(hLayer.y1 - hLayer.y0)}`, 'end');
      // Stripline h2 is measured from the copper top to the upper ground,
      // not across the conductor thickness.
      if (opts.presetKind === 'stripline') {
        const upperLayer = g.polys.find(
          (p) => p.kind === 'layer' && p.item != null && 'id' in p.item && p.item.id === 'sub2',
        );
        if (upperLayer && upperLayer.y1 > c0.y1) {
          const lx2 = sx(vp.vx0) + 12;
          dim('pf-h2', lx2, sy(c0.y1), lx2, sy(upperLayer.y1),
              lx2 + 4, (sy(c0.y1) + sy(upperLayer.y1)) / 2 + 4,
              `h₂ = ${fmt(upperLayer.y1 - c0.y1)}`, 'start');
        }
      }
    }
    // solder-mask thicknesses (preset cover on)
    const coverBaseY = exactCoverLayer?.y0 ?? coverRegions[0]?.y0 ?? coverLayer?.y0;
    if (opts.coverProfile && coverBaseY !== undefined) {
      const prof = opts.coverProfile;
      // over copper: left of the first signal trace (t sits on the right)
      const xM = sx(c0.x0) - 8;
      dim('pf-cover-cu', xM, sy(c0.y1), xM, sy(c0.y1 + prof.tCopper),
          xM - 4, (sy(c0.y1) + sy(c0.y1 + prof.tCopper)) / 2 + 3,
          `mask = ${fmt(prof.tCopper)}`, 'end');
      // base thickness on the laminate: far left (h sits far right)
      const xB = sx(vp.vx0) + 12;
      dim('pf-cover-base', xB, sy(coverBaseY), xB, sy(coverBaseY + prof.tBase),
          xB + 4, (sy(coverBaseY) + sy(coverBaseY + prof.tBase)) / 2 + 3,
          `mask = ${fmt(prof.tBase)}`, 'start');
    }
  }
  return vp;
}
