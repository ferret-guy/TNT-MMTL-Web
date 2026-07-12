/**
 * Hand-rolled SVG log-x line chart for loss curves (keeps deps at zero).
 */
import type { LossCurve } from '../analysis/losses.ts';

export type LossUnit = 'dB/m' | 'dB/cm' | 'dB/inch';

const UNIT_FACTOR: Record<LossUnit, number> = {
  'dB/m': 1,
  'dB/cm': 0.01,
  'dB/inch': 0.0254,
};

const SERIES: Array<{ key: keyof Pick<LossCurve, 'alphaC' | 'alphaD' | 'alphaTotal'>; label: string; color: string; dash?: string }> = [
  { key: 'alphaTotal', label: 'total', color: '#1f6f43' },
  { key: 'alphaC', label: 'conductor', color: '#b3593a', dash: '6 3' },
  { key: 'alphaD', label: 'dielectric', color: '#3a6fb3', dash: '2 3' },
];

function niceTicks(min: number, max: number, n = 5): number[] {
  if (!(max > min)) return [min];
  const span = max - min;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => span / s <= n + 1) ?? mag * 10;
  const t0 = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let t = t0; t <= max + 1e-12; t += step) out.push(t);
  return out;
}

const fmtFreq = (f: number): string =>
  f >= 1e9 ? `${f / 1e9} GHz` : f >= 1e6 ? `${f / 1e6} MHz` : f >= 1e3 ? `${f / 1e3} kHz` : `${f} Hz`;

export function renderLossChart(svg: SVGSVGElement, curve: LossCurve, unit: LossUnit) {
  const W = 640;
  const H = 320;
  const m = { l: 56, r: 14, t: 12, b: 40 };
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = '';
  const ns = 'http://www.w3.org/2000/svg';
  const factor = UNIT_FACTOR[unit];

  const lx0 = Math.log10(curve.fHz[0]);
  const lx1 = Math.log10(curve.fHz[curve.fHz.length - 1]);
  const ymax = Math.max(...curve.alphaTotal.map((v) => v * factor)) * 1.08 || 1;

  const sx = (f: number) => m.l + ((Math.log10(f) - lx0) / (lx1 - lx0)) * (W - m.l - m.r);
  const sy = (v: number) => H - m.b - (v / ymax) * (H - m.t - m.b);

  const el = (tag: string, attrs: Record<string, string>, text?: string) => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    svg.appendChild(e);
    return e;
  };

  // grid: decades on x
  for (let d = Math.ceil(lx0); d <= Math.floor(lx1); d++) {
    const f = 10 ** d;
    el('line', { x1: String(sx(f)), y1: String(m.t), x2: String(sx(f)), y2: String(H - m.b), class: 'chart-grid' });
    el('text', { x: String(sx(f)), y: String(H - m.b + 16), 'text-anchor': 'middle', class: 'chart-tick' }, fmtFreq(f));
  }
  for (const t of niceTicks(0, ymax)) {
    el('line', { x1: String(m.l), y1: String(sy(t)), x2: String(W - m.r), y2: String(sy(t)), class: 'chart-grid' });
    el('text', { x: String(m.l - 6), y: String(sy(t) + 4), 'text-anchor': 'end', class: 'chart-tick' }, t.toPrecision(3).replace(/\.?0+$/, ''));
  }
  el('text', {
    x: '14',
    y: String((m.t + H - m.b) / 2),
    class: 'chart-axis',
    transform: `rotate(-90 14 ${(m.t + H - m.b) / 2})`,
    'text-anchor': 'middle',
  }, `attenuation (${unit})`);

  // series
  for (const s of SERIES) {
    const d = curve.fHz
      .map((f, i) => `${i ? 'L' : 'M'}${sx(f).toFixed(1)},${sy(curve[s.key][i] * factor).toFixed(1)}`)
      .join('');
    el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': '2', ...(s.dash ? { 'stroke-dasharray': s.dash } : {}) });
  }
  // legend
  SERIES.forEach((s, i) => {
    const x = m.l + 12 + i * 110;
    el('line', { x1: String(x), y1: '22', x2: String(x + 22), y2: '22', stroke: s.color, 'stroke-width': '2', ...(s.dash ? { 'stroke-dasharray': s.dash } : {}) });
    el('text', { x: String(x + 27), y: '26', class: 'chart-tick' }, s.label);
  });
}
