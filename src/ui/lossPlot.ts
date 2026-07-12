/**
 * Interactive loss plot (Plotly): total/conductor/dielectric insertion loss
 * for the entered line length, plotted as NEGATIVE dB vs frequency.
 * Pan/zoom/hover/export come from Plotly's standard mode bar.
 */
import Plotly from 'plotly.js-dist-min';
import type { LossCurve } from '../analysis/losses.ts';

const fmtFreq = (f: number): string =>
  f >= 1e9 ? `${+(f / 1e9).toPrecision(3)} GHz` : f >= 1e6 ? `${+(f / 1e6).toPrecision(3)} MHz` : `${+(f / 1e3).toPrecision(3)} kHz`;

export function renderLossPlot(
  el: HTMLElement,
  curve: LossCurve,
  lengthM: number,
  designFreqHz: number,
  modeLabel: string,
) {
  const L = lengthM;
  const mk = (key: 'alphaTotal' | 'alphaC' | 'alphaD', name: string, color: string, dash?: string) => ({
    x: curve.fHz,
    y: curve[key].map((a) => -a * L),
    name,
    mode: 'lines' as const,
    line: { color, width: 2, ...(dash ? { dash } : {}) },
    hovertemplate: '%{x:.3s}Hz: %{y:.3f} dB<extra>' + name + '</extra>',
  });

  const lenLabel = L >= 1 ? `${+L.toFixed(3)} m` : L >= 0.01 ? `${+(L * 100).toFixed(2)} cm` : `${+(L * 1000).toFixed(2)} mm`;

  Plotly.react(
    el,
    [
      mk('alphaTotal', 'total', '#1f6f43'),
      mk('alphaC', 'conductor', '#b3593a', 'dash'),
      mk('alphaD', 'dielectric', '#3a6fb3', 'dot'),
    ],
    {
      title: { text: `Insertion loss for ${lenLabel} (${modeLabel})`, font: { size: 14 } },
      xaxis: { type: 'log', title: { text: 'frequency' }, exponentformat: 'SI', ticksuffix: 'Hz' },
      yaxis: { title: { text: 'loss (dB)' }, rangemode: 'tozero', autorange: true },
      shapes: [
        {
          type: 'line',
          x0: designFreqHz,
          x1: designFreqHz,
          yref: 'paper',
          y0: 0,
          y1: 1,
          line: { color: 'rgba(120,120,120,0.6)', width: 1, dash: 'dot' },
        },
      ],
      annotations: [
        {
          x: Math.log10(designFreqHz),
          yref: 'paper',
          y: 1,
          yanchor: 'bottom',
          text: fmtFreq(designFreqHz),
          showarrow: false,
          font: { size: 11, color: 'rgba(120,120,120,1)' },
        },
      ],
      margin: { l: 60, r: 20, t: 40, b: 70 },
      legend: { orientation: 'h', y: -0.28 },
      font: { family: "'Atkinson Hyperlegible', system-ui, sans-serif" },
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
    },
    {
      responsive: true,
      displaylogo: false,
      toImageButtonOptions: { filename: 'tnt-web-loss', scale: 2 },
    },
  );
}
