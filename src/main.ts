/**
 * App bootstrap: wiring between store, solver client, and UI panels.
 */
import 'bootstrap/dist/css/bootstrap.min.css';
import '@fontsource/atkinson-hyperlegible/400.css';
import '@fontsource/atkinson-hyperlegible/700.css';
import './style.css';
import { Tab } from 'bootstrap';

import { store, currentStackup, encodeConfig } from './model/store.ts';
import { generateXsctn, validateStackup } from './xsctn/generate.ts';
import { SolverClient } from './solver/client.ts';
import { renderPresetForm } from './ui/presetForm.ts';
import { renderStackupEditor } from './ui/stackupEditor.ts';
import { renderResults } from './ui/resultsPanel.ts';
import {
  computeGeometry,
  renderCrossSection,
  VIEWPORT_PAD,
  type Viewport,
} from './ui/crossSection.ts';
import {
  contourPaths,
  drawColorbar,
  drawFieldHeatmap,
  renderContoursInto,
  renderStreamlinesInto,
  streamlinePaths,
} from './ui/fieldView.ts';
import { renderLossPlot } from './ui/lossPlot.ts';
import { computeLineStats } from './analysis/lineStats.ts';
import { lossCurve, lossInputsFrom, UNIT_SCALE } from './analysis/losses.ts';
import type { FieldGrid } from './field/potential.ts';
import { isConductor, isSignal, type ConductorItem, type Stackup } from './model/types.ts';
import type { DimUnit } from './ui/dimField.ts';

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el as T;
};

const client = new SolverClient();
const MILS_PER_METER = 1 / UNIT_SCALE.mils;

/* ---------------- solver status probe ---------------- */
(async () => {
  const status = $('#solver-status');
  try {
    const res = await fetch(new URL(`${import.meta.env.BASE_URL}wasm/bem.wasm`, document.baseURI), {
      method: 'HEAD',
    });
    status.textContent = res.ok ? 'solver: ready (wasm loaded on demand)' : 'solver: bem.wasm missing!';
  } catch {
    status.textContent = 'solver: bem.wasm missing!';
  }
})();

/* ---------------- goal seek plumbing ---------------- */
const gsLog = $('#log-goalseek');

function goalSeekHook() {
  return async (mode: 'z0' | 'zdiff' | 'zodd' | 'zeven', seekParam: 'w' | 's', target: number) => {
    const s = store.get();
    gsLog.textContent = `goal seek: ${mode} -> ${target} Ω, tuning ${seekParam === 'w' ? 'width' : 'gap'}\n`;
    const res = await client.goalSeek(
      {
        kind: s.presetKind,
        variant: s.presetVariant,
        params: s.presetParams,
        seekParam,
        mode,
        target,
      },
      (it) => {
        gsLog.textContent += `[${it.phase}] #${it.i}  ${seekParam} = ${it.x.toPrecision(6)}  →  ${
          it.z == null ? 'failed' : it.z.toFixed(3) + ' Ω'
        }\n`;
        gsLog.scrollTop = gsLog.scrollHeight;
      },
    );
    if (res.log) gsLog.textContent += res.message + '\n';
    if (res.ok && res.x != null) {
      const patch = seekParam === 'w' ? { w: res.x } : { s: res.x };
      store.update({ presetParams: { ...store.get().presetParams, ...patch } });
      // update the field in place (a full re-render would orphan the
      // goal-seek result message the form is about to display)
      const field = document.querySelector<HTMLInputElement>(seekParam === 'w' ? '#pf-w' : '#pf-s');
      if (field) {
        field.dataset.mils = String(res.x);
        const { formatDim } = await import('./ui/dimField.ts');
        field.value = formatDim(res.x, field.dataset.unit as DimUnit);
      }
      void doSolve();
    }
    return res;
  };
}

/* ---------------- input panels ---------------- */
const presetPane = $('#tab-preset');
const freeformPane = $('#tab-freeform');

