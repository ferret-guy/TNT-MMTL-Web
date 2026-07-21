/**
 * App bootstrap: wiring between store, solver client, and UI panels.
 */
import 'bootstrap/dist/css/bootstrap.min.css';
import '@fontsource/atkinson-hyperlegible/400.css';
import '@fontsource/atkinson-hyperlegible/700.css';
import './style.css';
import { Tab } from 'bootstrap';

import { store, currentStackup, encodeConfig } from './model/store.ts';
import { generateXsctn, solverSignalBindings, validateStackup } from './xsctn/generate.ts';
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
import {
  crossSectionProgressPresentation,
  type CrossSectionProgressKind,
} from './ui/crossSectionProgress.ts';
import { computeLineStats } from './analysis/lineStats.ts';
import {
  ladderDelayPerM,
  ladderSectionRequirementText,
  recommendedLadderSections,
} from './analysis/ladderSections.ts';
import {
  lossCurve,
  lossInputsFrom,
  lossSweepParamsForDesign,
  presetReferencePlaneLossModel,
  presetLossTangentAtFrequency,
  UNIT_SCALE,
  type ReferencePlaneLossModel,
} from './analysis/losses.ts';
import {
  CPW_RETURN_CURRENT_MESH_MULTIPLIER,
  freeSpaceStackup,
  meshExplicitReferenceAnalysis,
  meshGroundCurrentDistribution,
  meshReferenceAnalysis,
  refineConductorMesh,
  type MeshGroundCurrentBasis,
} from './analysis/meshReferenceLoss.ts';
import {
  exposeExplicitReferenceSolveOutput,
  isExplicitReferenceStackup,
  prepareExplicitReferenceStackup,
  reduceExplicitReferenceResults,
} from './analysis/explicitReference.ts';
import { transformExplicitReferenceFieldText } from './analysis/explicitReferenceField.ts';
import {
  groundCurrentUsesSolvedMesh,
  presetGroundCurrentDistribution,
} from './analysis/groundCurrent.ts';
import {
  dielectricLossModelFromPerturbation,
  dielectricParticipationPerturbation,
  hasLossyDielectric,
  type DielectricLossModel,
} from './analysis/dielectricLoss.ts';
import {
  exportGenericSpiceSubcircuit,
  exportHspiceWElement,
  exportTouchstoneDifferentialS2p,
  exportTouchstoneNPort,
  exportTouchstoneS2p,
  exportTouchstoneS4p,
  supportsDifferentialTouchstone,
  type ExportedModelFile,
  type ModelExportInput,
} from './export/modelExport.ts';
import type { FieldGrid } from './field/potential.ts';
import {
  isConductor,
  isSignal,
  signalCount,
  type ConductorItem,
  type SolveOutput,
  type SolveResult,
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
// The refined CPW surface-current solve is intentionally lazy and isolated.
// A literal 10x contour mesh is expensive, so ordinary impedance and loss
// results must not wait for it unless the user opens the current-density view.
const currentMeshClient = new SolverClient();
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
    s.presetParams.referencePlaneSameWeight,
    s.presetParams.striplineSeparateMaterials,
    s.presetParams.laminateId,
    s.presetParams.laminateId2,
    s.designFreqHz,
    s.freeform.items.map((i) => i.kind + (isConductor(i) ? i.isGround : '')),
  ]);
  if (!force && sig === lastInputSignature) return;
  lastInputSignature = sig;
  renderPresetForm(presetPane, {
    onGoalSeek: goalSeekHook(),
    onReferenceLossChange: renderLoss,
  });
  renderStackupEditor(freeformPane);
}

// input mode follows the visible tab
document.querySelector('[data-bs-target="#tab-preset"]')?.addEventListener('shown.bs.tab', () =>
  store.update({ mode: 'preset' }),
);
document.querySelector('[data-bs-target="#tab-freeform"]')?.addEventListener('shown.bs.tab', () =>
  store.update({ mode: 'freeform' }),
);

/* ---------------- cross-section view (geometry / field / lines / current) ---------------- */
type ViewMode = 'geom' | 'field' | 'lines' | 'current';
let viewMode: ViewMode = 'geom';
const csStack = $('#cs-stack');
const csSvg = $('#cross-section') as unknown as SVGSVGElement;
const csCanvas = $('#cs-field-canvas') as HTMLCanvasElement;
const csDriven = $('#cs-driven') as HTMLSelectElement;
const csDrivenLabel = $('#cs-driven-label');
const csLegend = $('#cs-field-legend');
const fieldResidual = $('#field-residual');
const csProgress = $('#cs-progress');
const csProgressTrack = $('#cs-progress-track');
const csProgressBar = $('#cs-progress-bar');
const csProgressSpinner = $('#cs-progress-spinner');
const csProgressLabel = $('#cs-progress-label');

function showCrossSectionProgress(
  kind: CrossSectionProgressKind,
  fraction?: number,
): void {
  const presentation = crossSectionProgressPresentation(kind, fraction);
  csProgress.classList.remove('d-none');
  csProgressLabel.textContent = presentation.label;
  const spinnerOnly = presentation.indicator === 'spinner';
  csProgressTrack.classList.toggle('d-none', spinnerOnly);
  csProgressSpinner.classList.toggle('d-none', !spinnerOnly);
  csProgressBar.style.width = `${presentation.widthPercent}%`;
  csStack.setAttribute('aria-busy', 'true');
  if (presentation.ariaValueNow === null) {
    csProgressTrack.removeAttribute('aria-valuenow');
  } else {
    csProgressTrack.setAttribute(
      'aria-valuenow',
      String(presentation.ariaValueNow),
    );
  }
  if (presentation.ariaValueText === null) {
    csProgressTrack.removeAttribute('aria-valuetext');
  } else {
    csProgressTrack.setAttribute('aria-valuetext', presentation.ariaValueText);
  }
}

function hideCrossSectionProgress(): void {
  csProgress.classList.add('d-none');
  csStack.removeAttribute('aria-busy');
  csProgressTrack.removeAttribute('aria-valuenow');
  csProgressTrack.removeAttribute('aria-valuetext');
}

