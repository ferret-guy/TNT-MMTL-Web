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
  computeViewport,
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
import {
  lossCurve,
  lossInputsFrom,
  presetLossTangentAtFrequency,
  UNIT_SCALE,
} from './analysis/losses.ts';
import type { FieldGrid } from './field/potential.ts';
import {
  isConductor,
  isSignal,
  type ConductorItem,
  type Stackup,
} from './model/types.ts';
import type { DimUnit } from './ui/dimField.ts';
import type { PresetKind, PresetParams } from './model/presets.ts';

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el as T;
};

const client = new SolverClient();
// Field reconstruction is deliberately isolated from the BEM worker.  Its
// CPU-heavy grid integration can then be terminated without delaying a solve.
const fieldClient = new SolverClient();
const MILS_PER_METER = 1 / UNIT_SCALE.mils;

/* ---------------- solver status probe ---------------- */
(async () => {
  const status = $('#solver-status');
  try {
    const res = await fetch(new URL(`${import.meta.env.BASE_URL}wasm/bem.wasm`, document.baseURI), {
      method: 'HEAD',
    });
    status.textContent = res.ok ? 'solver: ready' : 'solver: bem.wasm missing!';
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
    cancelFieldWork();
    const res = await client.goalSeek(
      {
        kind: s.presetKind,
        variant: s.presetVariant,
        params: s.presetParams,
        designFreqHz: s.designFreqHz,
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
      // goal-seek result message the form is about to display).  Read back
      // canonical state because narrowing the width can also limit etch.
      const canonical = store.get().presetParams;
      const updates: Array<[string, number]> = seekParam === 'w'
        ? [['#pf-w', canonical.w], ['#pf-etch', canonical.etch]]
        : [['#pf-s', canonical.s]];
      const { formatDim } = await import('./ui/dimField.ts');
      for (const [selector, mils] of updates) {
        const field = document.querySelector<HTMLInputElement>(selector);
        if (!field) continue;
        field.dataset.mils = String(mils);
        field.value = formatDim(mils, field.dataset.unit as DimUnit);
      }
      void doSolve();
    } else scheduleIdleFieldWarm();
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
    s.presetParams.striplineSeparateMaterials,
    s.presetParams.laminateId,
    s.presetParams.laminateId2,
    s.designFreqHz,
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
const csDrivenLabel = $('#cs-driven-label');
const csLegend = $('#cs-field-legend');
const fieldResidual = $('#field-residual');

let fieldGridCache: (FieldGrid & { lines: string[] }) | null = null;
let fieldGridStale = true;
let solvedStackup: Stackup | null = null;
let solvedMaterialContext: {
  kind: PresetKind;
  params: PresetParams;
  designFreqHz: number;
} | null = null;
let fieldSolveKey = '';
let fieldGeneration = 0;
let activeFieldRequestKey: string | null = null;
let fieldIdleHandle: number | undefined;

function cancelIdleFieldWarm() {
  if (fieldIdleHandle === undefined) return;
  window.cancelIdleCallback(fieldIdleHandle);
  fieldIdleHandle = undefined;
}

function cancelFieldWork() {
  cancelIdleFieldWarm();
  fieldGeneration++;
  activeFieldRequestKey = null;
  if (fieldClient.busy) fieldClient.cancel();
}

/** Drop field work as soon as its geometry stops matching the form. */
function invalidateFieldGrid() {
  cancelFieldWork();
  fieldGridCache = null;
  fieldGridStale = true;
}

function focusField(fieldId: string) {
  const el = document.querySelector<HTMLInputElement>(`#${fieldId}`);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.focus();
  el.select();
}

/** hovering a dimension callout glows the mapped input so the pairing is obvious */
function hoverField(fieldId: string, hovering: boolean) {
  const el = document.querySelector<HTMLInputElement>(`#${fieldId}`);
  // glow the whole input-group (field + unit button) when present
  const target = el?.closest('.input-group') ?? el;
  target?.classList.toggle('dim-glow', hovering);
}

function renderCS() {
  const s = store.get();
  const stackup = viewMode === 'geom' ? currentStackup(s) : (solvedStackup ?? currentStackup(s));
  let vp: Viewport;
  try {
    const cover = s.mode === 'preset' ? s.presetParams.cover : null;
    vp = renderCrossSection(csSvg, stackup, {
      showDims: viewMode === 'geom' && s.mode === 'preset',
      outline: viewMode !== 'geom',
      onDimClick: focusField,
      onDimHover: hoverField,
      displayUnit: s.displayUnit as DimUnit,
      coverProfile:
        viewMode === 'geom' && cover
          ? { tCopper: cover.tCopper, tBase: cover.tBase, tBetween: cover.tBetween }
          : undefined,
      presetKind: s.mode === 'preset' ? s.presetKind : undefined,
    });
  } catch (e) {
    $('#cs-note').textContent = (e as Error).message;
    return;
  }
  $('#cs-note').textContent = '';

  const showField = viewMode !== 'geom' && fieldGridCache && !fieldGridStale;
  const lineCount = fieldGridCache?.lines.length ?? 0;
  const selectedLine = Math.max(0, parseInt(csDriven.value || '0', 10));
  const showDrivenSelect = viewMode !== 'geom' && lineCount > 1;
  const showDrivenLabel = viewMode !== 'geom' && lineCount === 1;
  csCanvas.classList.toggle('d-none', !(viewMode === 'field' && showField));
  csLegend.classList.toggle('d-none', viewMode === 'geom');
  csLegend.classList.toggle('d-flex', viewMode !== 'geom');
  csDriven.classList.toggle('d-none', !showDrivenSelect);
  csDrivenLabel.classList.toggle('d-none', !showDrivenLabel);
  if (showDrivenLabel && fieldGridCache) {
    const rawName = fieldGridCache.lines[selectedLine] ?? fieldGridCache.lines[0];
    const displayName = store.get().mode === 'freeform' ? rawName : `Line ${selectedLine + 1}`;
    csDrivenLabel.textContent = `drive: ${displayName}`;
  }

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

async function computeFieldGrid(background = false) {
  const s = store.get();
  if (!s.lastSolve?.fieldText || !solvedStackup) {
    if (!background) fieldResidual.textContent = 'solve first';
    return;
  }
  if (s.solving || client.busy || currentSolveKey() !== fieldSolveKey) {
    if (!background) fieldResidual.textContent = 'waiting for solve…';
    return;
  }

  const fieldText = s.lastSolve.fieldText;
  const stackup = solvedStackup;
  const solveKey = fieldSolveKey;
  const lineIndex = parseInt(csDriven.value || '0', 10);
  const requestKey = `${solveKey}|${lineIndex}`;
  // A view opened while idle warming is in flight reuses that exact job.
  if (fieldClient.busy && activeFieldRequestKey === requestKey) {
    if (!background) fieldResidual.textContent = 'computing field…';
    return;
  }
  if (fieldClient.busy) fieldClient.cancel();
  cancelIdleFieldWarm();
  const generation = ++fieldGeneration;
  activeFieldRequestKey = requestKey;
  if (!background) fieldResidual.textContent = 'computing field…';

  try {
    const geo = computeGeometry(stackup);
    // Match the visible SVG without mutating it during idle precomputation.
    const vp = computeViewport(geo);
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
    if (!background) {
      progress.classList.remove('d-none');
      progressBar.style.width = '0%';
    }
    let grid: FieldGrid & { lines: string[] };
    try {
      grid = await fieldClient.fieldGrid(
        { fieldText, lineIndex, bbox, nx, ny, masks, maskPolys },
        (frac) => {
          if (!background && generation === fieldGeneration) {
            progressBar.style.width = `${Math.round(frac * 100)}%`;
          }
        },
      );
    } finally {
      if (!background && generation === fieldGeneration) progress.classList.add('d-none');
    }

    // Termination and a final worker postMessage can race. Check every input
    // again before accepting the transferred grid into the cache.
    if (
      generation !== fieldGeneration ||
      solveKey !== fieldSolveKey ||
      currentSolveKey() !== solveKey ||
      store.get().lastSolve?.fieldText !== fieldText ||
      parseInt(csDriven.value || '0', 10) !== lineIndex
    ) {
      return;
    }
    fieldGridCache = grid;
    fieldGridStale = false;
    const selectedLine = Math.max(0, Math.min(lineIndex, grid.lines.length - 1));
    const freeformLabels = store.get().mode === 'freeform';
    csDriven.innerHTML = grid.lines
      .map((n, i) => {
        const label = freeformLabels ? n : `Line ${i + 1}`;
        return `<option value="${i}" ${i === selectedLine ? 'selected' : ''}>drive: ${label}</option>`;
      })
      .join('');
    if (viewMode !== 'geom') renderCS();
  } catch (e) {
    if (!background && generation === fieldGeneration) fieldResidual.textContent = (e as Error).message;
  } finally {
    if (generation === fieldGeneration) activeFieldRequestKey = null;
  }
}

/** Warm the grid only when the browser reports spare main-thread time.
 * Browsers without requestIdleCallback retain the on-demand path. */
function scheduleIdleFieldWarm() {
  cancelIdleFieldWarm();
  if (!('requestIdleCallback' in window) || !fieldGridStale || !fieldSolveKey) return;
  const generation = fieldGeneration;
  const solveKey = fieldSolveKey;
  fieldIdleHandle = window.requestIdleCallback((deadline) => {
    fieldIdleHandle = undefined;
    if (generation !== fieldGeneration || solveKey !== fieldSolveKey || currentSolveKey() !== solveKey) return;
    if (store.get().solving || client.busy || deadline.timeRemaining() < 8) {
      scheduleIdleFieldWarm();
      return;
    }
    void computeFieldGrid(true);
  });
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
  invalidateFieldGrid();
  void computeFieldGrid();
});

/* ---------------- solve ---------------- */
const btnSolve = $('#btn-solve') as HTMLButtonElement;
const btnCancel = $('#btn-cancel') as HTMLButtonElement;
const spinner = $('#solve-spinner');
const solveNote = $('#solve-note');
let solveGeneration = 0;

async function doSolve() {
  const generation = ++solveGeneration;
  const s = store.get();
  const stackup = currentStackup(s);
  const materialContext = s.mode === 'preset'
    ? { kind: s.presetKind, params: { ...s.presetParams }, designFreqHz: s.designFreqHz }
    : null;
  const errors = validateStackup(stackup);
  if (errors.length) {
    solveNote.textContent = errors[0];
    return;
  }
  solveNote.textContent = '';
  // Invalidate any field reconstruction from the previous geometry before
  // starting the primary BEM solve.
  invalidateFieldGrid();
  store.update({ solving: true });
  btnSolve.disabled = true;
  spinner.classList.remove('d-none');
  btnCancel.classList.toggle('d-none', false);
  try {
    const xsctn = generateXsctn(stackup);
    const solveKey = `${xsctn}|${stackup.cseg}|${stackup.dseg}`;
    // mark this input as handled even if it fails: auto-solve must not
    // retry an unchanged config in a loop
    lastSolveKey = solveKey;
    const out = await client.solve(xsctn, stackup.cseg, stackup.dseg);
    if (generation !== solveGeneration) return;
    solvedStackup = stackup;
    solvedMaterialContext = materialContext;
    fieldSolveKey = '';
    fieldSolveKey = solveKey;
    (window as unknown as Record<string, unknown>).__tntweb = { out, stackup, xsctn };
    store.update({ lastSolve: out, solving: false });
    if (out.ok && out.fieldText && currentSolveKey() === solveKey) {
      if (viewMode !== 'geom') void computeFieldGrid();
      else scheduleIdleFieldWarm();
    }
  } catch (e) {
    if (generation !== solveGeneration) return;
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
    if (generation !== solveGeneration) return;
    btnSolve.disabled = false;
    spinner.classList.add('d-none');
    btnCancel.classList.add('d-none');
    if (autoSolveQueued) {
      // edits arrived while this solve ran: pick up the latest state once
      autoSolveQueued = false;
      scheduleAutoSolve();
    }
  }
}

/* auto-solve: first solve on load, then after every edit. Anti-thrash:
 * a debounce coalesces bursts of edits, a signature check skips state
 * changes that don't alter the solver input (units, plot settings, results),
 * and while a solve is in flight new edits queue exactly one re-run. */
const AUTO_SOLVE_DEBOUNCE_MS = 600;
let autoSolveTimer: number | undefined;
let autoSolveQueued = false;
let lastSolveKey = '';

function currentSolveKey(): string {
  const s = store.get();
  try {
    const stackup = currentStackup(s);
    return `${generateXsctn(stackup)}|${stackup.cseg}|${stackup.dseg}`;
  } catch {
    return lastSolveKey; // un-generatable state: leave auto-solve idle
  }
}

function scheduleAutoSolve() {
  window.clearTimeout(autoSolveTimer);
  autoSolveTimer = window.setTimeout(() => {
    if (currentSolveKey() === lastSolveKey) return;
    if (store.get().solving) {
      autoSolveQueued = true;
      return;
    }
    void doSolve();
  }, AUTO_SOLVE_DEBOUNCE_MS);
}

btnSolve.addEventListener('click', () => void doSolve());
btnCancel.addEventListener('click', () => {
  solveGeneration++;
  client.cancel();
  invalidateFieldGrid();
  // suppress the auto re-run of the config the user just cancelled
  lastSolveKey = currentSolveKey();
  autoSolveQueued = false;
  store.update({ solving: false });
  btnSolve.disabled = false;
  spinner.classList.add('d-none');
  btnCancel.classList.add('d-none');
  solveNote.textContent = 'cancelled';
});

/* ---------------- results + log ---------------- */
function renderOutputs() {
  const s = store.get();
  renderResults($('#results-summary'), $('#result-matrices'), s.lastSolve, s.mode === 'freeform');
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
  const substrateId = solvedMaterialContext?.kind === 'stripline' ? 'sub1' : 'sub';
  const substrate = solvedMaterialContext
    ? solvedStackup.items.find(
      (item) => item.kind === 'DielectricLayer' && item.id === substrateId,
    )
    : solvedStackup.items.find((item) => item.kind === 'DielectricLayer');
  let tanD = substrate?.kind === 'DielectricLayer' ? substrate.lossTangent : 0;
  let tanDAtHz: ((fHz: number) => number) | undefined;
  if (solvedMaterialContext) {
    const { kind, params: p, designFreqHz } = solvedMaterialContext;
    if (kind === 'stripline' && p.striplineSeparateMaterials) {
      tanDAtHz = (fHz) => presetLossTangentAtFrequency(kind, p, fHz);
      tanD = tanDAtHz(designFreqHz);
    } else if (p.laminateId) {
      tanDAtHz = (fHz) => presetLossTangentAtFrequency(kind, p, fHz);
      tanD = tanDAtHz(designFreqHz);
    }
  }
  const diffMode = out.result.nSignals === 2 && out.result.zOdd != null;
  const inputs = lossInputsFrom(out.result, cond, UNIT_SCALE[solvedStackup.units], tanD, diffMode);
  if (!inputs) {
    note.textContent = 'no loss inputs';
    return;
  }
  if (tanDAtHz) inputs.tanDAtHz = tanDAtHz;
  const curve = lossCurve(inputs, s.lossParams);
  const modeLabel =
    diffMode ? 'odd mode, per line' : (s.mode === 'freeform' ? (out.result.names[0] ?? 'line 1') : 'single-ended');
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
  const v = parseFloat(($('#loss-length') as HTMLInputElement).value);
  if (!Number.isFinite(v) || v <= 0) return;
  const scale = parseFloat(($('#loss-length-unit') as HTMLSelectElement).value);
  store.update({ lineLengthM: Math.max(v * scale, 1e-6) });
  renderLoss();
};
$('#loss-length').addEventListener('change', updLength);
$('#loss-length').addEventListener('input', updLength);
$('#loss-length-unit').addEventListener('change', updLength);
const updRiseTime = () => {
  const v = parseFloat(($('#loss-rise') as HTMLInputElement).value);
  if (!Number.isFinite(v) || v <= 0) return;
  store.update({ riseTimePs: v });
};
$('#loss-rise').addEventListener('change', updRiseTime);
$('#loss-rise').addEventListener('input', updRiseTime);
const updFreq = () => {
  const v = parseFloat(($('#loss-freq') as HTMLInputElement).value) || 0;
  const scale = parseFloat(($('#loss-freq-unit') as HTMLSelectElement).value);
  store.update({ designFreqHz: Math.max(v * scale, 1e3) });
  renderOutputs();
};
$('#loss-freq').addEventListener('change', updFreq);
$('#loss-freq-unit').addEventListener('change', updFreq);

// initialize the length/frequency inputs from persisted state
(() => {
  const s = store.get();
  const L = s.lineLengthM;
  const [lv, lu] = L >= 1 ? [L, '1'] : L >= 0.1 ? [L * 100, '0.01'] : [L * 1000, '0.001'];
  ($('#loss-length') as HTMLInputElement).value = String(+lv.toPrecision(4));
  ($('#loss-length-unit') as HTMLSelectElement).value = lu;
  ($('#loss-rise') as HTMLInputElement).value = String(+s.riseTimePs.toPrecision(4));
  const f = s.designFreqHz;
  const [fv, fu] = f >= 1e9 ? [f / 1e9, '1e9'] : [f / 1e6, '1e6'];
  ($('#loss-freq') as HTMLInputElement).value = String(+fv.toPrecision(4));
  ($('#loss-freq-unit') as HTMLSelectElement).value = fu;
})();

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
    btnShare.textContent = 'Share this configuration';
    btnShare.classList.remove('btn-success', 'btn-warning');
    btnShare.classList.add('btn-outline-primary');
  }, 1600);
});

/* ---------------- store subscription ---------------- */
let lastSolveRef: unknown = null;
store.subscribe((s) => {
  if (fieldSolveKey && currentSolveKey() !== fieldSolveKey && (!fieldGridStale || fieldClient.busy || fieldIdleHandle !== undefined)) {
    invalidateFieldGrid();
  }
  renderInputs();
  if (viewMode === 'geom') renderCS();
  syncUrlHash();
  scheduleAutoSolve();
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
void doSolve(); // solve the restored/shared config as soon as the page loads