let lastInputSignature = '';
function renderInputs(force = false) {
  const s = store.get();
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

// input mode follows the visible tab
document.querySelector('[data-bs-target="#tab-preset"]')?.addEventListener('shown.bs.tab', () =>
  store.update({ mode: 'preset' }),
);
document.querySelector('[data-bs-target="#tab-freeform"]')?.addEventListener('shown.bs.tab', () =>
  store.update({ mode: 'freeform' }),
);

/* ---------------- cross-section view (geometry / field / lines) ---------------- */
type ViewMode = 'geom' | 'field' | 'lines';
let viewMode: ViewMode = 'geom';
const csSvg = $('#cross-section') as unknown as SVGSVGElement;
const csCanvas = $('#cs-field-canvas') as HTMLCanvasElement;
const csDriven = $('#cs-driven') as HTMLSelectElement;
const csLegend = $('#cs-field-legend');
const fieldResidual = $('#field-residual');

let fieldGridCache: (FieldGrid & { lines: string[] }) | null = null;
let fieldGridStale = true;
let solvedStackup: Stackup | null = null;

function focusField(fieldId: string) {
  const el = document.querySelector<HTMLInputElement>(`#${fieldId}`);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.focus();
  el.select();
}

function renderCS() {
  const s = store.get();
  const stackup = viewMode === 'geom' ? currentStackup(s) : (solvedStackup ?? currentStackup(s));
  let vp: Viewport;
  try {
    vp = renderCrossSection(csSvg, stackup, {
      showDims: viewMode === 'geom' && s.mode === 'preset',
      outline: viewMode !== 'geom',
      onDimClick: focusField,
      displayUnit: s.displayUnit as DimUnit,
    });
  } catch (e) {
    $('#cs-note').textContent = (e as Error).message;
    return;
  }
  $('#cs-note').textContent = `CSEG ${stackup.cseg} / DSEG ${stackup.dseg}`;

  const showField = viewMode !== 'geom' && fieldGridCache && !fieldGridStale;
  csCanvas.classList.toggle('d-none', !(viewMode === 'field' && showField));
  csLegend.classList.toggle('d-none', viewMode === 'geom');
  csLegend.classList.toggle('d-flex', viewMode !== 'geom');
  csDriven.classList.toggle('d-none', viewMode === 'geom');

  if (showField && fieldGridCache) {
    // canvas aligns with the svg's padded plot area
    const padPct = VIEWPORT_PAD * 100;
    csCanvas.style.left = `${padPct}%`;
    csCanvas.style.top = `${padPct}%`;
    csCanvas.style.width = `${100 - 2 * padPct}%`;
    csCanvas.style.height = `${100 - 2 * padPct}%`;
    if (viewMode === 'field') {
      drawFieldHeatmap(csCanvas, fieldGridCache);
      renderContoursInto(csSvg, contourPaths(fieldGridCache, vp, MILS_PER_METER, 12), false);
    } else {
      // E-field lines: perpendicular to the equipotentials, running from the
      // driven trace to ground / the other conductor
      renderStreamlinesInto(csSvg, streamlinePaths(fieldGridCache, vp, MILS_PER_METER, 34));
    }
    drawColorbar($('#field-colorbar') as HTMLCanvasElement);
    const pct = (fieldGridCache.maxResidual * 100).toFixed(1);
    fieldResidual.textContent = Number.isFinite(fieldGridCache.maxResidual)
      ? `reconstruction check: ${pct}% ${fieldGridCache.maxResidual > 0.05 ? '⚠' : '✓'}`
      : '';
  }
}

async function computeFieldGrid() {
  const s = store.get();
  if (!s.lastSolve?.fieldText || !solvedStackup) {
    fieldResidual.textContent = 'solve first';
    return;
  }
  fieldResidual.textContent = 'computing field…';
  try {
    const geo = computeGeometry(solvedStackup);
    const vp = (() => {
      // same viewport the svg uses
      return renderCrossSection(csSvg, solvedStackup, { outline: true });
    })();
    const scale = UNIT_SCALE.mils; // stackup units are canonical mils
    const bbox = {
      x0: vp.vx0 * scale,
      x1: vp.vx1 * scale,
      y0: vp.vy0 * scale,
      y1: vp.vy1 * scale,
    };
    const nx = 420;
    const ny = Math.max(140, Math.min(320, Math.round((nx * (bbox.y1 - bbox.y0)) / (bbox.x1 - bbox.x0))));
    const masks = [
      // nothing below the (imaged) bottom ground plane
      { x0: bbox.x0 - 1, y0: bbox.y0 - 1, x1: bbox.x1 + 1, y1: 0 },
      ...geo.polys
        .filter((p) => p.kind === 'ground')
        .map((p) => ({
          x0: p.x0 * scale,
          y0: p.y0 * scale,
          x1: p.x1 * scale,
          y1: p.y1 * scale,
        })),
    ];
    // conductors mask by their true polygon so trapezoid/etched edges show
    const maskPolys = geo.polys
      .filter((p) => p.kind === 'conductor')
      .map((p) => p.pts.map(([x, y]): [number, number] => [x * scale, y * scale]));
    const progress = $('#cs-progress');
    const progressBar = $('#cs-progress-bar');
    progress.classList.remove('d-none');
    progressBar.style.width = '0%';
    try {
      fieldGridCache = await client.fieldGrid(
        {
          fieldText: s.lastSolve.fieldText,
          lineIndex: parseInt(csDriven.value || '0', 10),
          bbox,
          nx,
          ny,
          masks,
          maskPolys,
        },
        (frac) => {
          progressBar.style.width = `${Math.round(frac * 100)}%`;
        },
      );
    } finally {
      progress.classList.add('d-none');
    }
    fieldGridStale = false;
    // populate driven-line selector
    csDriven.innerHTML = fieldGridCache.lines
      .map((n, i) => `<option value="${i}" ${String(i) === (csDriven.value || '0') ? 'selected' : ''}>drive: ${n}</option>`)
      .join('');
    renderCS();
  } catch (e) {
    fieldResidual.textContent = (e as Error).message;
  }
}

for (const [id, mode] of [
  ['#cs-view-geom', 'geom'],
  ['#cs-view-field', 'field'],
  ['#cs-view-lines', 'lines'],
] as Array<[string, ViewMode]>) {
  $(id).addEventListener('change', () => {
    viewMode = mode;
    if (mode !== 'geom' && (fieldGridStale || !fieldGridCache)) void computeFieldGrid();
    else renderCS();
  });
}
csDriven.addEventListener('change', () => {
  fieldGridStale = true;
  void computeFieldGrid();
});

/* ---------------- solve ---------------- */
const btnSolve = $('#btn-solve') as HTMLButtonElement;
const btnCancel = $('#btn-cancel') as HTMLButtonElement;
const spinner = $('#solve-spinner');
const solveNote = $('#solve-note');

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
    (window as unknown as Record<string, unknown>).__tntweb = { out, stackup, xsctn };
    store.update({ lastSolve: out, solving: false });
    if (viewMode !== 'geom') void computeFieldGrid();
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
}