let fieldGridCache: (FieldGrid & { lines: string[] }) | null = null;
let fieldGridStale = true;
let solvedStackup: Stackup | null = null;
let solvedMaterialContext: {
  kind: PresetKind;
  params: PresetParams;
  designFreqHz: number;
} | null = null;
let meshReferenceModel: ReferencePlaneLossModel | null = null;
let meshGroundCurrentBasis: MeshGroundCurrentBasis | null = null;
let meshReferenceSolveKey = '';
let meshReferenceLossError = '';
let dielectricLossModel: DielectricLossModel | null = null;
let dielectricLossSolveKey = '';
let dielectricLossError = '';
let refinedCpwCurrentBasis: MeshGroundCurrentBasis | null = null;
let refinedCpwCurrentSolveKey = '';
let refinedCpwCurrentRequestKey: string | null = null;
let refinedCpwCurrentError = '';
let refinedCpwCurrentGeneration = 0;
let fieldSolveKey = '';
let explicitReferenceFieldMode = false;
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
  if (viewMode === 'field' || viewMode === 'lines') {
    hideCrossSectionProgress();
  }
}

/** Drop field work as soon as its geometry stops matching the form. */
function invalidateFieldGrid() {
  cancelFieldWork();
  fieldGridCache = null;
  fieldGridStale = true;
}

function cancelRefinedCpwCurrentWork(): void {
  refinedCpwCurrentGeneration++;
  refinedCpwCurrentRequestKey = null;
  if (currentMeshClient.busy) currentMeshClient.cancel();
}

function invalidateRefinedCpwCurrent(): void {
  cancelRefinedCpwCurrentWork();
  refinedCpwCurrentBasis = null;
  refinedCpwCurrentSolveKey = '';
  refinedCpwCurrentError = '';
}

function needsRefinedCpwCurrentMesh(): boolean {
  const s = store.get();
  return s.mode === 'preset' && s.presetKind === 'cpw';
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
  const isFieldView = viewMode === 'field' || viewMode === 'lines';
  const isCurrentView = viewMode === 'current';
  if (!isFieldView && !isCurrentView) hideCrossSectionProgress();
  const currentKey = currentSolveKey();
  const needsCpwRefinement = needsRefinedCpwCurrentMesh();
  const currentBasis = needsCpwRefinement
    ? refinedCpwCurrentBasis
    : meshGroundCurrentBasis;
  const currentBasisSolveKey = needsCpwRefinement
    ? refinedCpwCurrentSolveKey
    : meshReferenceSolveKey;
  const meshCurrentIsCurrent =
    currentBasis != null &&
    currentBasisSolveKey !== '' &&
    currentBasisSolveKey === currentKey;
  const stackup = isFieldView || (isCurrentView && meshCurrentIsCurrent)
    ? (solvedStackup ?? currentStackup(s))
    : currentStackup(s);
  const equalAxisScale =
    s.mode === 'freeform' &&
    stackup.items.some(
      (item) => item.kind === 'CircleConductors' || item.kind === 'CircleDielectric',
    );
  const modelUnitScaleM = UNIT_SCALE[stackup.units];
  let currentDistribution = isCurrentView && s.mode === 'preset' &&
      s.presetKind !== 'cpw'
    ? presetGroundCurrentDistribution(
        s.presetKind,
        s.presetVariant,
        s.presetParams,
        modelUnitScaleM,
      )
    : null;
  if (
    isCurrentView &&
    meshCurrentIsCurrent &&
    currentBasis &&
    groundCurrentUsesSolvedMesh(s.mode, s.presetKind)
  ) {
    const driveCurrentsA = Array(
      currentBasis.signalNames.length,
    ).fill(0) as number[];
    if (s.mode === 'freeform') {
      const selected = Math.max(
        0,
        Math.min(
          driveCurrentsA.length - 1,
          parseInt(csDriven.value || '0', 10),
        ),
      );
      driveCurrentsA[selected] = 1;
    } else {
      const bindings = solverSignalBindings(stackup);
      for (const [drawingIndex, binding] of bindings.entries()) {
        const resultIndex = currentBasis.signalNames.indexOf(
          binding.solverName,
        );
        if (resultIndex < 0) continue;
        driveCurrentsA[resultIndex] =
          s.presetVariant === 'diff' && drawingIndex === 1 ? -1 : 1;
      }
    }
    currentDistribution = meshGroundCurrentDistribution(
      currentBasis,
      driveCurrentsA,
    );
  }
  const refinedCpwCurrentBusy =
    needsCpwRefinement && refinedCpwCurrentRequestKey === currentKey;
  const currentProgressKind: CrossSectionProgressKind | undefined =
    !isCurrentView
      ? undefined
      : s.solving
        ? 'return-current'
        : refinedCpwCurrentBusy
          ? 'complex-return-current'
          : undefined;
  const currentUnavailableMessage =
    !isCurrentView || currentDistribution
      ? undefined
      : needsCpwRefinement && refinedCpwCurrentError
        ? `Return-current mesh could not be calculated: ${refinedCpwCurrentError}`
        : meshReferenceLossError
          ? `Return-current mesh could not be calculated: ${meshReferenceLossError}`
          : 'Solve the geometry to calculate return-current density.';
  csStack.classList.remove('d-none');
  let vp: Viewport;
  try {
    const cover = s.mode === 'preset' ? s.presetParams.cover : null;
    vp = renderCrossSection(csSvg, stackup, {
      showDims:
        !isFieldView &&
        !isCurrentView &&
        s.mode === 'preset',
      outline: isFieldView,
      onDimClick: focusField,
      onDimHover: hoverField,
      displayUnit: s.displayUnit as DimUnit,
      coverProfile:
        !isFieldView && cover
          ? { tCopper: cover.tCopper, tBase: cover.tBase, tBetween: cover.tBetween }
          : undefined,
      presetKind: s.mode === 'preset' ? s.presetKind : undefined,
      showSignalNames:
        s.mode === 'freeform' &&
        !isFieldView &&
        !isCurrentView,
      blankDielectric: isCurrentView,
      viewWidthMultiplier: isCurrentView ? 2 : 1,
      equalAxisScale,
      groundCurrentOverlay: isCurrentView
        ? {
          distribution: currentDistribution,
          unavailableMessage: currentUnavailableMessage,
          suppressUnavailableMessage: currentProgressKind != null,
          modelUnitScaleM,
          displayUnit: s.displayUnit as DimUnit,
        }
        : undefined,
    });
  } catch (e) {
    $('#cs-note').textContent = (e as Error).message;
    return;
  }
  $('#cs-note').textContent = '';

  if (isCurrentView) {
    csCanvas.classList.add('d-none');
    if (currentProgressKind) {
      showCrossSectionProgress(currentProgressKind);
    } else {
      hideCrossSectionProgress();
    }
    const currentNames = meshCurrentIsCurrent
      ? currentBasis?.signalNames ?? []
      : [];
    const showDrivenSelect = s.mode === 'freeform' && currentNames.length > 1;
    const showDrivenLabel = s.mode === 'freeform' && currentNames.length === 1;
    if (currentNames.length > 0) {
      const selected = Math.max(
        0,
        Math.min(
          currentNames.length - 1,
          parseInt(csDriven.value || '0', 10),
        ),
      );
      const optionsMatch =
        csDriven.options.length === currentNames.length &&
        currentNames.every(
          (name, index) => csDriven.options[index]?.textContent === `drive: ${name}`,
        );
      if (!optionsMatch) {
        csDriven.replaceChildren(
          ...currentNames.map((name, index) => {
            const option = new Option(`drive: ${name}`, String(index));
            option.selected = index === selected;
            return option;
          }),
        );
      }
      csDriven.value = String(selected);
      if (showDrivenLabel) csDrivenLabel.textContent = `drive: ${currentNames[0]}`;
    }
    csDriven.classList.toggle('d-none', !showDrivenSelect);
    csDrivenLabel.classList.toggle('d-none', !showDrivenLabel);
    csLegend.classList.add('d-none');
    csLegend.classList.remove('d-flex');
    return;
  }

  const showField = isFieldView && fieldGridCache && !fieldGridStale;
  const lineCount = fieldGridCache?.lines.length ?? 0;
  const selectedLine = Math.max(0, parseInt(csDriven.value || '0', 10));
  const showDrivenSelect = isFieldView && lineCount > 1;
  const showDrivenLabel = isFieldView && lineCount === 1;
  csCanvas.classList.toggle('d-none', !(viewMode === 'field' && showField));
  csLegend.classList.toggle('d-none', !isFieldView);
  csLegend.classList.toggle('d-flex', isFieldView);
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
    const equalAxisScale =
      s.mode === 'freeform' &&
      stackup.items.some(
        (item) => item.kind === 'CircleConductors' || item.kind === 'CircleDielectric',
      );
    const vp = computeViewport(geo, 1, equalAxisScale);
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
      // Plane-backed solves have no physical region below y=0. An isolated
      // explicit-reference solve instead uses a remote image plane outside
      // the viewport, so both sides of its physical conductors stay visible.
      ...(!explicitReferenceFieldMode
        ? [{ x0: bbox.x0 - 1, y0: bbox.y0 - 1, x1: bbox.x1 + 1, y1: 0 }]
        : []),
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
    if (!background) {
      showCrossSectionProgress('field', 0);
    }
    let grid: FieldGrid & { lines: string[] };
    try {
      grid = await fieldClient.fieldGrid(
        { fieldText, lineIndex, bbox, nx, ny, masks, maskPolys },
        (frac) => {
          if (!background && generation === fieldGeneration) {
            showCrossSectionProgress('field', frac);
          }
        },
      );
    } finally {
      if (!background && generation === fieldGeneration) hideCrossSectionProgress();
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
    if (viewMode === 'field' || viewMode === 'lines') renderCS();
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
  ['#cs-view-current', 'current'],
] as Array<[string, ViewMode]>) {
  $(id).addEventListener('change', () => {
    viewMode = mode;
    if (mode !== 'field' && mode !== 'lines' && fieldClient.busy) {
      cancelFieldWork();
    }
    if (mode !== 'current' && currentMeshClient.busy) {
      cancelRefinedCpwCurrentWork();
      hideCrossSectionProgress();
    }
    if (
      (mode === 'field' || mode === 'lines') &&
      (fieldGridStale || !fieldGridCache)
    ) void computeFieldGrid();
    else {
      renderCS();
      if (mode === 'current') void ensureRefinedCpwCurrentMesh();
    }
  });
}
csDriven.addEventListener('change', () => {
  if (viewMode === 'current') {
    renderCS();
    return;
  }
  invalidateFieldGrid();
  void computeFieldGrid();
});

