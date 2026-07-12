/**
 * App bootstrap: wiring between store, solver client, and UI panels.
 */
import 'bootstrap/dist/css/bootstrap.min.css';
import '@fontsource/atkinson-hyperlegible/400.css';
import '@fontsource/atkinson-hyperlegible/700.css';
import './style.css';
import { Tab } from 'bootstrap';

import { store, currentStackup } from './model/store.ts';
import { generateXsctn, validateStackup } from './xsctn/generate.ts';
import { SolverClient } from './solver/client.ts';
import { renderPresetForm } from './ui/presetForm.ts';
import { renderStackupEditor } from './ui/stackupEditor.ts';
import { renderResults } from './ui/resultsPanel.ts';
import { computeGeometry, renderCrossSection } from './ui/crossSection.ts';
import { renderLossChart, type LossUnit } from './ui/lossChart.ts';
import { lossCurve, lossInputsFrom, UNIT_SCALE } from './analysis/losses.ts';
import { drawColorbar, drawHeatmap } from './field/heatmap.ts';
import { isConductor, isSignal, type ConductorItem, type Stackup } from './model/types.ts';

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el as T;
};

const client = new SolverClient();

/* ---------------- solver status probe ---------------- */
(async () => {
  const status = $('#solver-status');
  try {
    const res = await fetch(new URL(`${import.meta.env.BASE_URL}wasm/bem.wasm`, location.href), { method: 'HEAD' });
    status.textContent = res.ok ? 'solver: ready (wasm loaded on demand)' : 'solver: bem.wasm missing!';
  } catch {
    status.textContent = 'solver: bem.wasm missing!';
  }
})();

/* ---------------- input panels ---------------- */
const presetPane = $('#tab-preset');
const freeformPane = $('#tab-freeform');

function goalSeekHook() {
  return async (
    mode: 'z0' | 'zdiff' | 'zodd' | 'zeven',
    seekParam: 'w' | 's',
    target: number,
    onIter: Parameters<SolverClient['goalSeek']>[1],
  ) => {
    const s = store.get();
    const res = await client.goalSeek(
      {
        kind: s.presetKind,
        variant: s.presetVariant,
        params: s.presetParams,
        seekParam,
        mode,
        target,
      },
      onIter,
    );
    if (res.ok && res.x != null) {
      const patch = seekParam === 'w' ? { w: res.x } : { s: res.x };
      store.update({ presetParams: { ...store.get().presetParams, ...patch } });
      // auto-solve at the converged point so results reflect the new geometry
      void doSolve();
    }
    return res;
  };
}

let lastInputSignature = '';
function renderInputs(force = false) {
  const s = store.get();
  // avoid clobbering focused fields on every keystroke: re-render only on
  // structural changes (mode/kind/variant/item count)
  const sig = JSON.stringify([
    s.mode,
    s.presetKind,
    s.presetVariant,
    s.presetParams.cover !== null,
    s.freeform.items.map((i) => i.kind + (isConductor(i) ? i.isGround : '')),
  ]);
  if (!force && sig === lastInputSignature) return;
  lastInputSignature = sig;
  renderPresetForm(presetPane, { onGoalSeek: goalSeekHook() });
  renderStackupEditor(freeformPane);
}

/* ---------------- cross-section ---------------- */
const csSvg = $('#cross-section') as unknown as SVGSVGElement;
function renderCS() {
  const s = store.get();
  const stackup = currentStackup(s);
  try {
    renderCrossSection(csSvg, stackup, { showDims: s.mode === 'preset' });
    $('#cs-note').textContent = `units: ${stackup.units} · CSEG ${stackup.cseg} / DSEG ${stackup.dseg}`;
  } catch (e) {
    $('#cs-note').textContent = (e as Error).message;
  }
}

/* ---------------- solve ---------------- */
const btnSolve = $('#btn-solve') as HTMLButtonElement;
const btnCancel = $('#btn-cancel') as HTMLButtonElement;
const spinner = $('#solve-spinner');
const solveNote = $('#solve-note');

let solvedStackup: Stackup | null = null;