/* ---------------- loss & line stats ---------------- */
function drivingConductor(stackup: Stackup): ConductorItem | null {
  return (stackup.items.find(isSignal) as ConductorItem | undefined) ?? null;
}

function statCard(label: string, value: string, sub = ''): string {
  return `<div class="col"><div class="card h-100"><div class="card-body py-2 px-3">
    <div class="small text-body-secondary">${label}</div>
    <div class="fs-6 font-monospace">${value}</div>
    ${sub ? `<div class="tiny text-body-secondary">${sub}</div>` : ''}
  </div></div></div>`;
}

function renderLoss() {
  const s = store.get();
  const plotEl = $('#loss-plot');
  const statsEl = $('#line-stats');
  const note = $('#loss-note');
  const out = s.lastSolve;
  if (!out?.ok || !out.result || !solvedStackup) {
    statsEl.innerHTML = '';
    note.textContent = 'solve first';
    return;
  }
  const cond = drivingConductor(solvedStackup);
  if (!cond) return;
  const firstDielectric = solvedStackup.items.find((i) => i.kind === 'DielectricLayer');
  const tanD = firstDielectric && firstDielectric.kind === 'DielectricLayer' ? firstDielectric.lossTangent : 0;
  const diffMode = out.result.nSignals === 2 && out.result.zOdd != null;
  const inputs = lossInputsFrom(out.result, cond, UNIT_SCALE.mils, tanD, diffMode);
  if (!inputs) {
    note.textContent = 'no loss inputs';
    return;
  }
  const curve = lossCurve(inputs, s.lossParams);
  const modeLabel = diffMode ? 'odd mode, per line' : (out.result.names[0] ?? 'line 1');
  renderLossPlot(plotEl, curve, s.lineLengthM, s.designFreqHz, modeLabel);

  const stats = computeLineStats(out.result, curve, s.lineLengthM, s.designFreqHz, diffMode);
  if (stats) {
    const fLabel = s.designFreqHz >= 1e9 ? `${+(s.designFreqHz / 1e9).toPrecision(3)} GHz` : `${+(s.designFreqHz / 1e6).toPrecision(3)} MHz`;
    statsEl.innerHTML = [
      statCard('Insertion loss @ ' + fLabel, `${stats.lossDb.toFixed(2)} dB`, `cond ${stats.lossCondDb.toFixed(2)} / diel ${stats.lossDielDb.toFixed(2)} dB`),
      statCard('DC resistance', Number.isFinite(stats.rdcOhm) ? `${stats.rdcOhm.toFixed(3)} Ω` : '—', 'per conductor, round trip ×2'),
      statCard('Delay', `${stats.delayPs.toFixed(1)} ps`, `${(stats.wavelengths).toFixed(2)} λ @ ${fLabel}`),
      statCard('Phase @ ' + fLabel, `${stats.phaseDeg.toFixed(1)}°`, `${(stats.phaseDeg / 360).toFixed(2)} turns`),
    ].join('');
  }
  note.textContent = '';
}

