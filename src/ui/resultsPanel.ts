/** Key figures and field-solver matrices, formatted with sensible units. */
import type { SolveOutput, SolveResult } from '../model/types.ts';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const eng = (v: number, digits = 4): string => {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  return v.toPrecision(digits);
};

function matrixTable(title: string, unitLabel: string, names: string[], M: number[][], scale = 1): string {
  if (!M.length) return '';
  const head = names.map((n) => `<th>${esc(n)}</th>`).join('');
  const rows = M.map(
    (row, i) =>
      `<tr><th>${esc(names[i] ?? String(i + 1))}</th>${row
        .map((v) => `<td>${eng(v * scale)}</td>`)
        .join('')}</tr>`,
  ).join('');
  return `
    <h6 class="mt-3 mb-1">${title} <span class="text-body-secondary fw-normal">(${unitLabel})</span></h6>
    <div class="table-responsive"><table class="table table-sm table-bordered w-auto mb-2 font-monospace small">
      <thead><tr><th></th>${head}</tr></thead><tbody>${rows}</tbody>
    </table></div>`;
}

function xtalkTable(
  title: string,
  list: SolveResult['fxt'],
  displayName: (name: string) => string,
): string {
  if (!list.length) return '';
  const rows = list
    .map(
      (x) =>
        `<tr><td>${esc(displayName(x.active))} → ${esc(displayName(x.passive))}</td><td>${eng(x.value)}</td><td>${
          x.dB == null ? '−∞' : x.dB.toFixed(1)
        } dB</td></tr>`,
    )
    .join('');
  return `
    <h6 class="mt-3 mb-1">${title}</h6>
    <div class="table-responsive"><table class="table table-sm table-bordered w-auto mb-2 font-monospace small">
      <thead><tr><th>pair</th><th>coefficient</th><th>dB</th></tr></thead><tbody>${rows}</tbody>
    </table></div>`;
}

export function renderResults(
  summaryContainer: HTMLElement,
  matricesContainer: HTMLElement,
  out: SolveOutput | null,
  showAdvancedNames = false,
) {
  if (!out) {
    summaryContainer.innerHTML = `<p class="text-body-secondary mb-0">No results yet — press <strong>Solve</strong>.</p>`;
    matricesContainer.innerHTML = '';
    return;
  }
  if (!out.ok || !out.result) {
    summaryContainer.innerHTML = `
      <div class="alert alert-danger"><strong>Solve failed.</strong>
        ${out.error ? `<div class="font-monospace small mt-1">${esc(out.error)}</div>` : ''}
        <div class="small mt-1">See the Log section for solver output.</div>
      </div>`;
    matricesContainer.innerHTML = '';
    return;
  }
  const r = out.result;
  const diff = r.nSignals === 2 && r.zOdd != null && r.zEven != null;
  const resultNames = showAdvancedNames ? r.names : r.names.map((_, i) => `Line ${i + 1}`);
  const displayName = (name: string) => {
    const i = r.names.indexOf(name);
    return i >= 0 ? (resultNames[i] ?? name) : name;
  };

  const cards: string[] = [];
  const card = (label: string, value: string, sub = '') =>
    cards.push(`<div class="col"><div class="card h-100"><div class="card-body py-2 px-3">
      <div class="small text-body-secondary">${label}</div>
      <div class="fs-5 font-monospace">${value}</div>
      ${sub ? `<div class="small text-body-secondary">${sub}</div>` : ''}
    </div></div></div>`);

  if (diff) {
    card('Differential Z', `${(2 * r.zOdd!).toFixed(2)} Ω`, 'Z<sub>diff</sub> = 2·Z<sub>odd</sub>');
    card('Odd / Even', `${r.zOdd!.toFixed(2)} / ${r.zEven!.toFixed(2)} Ω`);
    card('Common-mode Z', `${(r.zEven! / 2).toFixed(2)} Ω`, 'Z<sub>comm</sub> = Z<sub>even</sub>/2');
  }
  r.z0.forEach((z, i) =>
    card(
      diff ? `Z₀ line ${i + 1} (isolated)` : 'Impedance',
      `${z.toFixed(2)} Ω`,
      showAdvancedNames ? esc(r.names[i] ?? '') : '',
    ),
  );
  if (r.epsEff.length) card('Effective εr', r.epsEff.map((e) => e.toFixed(3)).join(' / '));
  if (r.delay.length)
    card(
      'Propagation delay',
      r.delay.map((d) => `${(d * 1e12 / 1000).toFixed(2)}`).join(' / ') + ' ps/cm',
      diff && r.delayOdd != null ? `odd ${(r.delayOdd * 1e10).toFixed(2)} / even ${(r.delayEven! * 1e10).toFixed(2)} ps/cm` : '',
    );

  // The solver always prints "lossTangent and frequency are not used". Hide
  // that implementation warning and show only its useful validity threshold.
  const realWarnings = r.warnings
    .map((w) => w.trim())
    .filter((w) => w.length > 0 && !/lossTangent and frequency/i.test(w) && !/^\*+$/.test(w));
  const warn = realWarnings.length
    ? `<div class="alert alert-warning py-2 small mt-2 mb-0">${realWarnings.map(esc).join('<br>')}</div>`
    : '';

  summaryContainer.innerHTML = `
    <div class="row row-cols-2 row-cols-xl-3 g-2">${cards.join('')}</div>
    ${warn}
  `;

  matricesContainer.innerHTML = `
    ${matrixTable('Capacitance matrix B', 'pF/m', resultNames, r.B, 1e12)}
    ${matrixTable('Inductance matrix L', 'nH/m', resultNames, r.L, 1e9)}
    ${matrixTable('DC resistance R<sub>dc</sub>', 'Ω/m', resultNames, r.Rdc)}
    ${xtalkTable('Far-end (forward) crosstalk', r.fxt, displayName)}
    ${xtalkTable('Near-end (backward) crosstalk', r.bxt, displayName)}
    <p class="small text-body-secondary mt-1 mb-0">Solve time: ${out.elapsedMs} ms</p>
  `;
}