async function doSolve() {
  const s = store.get();
  const stackup = currentStackup(s);
  const errors = validateStackup(stackup);
  if (errors.length) {
    solveNote.textContent = errors[0];
    return;
  }
  solveNote.textContent = '';
  store.update({ solving: true });
  btnSolve.disabled = true;
  spinner.classList.remove('d-none');
  btnCancel.classList.toggle('d-none', false);
  try {
    const xsctn = generateXsctn(stackup);
    const out = await client.solve(xsctn, stackup.cseg, stackup.dseg);
    solvedStackup = stackup;
    fieldGridStale = true;
    store.update({ lastSolve: out, solving: false });
  } catch (e) {
    store.update({
      lastSolve: {
        ok: false,
        exitCode: -1,
        stdout: '',
        resultText: null,
        fieldText: null,
        elapsedMs: 0,
        result: null,
        error: (e as Error).message,
      },
      solving: false,
    });
  } finally {
    btnSolve.disabled = false;
    spinner.classList.add('d-none');
    btnCancel.classList.add('d-none');
  }
}

btnSolve.addEventListener('click', () => void doSolve());
btnCancel.addEventListener('click', () => {
  client.cancel();
  store.update({ solving: false });
  btnSolve.disabled = false;
  spinner.classList.add('d-none');
  btnCancel.classList.add('d-none');
  solveNote.textContent = 'cancelled';
});

/* ---------------- results + log ---------------- */
function renderOutputs() {
  const s = store.get();
  renderResults($('#tab-results'), s.lastSolve);
  $('#log-stdout').textContent = s.lastSolve?.stdout || '—';
  $('#log-result').textContent = s.lastSolve?.resultText || '—';
  renderLoss();
  updateFieldControls();
}

/* ---------------- loss tab ---------------- */
function drivingConductor(stackup: Stackup): ConductorItem | null {
  return (stackup.items.find(isSignal) as ConductorItem | undefined) ?? null;
}

function renderLoss() {
  const s = store.get();
  const svg = $('#loss-chart') as unknown as SVGSVGElement;
  const note = $('#loss-note');
  const out = s.lastSolve;
  if (!out?.ok || !out.result || !solvedStackup) {
    svg.innerHTML = '';
    note.textContent = 'solve first';
    return;
  }
  const cond = drivingConductor(solvedStackup);
  if (!cond) return;
  // effective tanD: thickness-weighted is overkill; use first dielectric's
  const firstDielectric = solvedStackup.items.find((i) => i.kind === 'DielectricLayer');
  const tanD = firstDielectric && firstDielectric.kind === 'DielectricLayer' ? firstDielectric.lossTangent : 0;
  const diffMode = out.result.nSignals === 2 && out.result.zOdd != null;
  const inputs = lossInputsFrom(out.result, cond, UNIT_SCALE[solvedStackup.units], tanD, diffMode);
  if (!inputs) {
    note.textContent = 'no loss inputs';
    return;
  }
  const curve = lossCurve(inputs, s.lossParams);
  const unit = ($('#loss-unit') as HTMLSelectElement).value as LossUnit;
  renderLossChart(svg, curve, unit);
  note.textContent = diffMode ? 'odd mode (per line of the pair)' : `line 1 (${out.result.names[0] ?? ''})`;
}

$('#loss-model').addEventListener('change', (e) => {
  store.update({
    lossParams: { ...store.get().lossParams, roughnessModel: (e.target as HTMLSelectElement).value as 'none' | 'hammerstad' | 'huray' },
  });
});
$('#loss-rq').addEventListener('change', (e) => {
  store.update({
    lossParams: { ...store.get().lossParams, roughnessRqUm: parseFloat((e.target as HTMLInputElement).value) || 0 },
  });
});
$('#loss-unit').addEventListener('change', renderLoss);

/* ---------------- field tab ---------------- */
const fieldCanvas = $('#field-canvas') as HTMLCanvasElement;
const fieldOverlay = $('#field-overlay') as unknown as SVGSVGElement;
const fieldLineSel = $('#field-line') as HTMLSelectElement;
const fieldNote = $('#field-note');
const fieldResidual = $('#field-residual');
let fieldGridStale = true;

function updateFieldControls() {
  const s = store.get();
  const n = s.lastSolve?.result?.nSignals ?? 0;
  const names = s.lastSolve?.result?.names ?? [];
  fieldLineSel.innerHTML = Array.from({ length: n }, (_, i) => `<option value="${i}">${names[i] ?? `line ${i + 1}`}</option>`).join('');
  fieldNote.textContent = s.lastSolve?.fieldText ? (fieldGridStale ? 'press Compute field' : '') : 'solve first';
}