/* ---------------- solve ---------------- */
const btnSolve = $('#btn-solve') as HTMLButtonElement;
const btnCancel = $('#btn-cancel') as HTMLButtonElement;
const spinner = $('#solve-spinner');
const solveNote = $('#solve-note');
let solveGeneration = 0;

function capacitanceMatrixInOrder(
  result: SolveResult,
  expectedNames: readonly string[],
): number[][] {
  if (
    result.names.length !== result.nSignals ||
    result.B.length !== result.nSignals ||
    result.B.some((row) => row.length !== result.nSignals)
  ) {
    throw new Error('The dielectric participation solve returned an incomplete capacitance matrix.');
  }
  const byName = new Map(result.names.map((name, index) => [name, index]));
  if (byName.size !== result.names.length) {
    throw new Error('The dielectric participation solve returned duplicate signal names.');
  }
  const order = expectedNames.map((name) => {
    const index = byName.get(name);
    if (index == null) {
      throw new Error(`The dielectric participation solve is missing signal ${name}.`);
    }
    return index;
  });
  return order.map((row) => order.map((column) => {
    const value = result.B[row][column];
    if (!Number.isFinite(value)) {
      throw new Error('The dielectric participation matrix contains a non-finite value.');
    }
    return value;
  }));
}

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
  meshReferenceModel = null;
  meshGroundCurrentBasis = null;
  meshReferenceSolveKey = '';
  meshReferenceLossError = '';
  dielectricLossModel = null;
  dielectricLossSolveKey = '';
  dielectricLossError = '';
  invalidateRefinedCpwCurrent();
  // Invalidate any field reconstruction from the previous geometry before
  // starting the primary BEM solve.
  invalidateFieldGrid();
  store.update({ solving: true });
  btnSolve.disabled = true;
  spinner.classList.remove('d-none');
  btnCancel.classList.toggle('d-none', false);
  try {
    const explicitPreparation = isExplicitReferenceStackup(stackup)
      ? prepareExplicitReferenceStackup(stackup)
      : null;
    const nativeStackup = explicitPreparation?.solverStackup ?? stackup;
    const xsctn = generateXsctn(nativeStackup);
    const solveKey = `${xsctn}|${nativeStackup.cseg}|${nativeStackup.dseg}`;
    // mark this input as handled even if it fails: auto-solve must not
    // retry an unchanged config in a loop
    lastSolveKey = solveKey;
    const rawOut = await client.solve(
      xsctn,
      nativeStackup.cseg,
      nativeStackup.dseg,
    );
    if (generation !== solveGeneration) return;
    let out: SolveOutput = rawOut;
    let freeSpaceOut: SolveOutput | null = null;
    let explicitReduction = null;
    if (rawOut.ok && rawOut.result && explicitPreparation) {
      const airStackup = freeSpaceStackup(explicitPreparation.solverStackup);
      const airXsctn = generateXsctn(airStackup);
      if (airXsctn !== xsctn) {
        solveNote.textContent = 'calculating free-space current basis...';
        freeSpaceOut = await client.solve(
          airXsctn,
          airStackup.cseg,
          airStackup.dseg,
        );
        if (generation !== solveGeneration) return;
      } else {
        // With no physical dielectric, the primary solve already is the
        // all-air magnetic and longitudinal-current basis.
        freeSpaceOut = rawOut;
      }
      if (!freeSpaceOut.ok || !freeSpaceOut.result || !freeSpaceOut.fieldText) {
        throw new Error(
          freeSpaceOut.error ||
          'The explicit-reference free-space solve did not return a complete field basis.',
        );
      }
      const freeSpaceResult = freeSpaceOut.result;
      // The neutral projection is part of the physical solve, not an optional
      // loss post-process. L and the surface-current basis must come from C0.
      explicitReduction = reduceExplicitReferenceResults(
        explicitPreparation,
        rawOut.result,
        freeSpaceResult,
      );
      if (!rawOut.fieldText) {
        throw new Error(
          'The explicit-reference solve did not return a field basis.',
        );
      }
      // Combine the full-active bases into physical 1 V excitations, restore
      // the original coordinates, and carry the remote image-plane position
      // as internal reconstruction metadata.
      const physicalFieldText = transformExplicitReferenceFieldText(
        rawOut.fieldText,
        explicitPreparation,
        explicitReduction,
      );
      out = {
        ...exposeExplicitReferenceSolveOutput(rawOut, explicitReduction),
        fieldText: physicalFieldText,
      };
      try {
        solveNote.textContent = 'calculating mesh surface-current loss...';
        const meshAnalysis = meshExplicitReferenceAnalysis(
          stackup,
          freeSpaceOut,
          explicitPreparation,
          explicitReduction,
        );
        meshReferenceModel = meshAnalysis.lossModel;
        meshGroundCurrentBasis = meshAnalysis.currentBasis;
        meshReferenceSolveKey = solveKey;
      } catch (error) {
        meshReferenceLossError =
          error instanceof Error ? error.message : String(error);
      }
    } else if (rawOut.ok && rawOut.result) {
      try {
        solveNote.textContent = 'calculating mesh surface-current loss...';
        const airStackup = freeSpaceStackup(stackup);
        freeSpaceOut = await client.solve(
          generateXsctn(airStackup),
          airStackup.cseg,
          airStackup.dseg,
        );
        if (generation !== solveGeneration) return;
        if (!freeSpaceOut.ok || !freeSpaceOut.result || !freeSpaceOut.fieldText) {
          throw new Error(
            freeSpaceOut.error ||
            'the free-space current-basis solve did not return mesh data',
          );
        }
        const meshAnalysis = meshReferenceAnalysis(
          stackup,
          freeSpaceOut,
        );
        meshReferenceModel = meshAnalysis.lossModel;
        meshGroundCurrentBasis = meshAnalysis.currentBasis;
        meshReferenceSolveKey = solveKey;
      } catch (error) {
        meshReferenceLossError =
          error instanceof Error ? error.message : String(error);
      }
    }
    if (s.mode === 'freeform' && out.ok && out.result) {
      try {
        const perturbation = dielectricParticipationPerturbation(nativeStackup);
        if (perturbation) {
          solveNote.textContent = 'calculating dielectric energy participation...';
          const positiveOut = await client.solve(
            generateXsctn(perturbation.positiveStackup),
            perturbation.positiveStackup.cseg,
            perturbation.positiveStackup.dseg,
          );
          if (generation !== solveGeneration) return;
          if (!positiveOut.ok || !positiveOut.result) {
            throw new Error(
              positiveOut.error ||
              'The positive dielectric participation solve failed.',
            );
          }
          const negativeOut = await client.solve(
            generateXsctn(perturbation.negativeStackup),
            perturbation.negativeStackup.cseg,
            perturbation.negativeStackup.dseg,
          );
          if (generation !== solveGeneration) return;
          if (!negativeOut.ok || !negativeOut.result) {
            throw new Error(
              negativeOut.error ||
              'The negative dielectric participation solve failed.',
            );
          }

          const physicalCapacitance = (result: SolveResult): number[][] => {
            if (!explicitPreparation) {
              return capacitanceMatrixInOrder(result, out.result!.names);
            }
            if (!freeSpaceOut?.result) {
              throw new Error(
                'The explicit-reference free-space basis is unavailable for dielectric loss.',
              );
            }
            const reduced = reduceExplicitReferenceResults(
              explicitPreparation,
              result,
              freeSpaceOut.result,
            );
            return capacitanceMatrixInOrder(
              reduced.result,
              out.result!.names,
            );
          };
          dielectricLossModel = dielectricLossModelFromPerturbation(
            physicalCapacitance(positiveOut.result),
            physicalCapacitance(negativeOut.result),
            perturbation.maxLossTangent,
            perturbation.logPermittivityStep,
            out.result.B,
          );
          dielectricLossSolveKey = solveKey;
        }
      } catch (error) {
        dielectricLossError =
          error instanceof Error ? error.message : String(error);
      }
    }
    solveNote.textContent = '';
    solvedStackup = stackup;
    solvedMaterialContext = materialContext;
    explicitReferenceFieldMode = !!explicitPreparation && out.ok;
    fieldSolveKey = '';
    fieldSolveKey = solveKey;
    (window as unknown as Record<string, unknown>).__tntweb = {
      out,
      rawOut,
      freeSpaceOut,
      explicitPreparation,
      explicitReduction,
      meshReferenceModel,
      meshGroundCurrentBasis,
      dielectricLossModel,
      dielectricLossError,
      stackup,
      xsctn,
    };
    store.update({ lastSolve: out, solving: false });
    if (out.ok && out.fieldText && currentSolveKey() === solveKey) {
      if (viewMode === 'field' || viewMode === 'lines') {
        void computeFieldGrid();
      }
      else if (viewMode === 'current') {
        void ensureRefinedCpwCurrentMesh();
      } else scheduleIdleFieldWarm();
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
    const nativeStackup = isExplicitReferenceStackup(stackup)
      ? prepareExplicitReferenceStackup(stackup).solverStackup
      : stackup;
    return `${generateXsctn(nativeStackup)}|${nativeStackup.cseg}|${nativeStackup.dseg}`;
  } catch {
    return lastSolveKey; // un-generatable state: leave auto-solve idle
  }
}

