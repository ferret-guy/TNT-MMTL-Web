/**
 * Results tab: key figures + matrices, formatted with sensible units.
 */
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

function xtalkTable(title: string, list: SolveResult['fxt']): string {
  if (!list.length) return '';
  const rows = list
    .map(
      (x) =>
        `<tr><td>${esc(x.active)} → ${esc(x.passive)}</td><td>${eng(x.value)}</td><td>${
          x.dB == null ? '—∞' : x.dB.toFixed(1)
        } dB</td></tr>`,
    )
    .join('');
  return `
    <h6 class="mt-3 mb-1">${title}</h6>
    <div class="table-responsive"><table class="table table-sm table-bordered w-auto mb-2 font-monospace small">
      <thead><tr><th>pair</th><th>coefficient</th><th>dB</th></tr></thead><tbody>${rows}</tbody>
    </table></div>`;
}

export function renderResults(container: HTMLElement, out: SolveOutput | null) {
  if (!out) {
    container.innerHTML = `<p class="text-body-secondary mb-0">No results yet — press <strong>Solve</strong>.</p>`;
    return;
  }
  if (!out.ok || !out.result) {
    container.innerHTML = `
      <div class="alert alert-danger"><strong>Solve failed.</strong>
        ${out.error ? `<div class="font-monospace small mt-1">${esc(out.error)}</div>` : ''}
        <div class="small mt-1">See the Log tab for solver output.</div>
      </div>`;
    return;
  }
  const r = out.result;
  const diff = r.nSignals === 2 && r.zOdd != null && r.zEven != null;

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
    card(diff ? `Z₀ line ${i + 1} (isolated)` : `Characteristic impedance Z₀`, `${z.toFixed(2)} Ω`, esc(r.names[i] ?? '')),
  );
  if (r.epsEff.length) card('Effective εr', r.epsEff.map((e) => e.toFixed(3)).join(' / '));
  if (r.delay.length)
    card(
      'Propagation delay',
      r.delay.map((d) => `${(d * 1e12 / 1000).toFixed(2)}`).join(' / ') + ' ps/cm',
      diff && r.delayOdd != null ? `odd ${(r.delayOdd * 1e10).toFixed(2)} / even ${(r.delayEven! * 1e10).toFixed(2)} ps/cm` : '',
    );

  // The solver always prints "lossTangent and frequency are not used": its
  // BEM is quasi-static (L/C/Rdc from field geometry only). We explain that
  // properly below instead of echoing the alarming raw warning.
  const realWarnings = r.warnings.filter(
    (w) => !/lossTangent and frequency/i.test(w) && !/^\*+$/.test(w),
  );
  const warn = realWarnings.length
    ? `<div class="alert alert-warning py-2 small mt-2 mb-0">${realWarnings.map(esc).join('<br>')}</div>`
    : '';

  const minF = `<p class="small text-body-secondary mt-2 mb-0">
       The field solve is <strong>quasi-static</strong>: it computes L, C and R<sub>dc</sub> from the
       electrostatic field only — frequency and loss tangent do not enter the solver (they feed the
       analytic loss model on the Loss tab instead).${
         r.minFreqMHz
           ? ` The L/C values assume fully developed skin effect (current on the conductor surfaces),
       which for this cross-section holds above ≈${eng(r.minFreqMHz, 3)} MHz — that bound is physics,
       not a setting: it is where the skin depth shrinks below the smallest conductor dimension, so
       only thicker/wider copper (or lower conductivity) lowers it. Below it, inductance is slightly
       underestimated.`
           : ''
       }</p>`;

  container.innerHTML = `
    <div class="row row-cols-2 row-cols-xl-3 g-2">${cards.join('')}</div>
    ${warn}
    ${matrixTable('Capacitance matrix B', 'pF/m', r.names, r.B, 1e12)}
    ${matrixTable('Inductance matrix L', 'nH/m', r.names, r.L, 1e9)}
    ${matrixTable('DC resistance R<sub>dc</sub>', 'Ω/m', r.names, r.Rdc)}
    ${xtalkTable('Far-end (forward) crosstalk', r.fxt)}
    ${xtalkTable('Near-end (backward) crosstalk', r.bxt)}
    ${r.fxt.length ? '<p class="small text-body-secondary mb-0">Crosstalk assumes matched terminations (no reflections), per the solver.</p>' : ''}
    ${minF}
    <p class="small text-body-secondary mt-1 mb-0">Solve time: ${out.elapsedMs} ms</p>
  `;
}