async function computeField() {
  const s = store.get();
  if (!s.lastSolve?.fieldText || !solvedStackup) return;
  fieldNote.textContent = 'computing…';
  try {
    const geo = computeGeometry(solvedStackup);
    const scale = UNIT_SCALE[solvedStackup.units];
    // bbox in meters with padding
    const padY = geo.yTop * 0.35 + 1e-9;
    const conductors = geo.polys.filter((p) => p.kind === 'conductor');
    const cx0 = Math.min(...conductors.map((p) => p.x0));
    const cx1 = Math.max(...conductors.map((p) => p.x1));
    const focus = Math.max((cx1 - cx0) * 2.2, geo.yTop * 4);
    const bbox = {
      x0: Math.max(geo.domainX0, (cx0 + cx1) / 2 - focus / 2) * scale,
      x1: Math.min(geo.domainX1, (cx0 + cx1) / 2 + focus / 2) * scale,
      y0: -padY * 0.4 * scale,
      y1: (geo.yTop + padY) * scale,
    };
    const masks = conductors.map((p) => ({
      x0: p.x0 * scale,
      y0: p.y0 * scale,
      x1: p.x1 * scale,
      y1: p.y1 * scale,
    }));
    const grid = await client.fieldGrid({
      fieldText: s.lastSolve.fieldText,
      lineIndex: parseInt(fieldLineSel.value || '0', 10),
      bbox,
      nx: 240,
      ny: 160,
      masks,
    });
    drawHeatmap(fieldCanvas, grid);
    drawColorbar($('#field-colorbar') as HTMLCanvasElement);
    fieldGridStale = false;
    fieldNote.textContent = '';
    const pct = (grid.maxResidual * 100).toFixed(1);
    fieldResidual.textContent = Number.isFinite(grid.maxResidual)
      ? `BC residual ${pct}%${grid.maxResidual > 0.05 ? ' ⚠ reconstruction degraded' : ''}`
      : '';
    // overlay the cross-section outline scaled to the bbox
    renderFieldOverlay(bbox, scale);
  } catch (e) {
    fieldNote.textContent = (e as Error).message;
  }
}

function renderFieldOverlay(bbox: { x0: number; y0: number; x1: number; y1: number }, scale: number) {
  if (!solvedStackup) return;
  const geo = computeGeometry(solvedStackup);
  const W = 1000;
  const H = (W * (bbox.y1 - bbox.y0)) / (bbox.x1 - bbox.x0);
  fieldOverlay.setAttribute('viewBox', `0 0 ${W} ${H}`);
  fieldOverlay.setAttribute('preserveAspectRatio', 'none');
  fieldOverlay.innerHTML = '';
  const sx = (x: number) => ((x * scale - bbox.x0) / (bbox.x1 - bbox.x0)) * W;
  const sy = (y: number) => H - ((y * scale - bbox.y0) / (bbox.y1 - bbox.y0)) * H;
  const ns = 'http://www.w3.org/2000/svg';
  for (const p of geo.polys) {
    const el = document.createElementNS(ns, 'polygon');
    el.setAttribute('points', p.pts.map(([x, y]) => `${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join(' '));
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke', p.kind === 'conductor' || p.kind === 'ground' ? '#222' : 'rgba(40,40,40,0.35)');
    el.setAttribute('stroke-width', p.kind === 'conductor' ? '1.5' : '1');
    fieldOverlay.appendChild(el);
  }
}

$('#field-compute').addEventListener('click', () => void computeField());
fieldLineSel.addEventListener('change', () => void computeField());
// lazily compute when the tab is first shown after a solve
document.querySelector('[data-bs-target="#tab-field"]')?.addEventListener('shown.bs.tab', () => {
  if (fieldGridStale && store.get().lastSolve?.fieldText) void computeField();
});

/* ---------------- store subscription ---------------- */
let lastSolveRef: unknown = null;
store.subscribe((s) => {
  renderInputs();
  renderCS();
  if (s.lastSolve !== lastSolveRef) {
    lastSolveRef = s.lastSolve;
    renderOutputs();
  }
});

/* keep Bootstrap Tab import alive (used via data attributes) */
void Tab;

renderInputs(true);
renderCS();
renderOutputs();