async function ensureRefinedCpwCurrentMesh(): Promise<void> {
  const s = store.get();
  if (
    viewMode !== 'current' ||
    !needsRefinedCpwCurrentMesh() ||
    s.solving ||
    !solvedStackup ||
    !fieldSolveKey
  ) {
    return;
  }
  const solveKey = currentSolveKey();
  if (
    solveKey !== fieldSolveKey ||
    refinedCpwCurrentSolveKey === solveKey ||
    refinedCpwCurrentRequestKey === solveKey
  ) {
    return;
  }
  cancelRefinedCpwCurrentWork();
  const generation = ++refinedCpwCurrentGeneration;
  const stackup = solvedStackup;
  refinedCpwCurrentRequestKey = solveKey;
  refinedCpwCurrentError = '';
  renderCS();

  try {
    const refinedAirStackup = refineConductorMesh(
      freeSpaceStackup(stackup),
      CPW_RETURN_CURRENT_MESH_MULTIPLIER,
    );
    const output = await currentMeshClient.solve(
      generateXsctn(refinedAirStackup),
      refinedAirStackup.cseg,
      refinedAirStackup.dseg,
      (fraction) => {
        if (
          generation === refinedCpwCurrentGeneration &&
          refinedCpwCurrentRequestKey === solveKey &&
          solveKey === currentSolveKey() &&
          solveKey === fieldSolveKey &&
          viewMode === 'current'
        ) {
          showCrossSectionProgress('complex-return-current', fraction);
        }
      },
    );
    if (
      generation !== refinedCpwCurrentGeneration ||
      solveKey !== currentSolveKey() ||
      solveKey !== fieldSolveKey
    ) {
      return;
    }
    if (!output.ok || !output.result || !output.fieldText) {
      throw new Error(
        output.error ||
        'the refined free-space current solve did not return mesh data',
      );
    }
    refinedCpwCurrentBasis = meshReferenceAnalysis(
      stackup,
      output,
    ).currentBasis;
    refinedCpwCurrentSolveKey = solveKey;
    const diagnostics = (
      window as unknown as Record<string, unknown>
    ).__tntweb;
    if (diagnostics && typeof diagnostics === 'object') {
      Object.assign(diagnostics, {
        refinedCpwCurrentOutput: output,
        refinedCpwCurrentBasis,
        refinedCpwCurrentCseg: refinedAirStackup.cseg,
      });
    }
  } catch (error) {
    if (generation !== refinedCpwCurrentGeneration) return;
    refinedCpwCurrentError =
      error instanceof Error ? error.message : String(error);
  } finally {
    if (generation === refinedCpwCurrentGeneration) {
      refinedCpwCurrentRequestKey = null;
      if (viewMode === 'current') renderCS();
    }
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
  meshReferenceModel = null;
  meshGroundCurrentBasis = null;
  meshReferenceSolveKey = '';
  meshReferenceLossError = '';
  invalidateRefinedCpwCurrent();
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

/* ---------------- model export ---------------- */
const btnExportS2p = $('#btn-export-s2p') as HTMLButtonElement;
const btnPreviewS2p = $('#btn-preview-s2p') as HTMLButtonElement;
const btnExportS4p = $('#btn-export-s4p') as HTMLButtonElement;
const btnPreviewS4p = $('#btn-preview-s4p') as HTMLButtonElement;
const btnExportSdd2p = $('#btn-export-sdd2p') as HTMLButtonElement;
const btnPreviewSdd2p = $('#btn-preview-sdd2p') as HTMLButtonElement;
const btnExportSnp = $('#btn-export-snp') as HTMLButtonElement;
const btnPreviewSnp = $('#btn-preview-snp') as HTMLButtonElement;
const btnExportWElement = $('#btn-export-welement') as HTMLButtonElement;
const btnCopyWElement = $('#btn-copy-welement') as HTMLButtonElement;
const btnExportSubckt = $('#btn-export-subckt') as HTMLButtonElement;
const btnCopySubckt = $('#btn-copy-subckt') as HTMLButtonElement;
const btnCopyPreview = $('#btn-copy-preview') as HTMLButtonElement;
const ladderSectionsInput = $('#export-ladder-sections') as HTMLInputElement;
const ladderRecommendationNote = $('#export-ladder-recommendation');
const touchstoneSingleSection = $('#export-touchstone-single');
const touchstoneDifferentialSection = $('#export-touchstone-differential');
const touchstoneArbitrarySection = $('#export-touchstone-arbitrary');
const touchstoneArbitraryNote = $('#export-touchstone-arbitrary-note');
const exportDerived = $('#export-derived');
const exportStatus = $('#export-status');
const exportPreviewWrap = $('#export-preview-wrap');
const exportPreviewLabel = $('#export-preview-label');
const exportTextPreview = $('#export-text-preview') as HTMLTextAreaElement;
let ladderRecommendation: number | null = null;
let ladderRecommendationKey: string | null = null;
let ladderSectionsUserEdited = false;

function solvedLossMaterial(): {
  tanD: number;
  tanDAtHz?: (frequencyHz: number) => number;
} {
  if (!solvedStackup) return { tanD: 0 };
  // Free-form dielectric loss is obtained from the solved participation
  // matrix, not by selecting one arbitrary region's material value.
  if (!solvedMaterialContext) return { tanD: 0 };
  const substrateId = solvedMaterialContext?.kind === 'stripline' ? 'sub1' : 'sub';
  const substrate = solvedMaterialContext
    ? solvedStackup.items.find(
      (item) => item.kind === 'DielectricLayer' && item.id === substrateId,
    )
    : solvedStackup.items.find((item) => item.kind === 'DielectricLayer');
  let tanD = substrate?.kind === 'DielectricLayer' ? substrate.lossTangent : 0;
  let tanDAtHz: ((frequencyHz: number) => number) | undefined;
  if (solvedMaterialContext) {
    const { kind, params, designFreqHz } = solvedMaterialContext;
    if (
      (kind === 'stripline' && params.striplineSeparateMaterials) ||
      params.laminateId
    ) {
      tanDAtHz = (frequencyHz) =>
        presetLossTangentAtFrequency(kind, params, frequencyHz);
      tanD = tanDAtHz(designFreqHz);
    }
  }
  return { tanD, tanDAtHz };
}

function exportReady(): boolean {
  const s = store.get();
  const solved = !!s.lastSolve?.ok && !!s.lastSolve.result && !!solvedStackup;
  const current = solved && !!fieldSolveKey && currentSolveKey() === fieldSolveKey;
  return current && !s.solving;
}

function selectedModelExportFlow(): ModelExportInput['flow'] {
  const s = store.get();
  if (s.mode === 'freeform') return 'arbitrary';
  return s.presetVariant === 'diff' ? 'preset-diff' : 'preset-se';
}

function currentReferencePlaneLossModel() {
  if (
    meshReferenceModel &&
    meshReferenceSolveKey &&
    meshReferenceSolveKey === currentSolveKey()
  ) {
    return meshReferenceModel;
  }
  const s = store.get();
  if (s.mode !== 'preset') return null;
  return presetReferencePlaneLossModel(
    s.presetKind,
    s.presetVariant,
    s.presetParams,
    UNIT_SCALE.mils,
  );
}

function currentDielectricLossModel(): DielectricLossModel | null {
  if (
    dielectricLossModel &&
    dielectricLossSolveKey &&
    dielectricLossSolveKey === currentSolveKey()
  ) {
    return dielectricLossModel;
  }
  return null;
}

function buildModelExportInput(): ModelExportInput {
  const s = store.get();
  if (!exportReady() || !solvedStackup || !s.lastSolve?.result) {
    throw new Error('Solve the current stackup before exporting a model.');
  }
  const result = s.lastSolve.result;
  const bindings = new Map(
    solverSignalBindings(solvedStackup).map((binding) => [
      binding.solverName,
      binding.conductor,
    ]),
  );
  const conductors = result.names.map((name) => bindings.get(name));
  if (conductors.some((conductor) => !conductor)) {
    throw new Error('Could not match every solved signal to its conductor geometry.');
  }
  const material = solvedLossMaterial();
  const dielectricLoss = currentDielectricLossModel();
  if (
    s.mode === 'freeform' &&
    hasLossyDielectric(solvedStackup) &&
    !dielectricLoss
  ) {
    throw new Error(
      dielectricLossError ||
      'The dielectric participation model is not ready for this geometry.',
    );
  }
  const lossParams = lossSweepParamsForDesign(s.lossParams, s.designFreqHz);
  return {
    title: solvedStackup.title,
    flow: selectedModelExportFlow(),
    result,
    conductors: conductors as ConductorItem[],
    unitScaleM: UNIT_SCALE[solvedStackup.units],
    lengthM: s.lineLengthM,
    designFreqHz: s.designFreqHz,
    lossParams,
    referencePlane: currentReferencePlaneLossModel() ?? undefined,
    dielectricLoss: dielectricLoss ?? undefined,
    tanD: material.tanD,
    tanDAtHz: material.tanDAtHz,
  };
}

function ladderSections(): number {
  const entered = Number(ladderSectionsInput.value);
  const sections = Number.isFinite(entered) && entered >= 1
    ? Math.max(1, Math.round(entered))
    : (ladderRecommendation ?? 1);
  ladderSectionsInput.value = String(sections);
  return sections;
}

function syncLadderRecommendation(
  result: ModelExportInput['result'] | null | undefined,
  flow: ModelExportInput['flow'],
  lineLengthM: number,
  bandwidthHz: number,
  ready: boolean,
): void {
  if (!ready || !result) {
    ladderRecommendation = null;
    ladderRecommendationNote.textContent = '';
    return;
  }
  const sections = recommendedLadderSections(
    result,
    flow,
    lineLengthM,
    bandwidthHz,
  );
  const delayPerM = ladderDelayPerM(result, flow);
  if (sections == null || delayPerM == null) {
    ladderRecommendation = null;
    ladderRecommendationNote.textContent = '';
    return;
  }
  const key = `${flow}|${lineLengthM}|${bandwidthHz}|${delayPerM}`;
  ladderRecommendation = sections;
  ladderRecommendationNote.textContent = ladderSectionRequirementText(
    sections,
    bandwidthHz,
  );
  if (key !== ladderRecommendationKey) {
    ladderRecommendationKey = key;
    ladderSectionsUserEdited = false;
  }
  if (!ladderSectionsUserEdited) {
    ladderSectionsInput.value = String(sections);
  }
}

function downloadModel(file: ExportedModelFile): void {
  const url = URL.createObjectURL(new Blob([file.text], { type: file.mimeType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  exportStatus.textContent = 'Model downloaded.';
}

function showModelPreview(file: ExportedModelFile): void {
  exportPreviewLabel.textContent = 'Model preview';
  exportTextPreview.value = file.text;
  exportPreviewWrap.classList.remove('d-none');
  exportTextPreview.scrollTop = 0;
}

function clearModelPreview(): void {
  exportTextPreview.value = '';
  exportPreviewWrap.classList.add('d-none');
}

async function copyPreview(): Promise<void> {
  const text = exportTextPreview.value;
  if (!text) return;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
  } else {
    exportTextPreview.focus();
    exportTextPreview.select();
    if (!document.execCommand('copy')) throw new Error('Clipboard access was unavailable.');
  }
  exportStatus.textContent = 'Copied the model preview to the clipboard.';
}

function runDownload(builder: () => ExportedModelFile): void {
  try {
    downloadModel(builder());
  } catch (error) {
    exportStatus.textContent = error instanceof Error ? error.message : String(error);
  }
}

async function runPreview(builder: () => ExportedModelFile): Promise<void> {
  try {
    const file = builder();
    showModelPreview(file);
    try {
      await copyPreview();
      exportStatus.textContent = 'Model preview is shown below and copied.';
    } catch {
      exportStatus.textContent = 'Model preview is shown below. Use Copy to place it on the clipboard.';
    }
  } catch (error) {
    exportStatus.textContent = error instanceof Error ? error.message : String(error);
  }
}

function updateExportState() {
  const s = store.get();
  const selectedFlow = selectedModelExportFlow();
  const selectedSignalCount = signalCount(currentStackup(s));
  const result = s.lastSolve?.result;
  touchstoneArbitraryNote.textContent = result?.floatingDifferential
    ? '100 Ω differential input/output two-port; common mode is not included.'
    : 'Two ports per conductor, using the internal solver names and order.';
  touchstoneSingleSection.classList.toggle('d-none', selectedFlow !== 'preset-se');
  touchstoneDifferentialSection.classList.toggle('d-none', selectedFlow !== 'preset-diff');
  touchstoneArbitrarySection.classList.toggle('d-none', selectedFlow !== 'arbitrary');
  const selectedPortCount =
    result?.nSignals === 1 && result.floatingDifferential
      ? 2
      : Math.max(2, 2 * selectedSignalCount);
  btnExportSnp.textContent = `Download .s${selectedPortCount}p`;
  btnPreviewSnp.setAttribute(
    'aria-label',
    `Preview and copy Touchstone .s${selectedPortCount}p`,
  );
  const solved = !!s.lastSolve?.ok && !!s.lastSolve.result && !!solvedStackup;
  const current = solved && !!fieldSolveKey && currentSolveKey() === fieldSolveKey;
  const ready = current && !s.solving;
  if (!ready) clearModelPreview();
  syncLadderRecommendation(
    result,
    selectedFlow,
    s.lineLengthM,
    s.designFreqHz,
    ready,
  );
  const singleEnded =
    ready && selectedFlow === 'preset-se' && result?.nSignals === 1;
  const differential =
    ready &&
    selectedFlow === 'preset-diff' &&
    !!result &&
    supportsDifferentialTouchstone(result);
  const arbitrary =
    ready &&
    selectedFlow === 'arbitrary' &&
    !!result &&
    result.nSignals >= 1;
  btnExportS2p.disabled = !singleEnded;
  btnPreviewS2p.disabled = !singleEnded;
  btnExportS4p.disabled = !differential;
  btnPreviewS4p.disabled = !differential;
  btnExportSdd2p.disabled = !differential;
  btnPreviewSdd2p.disabled = !differential;
  btnExportSnp.disabled = !arbitrary;
  btnPreviewSnp.disabled = !arbitrary;
  btnExportWElement.disabled = !ready;
  btnCopyWElement.disabled = !ready;
  btnExportSubckt.disabled = !ready;
  btnCopySubckt.disabled = !ready;
  exportDerived.textContent = solved && result
    ? result.nSignals === 1 && result.floatingDifferential
      ? `One differential mode: ${result.floatingDifferential.positiveName} (+), ` +
        `${result.floatingDifferential.negativeName} (-).`
      : `${result.nSignals} signal conductor${result.nSignals === 1 ? '' : 's'} ` +
        `in solver order: ${result.names.join(', ')}.`
    : 'Solve a stackup to show signal count and conductor order.';

  if (s.solving) {
    exportStatus.textContent = 'Waiting for the current solve before model export.';
  } else if (solved && !current) {
    exportStatus.textContent = 'Inputs changed; export will unlock after the updated solve finishes.';
  } else if (ready) {
    if (selectedFlow === 'preset-diff' && !differential) {
      exportStatus.textContent =
        'Differential Touchstone requires a symmetric solved pair.';
    } else {
      exportStatus.textContent = '';
    }
  } else {
    exportStatus.textContent = 'Solve a valid stackup to enable model export.';
  }
}

btnExportS2p.addEventListener('click', () =>
  runDownload(() => exportTouchstoneS2p(buildModelExportInput())));
btnPreviewS2p.addEventListener('click', () =>
  void runPreview(() => exportTouchstoneS2p(buildModelExportInput())));
btnExportS4p.addEventListener('click', () =>
  runDownload(() => exportTouchstoneS4p(buildModelExportInput())));
btnPreviewS4p.addEventListener('click', () =>
  void runPreview(() => exportTouchstoneS4p(buildModelExportInput())));
btnExportSdd2p.addEventListener('click', () =>
  runDownload(() => exportTouchstoneDifferentialS2p(buildModelExportInput())));
btnPreviewSdd2p.addEventListener('click', () =>
  void runPreview(() => exportTouchstoneDifferentialS2p(buildModelExportInput())));
btnExportSnp.addEventListener('click', () =>
  runDownload(() => exportTouchstoneNPort(buildModelExportInput())));
btnPreviewSnp.addEventListener('click', () =>
  void runPreview(() => exportTouchstoneNPort(buildModelExportInput())));
btnExportWElement.addEventListener('click', () =>
  runDownload(() => exportHspiceWElement(buildModelExportInput())));
btnCopyWElement.addEventListener('click', () =>
  void runPreview(() => exportHspiceWElement(buildModelExportInput())));
btnExportSubckt.addEventListener('click', () =>
  runDownload(() =>
    exportGenericSpiceSubcircuit(buildModelExportInput(), ladderSections())));
btnCopySubckt.addEventListener('click', () =>
  void runPreview(() =>
    exportGenericSpiceSubcircuit(buildModelExportInput(), ladderSections())));
btnCopyPreview.addEventListener('click', () => {
  void copyPreview().catch((error: unknown) => {
    exportStatus.textContent = error instanceof Error ? error.message : String(error);
  });
});
ladderSectionsInput.addEventListener('input', () => {
  ladderSectionsUserEdited = true;
  clearModelPreview();
  updateExportState();
});
ladderSectionsInput.addEventListener('change', () => {
  const entered = Number(ladderSectionsInput.value);
  if (!Number.isFinite(entered) || entered < 1) {
    ladderSectionsUserEdited = false;
  }
  ladderSections();
  clearModelPreview();
  updateExportState();
});

/* ---------------- loss & line stats ---------------- */
function drivingConductor(stackup: Stackup, solverName: string | undefined): ConductorItem | null {
  if (solverName) {
    const matched = solverSignalBindings(stackup).find((binding) => binding.solverName === solverName);
    if (matched) return matched.conductor;
  }
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
  const cond = drivingConductor(solvedStackup, out.result.names[0]);
  if (!cond) return;
  const { tanD, tanDAtHz } = solvedLossMaterial();
  const diffMode =
    s.mode === 'preset' &&
    s.presetVariant === 'diff' &&
    out.result.nSignals === 2 &&
    out.result.zOdd != null;
  const inputs = lossInputsFrom(out.result, cond, UNIT_SCALE[solvedStackup.units], tanD, diffMode);
  if (!inputs) {
    note.textContent = 'no loss inputs';
    return;
  }
  if (tanDAtHz) inputs.tanDAtHz = tanDAtHz;
  const dielectricLoss = currentDielectricLossModel();
  if (dielectricLoss) {
    inputs.dielectricLoss = dielectricLoss;
    inputs.dielectricLossMode = diffMode ? 'odd' : 'single';
  }
  const referencePlane = currentReferencePlaneLossModel();
  if (referencePlane) {
    inputs.referencePlane = referencePlane;
    inputs.referencePlaneMode = diffMode ? 'odd' : 'single';
  }
  const sweepParams = lossSweepParamsForDesign(s.lossParams, s.designFreqHz);
  const curve = lossCurve(inputs, sweepParams);
  const floatingDifferential = out.result.floatingDifferential != null;
  const modeLabel =
    floatingDifferential
      ? 'differential mode'
      : diffMode
        ? 'odd mode, per line'
        : (s.mode === 'freeform' ? (out.result.names[0] ?? 'line 1') : 'single-ended');
  renderLossPlot(plotEl, curve, s.lineLengthM, s.designFreqHz, modeLabel);

  const curveCoversDesignFrequency =
    s.designFreqHz >= curve.fHz[0] &&
    s.designFreqHz <= curve.fHz[curve.fHz.length - 1];
  // Keep the plotted/export sweep honest while still evaluating the design
  // frequency itself when it lies outside that sweep.
  const statsCurve = curveCoversDesignFrequency
    ? curve
    : lossCurve(inputs, {
      ...sweepParams,
      fMinHz: s.designFreqHz,
      fMaxHz: s.designFreqHz,
      nPoints: 2,
    });
  const stats = computeLineStats(out.result, statsCurve, s.lineLengthM, s.designFreqHz, diffMode);
  if (stats) {
    const fLabel = s.designFreqHz >= 1e9 ? `${+(s.designFreqHz / 1e9).toPrecision(3)} GHz` : `${+(s.designFreqHz / 1e6).toPrecision(3)} MHz`;
    statsEl.innerHTML = [
      statCard('Insertion loss @ ' + fLabel, `${stats.lossDb.toFixed(2)} dB`, `cond-only ${stats.lossCondDb.toFixed(2)} / diel-only ${stats.lossDielDb.toFixed(2)} dB`),
      statCard(
        'DC resistance',
        Number.isFinite(stats.rdcOhm) ? `${stats.rdcOhm.toFixed(3)} Ω` : '—',
        s.lossParams.includeReferencePlaneLoss && referencePlane
          ? floatingDifferential
            ? 'driven + return conductor'
            : 'signal + reference plane'
          : 'signal conductor only',
      ),
      statCard('Delay', `${stats.delayPs.toFixed(1)} ps`, `${(stats.wavelengths).toFixed(2)} λ @ ${fLabel}`),
      statCard('Phase @ ' + fLabel, `${stats.phaseDeg.toFixed(1)}°`, `${(stats.phaseDeg / 360).toFixed(2)} turns`),
    ].join('');
  }
  if (dielectricLossError) {
    note.textContent =
      `Dielectric participation loss could not be calculated: ${dielectricLossError}`;
  } else if (!referencePlane) {
    note.textContent = meshReferenceLossError
      ? `Reference-plane mesh loss could not be calculated: ${meshReferenceLossError}`
      : 'Reference-plane mesh loss is not ready for this solve.';
  } else {
    note.textContent = s.lossParams.includeReferencePlaneLoss
      ? ''
      : 'Reference-plane loss excluded.';
  }
}

$('#loss-reference-plane').addEventListener('change', (event) => {
  store.update({
    lossParams: {
      ...store.get().lossParams,
      includeReferencePlaneLoss: (event.target as HTMLInputElement).checked,
    },
  });
  renderLoss();
});
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
$('#loss-huray-radius').addEventListener('change', (e) => {
  store.update({
    lossParams: {
      ...store.get().lossParams,
      hurayRadiusUm: Math.max(0, parseFloat((e.target as HTMLInputElement).value) || 0),
    },
  });
  renderLoss();
});
$('#loss-huray-ratio').addEventListener('change', (e) => {
  store.update({
    lossParams: {
      ...store.get().lossParams,
      hurayRatio: Math.max(0, parseFloat((e.target as HTMLInputElement).value) || 0),
    },
  });
  renderLoss();
});

function syncLossControls() {
  const p = store.get().lossParams;
  const referencePlaneBox = $(
    '#loss-reference-plane',
  ) as HTMLInputElement;
  referencePlaneBox.checked = p.includeReferencePlaneLoss;
  referencePlaneBox.disabled = false;
  referencePlaneBox.title = '';
  ($('#loss-model') as HTMLSelectElement).value = p.roughnessModel;
  ($('#loss-rq') as HTMLInputElement).value = String(p.roughnessRqUm);
  ($('#loss-huray-radius') as HTMLInputElement).value = String(p.hurayRadiusUm);
  ($('#loss-huray-ratio') as HTMLInputElement).value = String(p.hurayRatio);
  $('#loss-hammerstad-fields').classList.toggle('d-none', p.roughnessModel !== 'hammerstad');
  $('#loss-huray-radius-field').classList.toggle('d-none', p.roughnessModel !== 'huray');
  $('#loss-huray-ratio-field').classList.toggle('d-none', p.roughnessModel !== 'huray');
}

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
  // Any stored input can affect the exported text even when it does not
  // require another field solve (for example roughness or sweep settings).
  clearModelPreview();
  if (fieldSolveKey && currentSolveKey() !== fieldSolveKey && (!fieldGridStale || fieldClient.busy || fieldIdleHandle !== undefined)) {
    invalidateFieldGrid();
  }
  const solveKey = currentSolveKey();
  if (
    (refinedCpwCurrentSolveKey && refinedCpwCurrentSolveKey !== solveKey) ||
    (refinedCpwCurrentRequestKey && refinedCpwCurrentRequestKey !== solveKey)
  ) {
    invalidateRefinedCpwCurrent();
  }
  renderInputs();
  syncLossControls();
  if (viewMode === 'geom' || viewMode === 'current') renderCS();
  syncUrlHash();
  scheduleAutoSolve();
  updateExportState();
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
syncLossControls();
renderCS();
renderOutputs();
updateExportState();
void doSolve(); // solve the restored/shared config as soon as the page loads