$('#loss-model').addEventListener('change', (e) => {
  store.update({
    lossParams: { ...store.get().lossParams, roughnessModel: (e.target as HTMLSelectElement).value as 'none' | 'hammerstad' | 'huray' },
  });
  renderLoss();
});
$('#loss-rq').addEventListener('change', (e) => {
  store.update({
    lossParams: { ...store.get().lossParams, roughnessRqUm: parseFloat((e.target as HTMLInputElement).value) || 0 },
  });
  renderLoss();
});
const updLength = () => {
  const v = parseFloat(($('#loss-length') as HTMLInputElement).value) || 0;
  const scale = parseFloat(($('#loss-length-unit') as HTMLSelectElement).value);
  store.update({ lineLengthM: Math.max(v * scale, 1e-6) });
  renderLoss();
};
$('#loss-length').addEventListener('change', updLength);
$('#loss-length-unit').addEventListener('change', updLength);
const updFreq = () => {
  const v = parseFloat(($('#loss-freq') as HTMLInputElement).value) || 0;
  const scale = parseFloat(($('#loss-freq-unit') as HTMLSelectElement).value);
  store.update({ designFreqHz: Math.max(v * scale, 1e3) });
  renderLoss();
};
$('#loss-freq').addEventListener('change', updFreq);
$('#loss-freq-unit').addEventListener('change', updFreq);

// initialize the length/frequency inputs from persisted state
(() => {
  const s = store.get();
  const L = s.lineLengthM;
  const [lv, lu] = L >= 1 ? [L, '1'] : L >= 0.01 ? [L * 100, '0.01'] : [L * 1000, '0.001'];
  ($('#loss-length') as HTMLInputElement).value = String(+lv.toPrecision(4));
  ($('#loss-length-unit') as HTMLSelectElement).value = lu;
  const f = s.designFreqHz;
  const [fv, fu] = f >= 1e9 ? [f / 1e9, '1e9'] : [f / 1e6, '1e6'];
  ($('#loss-freq') as HTMLInputElement).value = String(+fv.toPrecision(4));
  ($('#loss-freq-unit') as HTMLSelectElement).value = fu;
})();

// plot needs a resize when its tab becomes visible
document.querySelector('[data-bs-target="#tab-loss"]')?.addEventListener('shown.bs.tab', renderLoss);

/* ---------------- URL config + share ---------------- */
// keep the URL hash in sync with the configuration (debounced replaceState:
// bookmark/copy the address bar at any time and get this exact setup back)
let hashTimer: number | undefined;
function syncUrlHash() {
  window.clearTimeout(hashTimer);
  hashTimer = window.setTimeout(() => {
    history.replaceState(null, '', `#${encodeConfig(store.get())}`);
  }, 300);
}

const btnShare = $('#btn-share') as HTMLButtonElement;
btnShare.addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}#${encodeConfig(store.get())}`;
  history.replaceState(null, '', url);
  let copied = false;
  try {
    await navigator.clipboard.writeText(url);
    copied = true;
  } catch {
    // no async-clipboard permission: synchronous textarea fallback
    const ta = document.createElement('textarea');
    ta.value = url;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    copied = document.execCommand('copy');
    ta.remove();
  }
  btnShare.textContent = copied ? 'Link copied ✓' : 'Copy failed — use the address bar';
  btnShare.classList.replace('btn-outline-primary', copied ? 'btn-success' : 'btn-warning');
  setTimeout(() => {
    btnShare.textContent = 'Share';
    btnShare.classList.remove('btn-success', 'btn-warning');
    btnShare.classList.add('btn-outline-primary');
  }, 1600);
});

/* ---------------- store subscription ---------------- */
let lastSolveRef: unknown = null;
store.subscribe((s) => {
  renderInputs();
  if (viewMode === 'geom') renderCS();
  syncUrlHash();
  if (s.lastSolve !== lastSolveRef) {
    lastSolveRef = s.lastSolve;
    renderOutputs();
  }
});

// restore the saved input tab (listeners above keep mode in sync afterwards)
if (store.get().mode === 'freeform') {
  const btn = document.querySelector('[data-bs-target="#tab-freeform"]');
  if (btn) new Tab(btn).show();
}

renderInputs(true);
renderCS();
renderOutputs();
