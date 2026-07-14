/**
 * Guided preset form: geometry + materials + advanced accordion + goal seek.
 * All dimension fields are canonical-mils dimFields with per-field units.
 */
import {
  CONDUCTORS,
  COVER_MATERIALS,
  laminateById,
  LAMINATES,
  materialAtFrequency,
} from '../model/materials.ts';
import { DEFAULT_COVER, etchReductionOf, type PresetKind } from '../model/presets.ts';
import { store } from '../model/store.ts';
import { bindDimFields, dimFieldHtml, formatDim, retargetDimFields, type DimUnit } from './dimField.ts';

const KINDS: Array<{ id: PresetKind; label: string }> = [
  { id: 'microstrip', label: 'Microstrip' },
  { id: 'stripline', label: 'Stripline' },
  { id: 'cpw', label: 'Coplanar' },
];

/** standard copper weights: oz/ft² -> thickness in mils (1 oz = 1.37 mil) */
const COPPER_WEIGHTS: Array<{ label: string; mils: number }> = [
  { label: '¼ oz', mils: 0.35 },
  { label: '½ oz', mils: 0.7 },
  { label: '1 oz', mils: 1.4 },
  { label: '2 oz', mils: 2.8 },
  { label: '3 oz', mils: 4.2 },
];

export interface PresetFormHooks {
  onGoalSeek: (
    mode: 'z0' | 'zdiff' | 'zodd' | 'zeven',
    seekParam: 'w' | 's',
    target: number,
  ) => Promise<{ ok: boolean; x?: number; message: string }>;
}

const num = (v: string, fallback: number): number => {
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : fallback;
};

/** Compact geometry cue shared by each of the four primary geometry fields. */
const primaryFieldIcon = (kind: 'width' | 'height' | 'thickness'): string => {
  const drawing = {
    width: `
      <rect class="field-icon-copper" x="8" y="9" width="28" height="9"/>
      <line class="field-icon-dim" x1="8" y1="5" x2="36" y2="5"/>
      <path class="field-icon-dim" d="M8 2v6M36 2v6"/>`,
    height: `
      <rect class="field-icon-dielectric" x="10" y="4" width="24" height="16"/>
      <line class="field-icon-dim" x1="6" y1="4" x2="6" y2="20"/>
      <path class="field-icon-dim" d="M3 4h6M3 20h6"/>`,
    thickness: `
      <rect class="field-icon-copper" x="8" y="7" width="28" height="10"/>
      <line class="field-icon-dim" x1="40" y1="7" x2="40" y2="17"/>
      <path class="field-icon-dim" d="M37 7h6M37 17h6"/>`,
  }[kind];
  return `<span class="input-group-text py-0 px-1">
    <svg width="36" height="24" viewBox="0 0 44 24" aria-hidden="true" class="field-icon">${drawing}</svg>
  </span>`;
};

/** Static, deliberately exaggerated cue for the dimensional total etch reduction. */
export const etchFactorIcon = (): string => `
  <span class="input-group-text py-0 px-1"
        title="Etch Factor = bottom width minus top width (total reduction, not per side)">
    <svg width="82" height="30" viewBox="0 0 82 30" role="img" class="etch-icon"
         aria-label="Etch Factor is bottom width minus top width: total width reduction, not per side">
      <title>Etch Factor = bottom width minus top width</title>
      <polygon data-etch-role="profile" class="etch-trap" points="4,23 42,23 35,7 11,7"/>
      <path data-etch-role="top-width" class="etch-dim" d="M11 4H35M11 1.5V6M35 1.5V6"/>
      <path data-etch-role="bottom-width" class="etch-dim" d="M4 26H42M4 24V28.5M42 24V28.5"/>
      <text data-etch-role="total-reduction" class="etch-icon-label" x="47" y="12">
        <tspan x="47">\u0394W =</tspan>
        <tspan x="47" dy="9">Wb \u2212 Wt</tspan>
      </text>
    </svg>
  </span>`;

export function renderPresetForm(container: HTMLElement, hooks: PresetFormHooks) {
  const s = store.get();
  const p = s.presetParams;
  const kind = s.presetKind;
  const variant = s.presetVariant;
  const diff = variant === 'diff';
  const unit = s.displayUnit as DimUnit;

  const dim = (id: string, label: string, mils: number, colClass?: string, prefixHtml?: string) =>
    dimFieldHtml({ id: `pf-${id}`, label, mils, unit, min: 0.01, colClass, prefixHtml });

  const materialNumber = (value: number) => String(+value.toPrecision(5));
  const laminateOptions = (selectedId: string | null) => LAMINATES.map((laminate) => {
    const atFrequency = materialAtFrequency(laminate, s.designFreqHz)!;
    return `<option value="${laminate.id}" ${laminate.id === selectedId ? 'selected' : ''}>${laminate.name} (εr ${materialNumber(atFrequency.er)}, tan δ ${materialNumber(atFrequency.tanD)})</option>`;
  }).join('');
  const materialRow = (
    suffix: '' | 'upper' | 'lower',
    materialId: string | null,
    er: number,
    tanD: number,
    compact = false,
  ) => {
    const tail = suffix ? `-${suffix}` : '';
    const selectedLaminate = laminateById(materialId);
    const resolved = materialAtFrequency(selectedLaminate, s.designFreqHz);
    const shownEr = resolved?.er ?? er;
    const shownTanD = resolved?.tanD ?? tanD;
    const noteId = `pf-laminate-note${tail}`;
    const note = selectedLaminate?.note ?? '';
    const locked = selectedLaminate ? ' disabled aria-disabled="true"' : '';
    return `<div class="row g-2 ${compact ? 'mt-1' : 'mt-1'}">
      <div class="${compact ? 'col-12' : 'col-6'}">
        <label class="form-label mb-0 small" for="pf-laminate${tail}">Laminate</label>
        <select class="form-select form-select-sm" id="pf-laminate${tail}" aria-describedby="${noteId}">
          <option value="" ${selectedLaminate ? '' : 'selected'}>— custom —</option>${laminateOptions(selectedLaminate?.id ?? null)}
        </select>
        <div class="form-text mt-1${note ? '' : ' d-none'}" id="${noteId}">${note}</div>
      </div>
      <div class="${compact ? 'col-6' : 'col-3'}">
        <label class="form-label mb-0 small" for="pf-er${tail}">Permittivity ε<sub>r</sub></label>
        <input type="number" min="1" step="0.01" class="form-control form-control-sm" id="pf-er${tail}" value="${materialNumber(shownEr)}"${locked}>
      </div>
      <div class="${compact ? 'col-6' : 'col-3'}">
        <label class="form-label mb-0 small" for="pf-tand${tail}">Loss Tangent</label>
        <input type="number" min="0" step="0.001" class="form-control form-control-sm" id="pf-tand${tail}" value="${materialNumber(shownTanD)}"${locked}>
      </div>
    </div>`;
  };
  const firstCondMatch = CONDUCTORS.findIndex((c) => Math.abs(c.sigma - p.sigma) < 1);
  const condOptions = CONDUCTORS.map(
    (c, i) => `<option value="${c.name}" ${i === firstCondMatch ? 'selected' : ''}>${c.name}</option>`,
  ).join('');
  const coverMatch = p.cover
    ? COVER_MATERIALS.findIndex((c) => Math.abs(c.er - p.cover!.er) < 1e-9 && Math.abs(c.tanD - p.cover!.tanD) < 1e-9)
    : -1;
  const coverOptions = COVER_MATERIALS.map(
    (c, i) => `<option value="${i}" ${i === coverMatch ? 'selected' : ''}>${c.name} (εr ${c.er})</option>`,
  ).join('');
  const wIdx = COPPER_WEIGHTS.findIndex((wt) => Math.abs(wt.mils - p.t) / wt.mils < 0.02);

  container.innerHTML = `
    <div class="d-flex gap-2 flex-wrap mb-3">
      <div class="btn-group btn-group-sm" role="group" aria-label="geometry">
        ${KINDS.map(
          (k) => `
          <input type="radio" class="btn-check" name="pf-kind" id="pf-kind-${k.id}" ${k.id === kind ? 'checked' : ''}>
          <label class="btn btn-outline-primary" for="pf-kind-${k.id}">${k.label}</label>`,
        ).join('')}
      </div>
      <div class="btn-group btn-group-sm" role="group" aria-label="variant">
        <input type="radio" class="btn-check" name="pf-var" id="pf-var-se" ${!diff ? 'checked' : ''}>
        <label class="btn btn-outline-secondary" for="pf-var-se">Single-ended</label>
        <input type="radio" class="btn-check" name="pf-var" id="pf-var-diff" ${diff ? 'checked' : ''}>
        <label class="btn btn-outline-secondary" for="pf-var-diff">Differential</label>
      </div>
      <div class="input-group input-group-sm w-auto ms-auto" title="display units for all fields (each field's unit button also cycles individually; typing 1mm, 35um, 0.1in converts automatically)">
        <span class="input-group-text">Display units</span>
        <select class="form-select" id="pf-units" style="max-width:6rem">
          ${(['mils', 'mm', 'um', 'inch'] as DimUnit[]).map((u) => `<option value="${u}" ${u === unit ? 'selected' : ''}>${u === 'um' ? 'µm' : u === 'inch' ? 'in' : u}</option>`).join('')}
        </select>
      </div>
    </div>

    <div class="row g-2">
      ${dim('w', 'Trace Width', p.w, 'col-6', primaryFieldIcon('width'))}
      ${kind !== 'stripline' ? dim('h', 'Dielectric Height', p.h, 'col-6', primaryFieldIcon('height')) : ''}
      ${dimFieldHtml({
        id: 'pf-t',
        label: 'Copper Weight &amp; Thickness',
        mils: p.t,
        unit,
        min: 0.01,
        colClass: 'col-6',
        prefixHtml: `${primaryFieldIcon('thickness')}<select class="form-select copper-weight-select" id="pf-copper-weight"
            title="standard copper weight — picking one sets the thickness; typing a custom thickness back-selects the matching weight">
            ${COPPER_WEIGHTS.map((wt, i) => `<option value="${i}" ${i === wIdx ? 'selected' : ''}>${wt.label}</option>`).join('')}
            <option value="custom" ${wIdx < 0 ? 'selected' : ''}>custom…</option>
          </select>`,
      })}
      ${dimFieldHtml({
        id: 'pf-etch',
        label: 'Etch Factor',
        mils: p.etch,
        unit,
        min: 0,
        colClass: 'col-6',
        prefixHtml: etchFactorIcon(),
      })}
      ${diff ? dim('s', 'Pair Gap (edge to edge)', p.s) : ''}
      ${kind === 'cpw' ? dim('cpwGap', 'Coplanar Gap (trace to ground)', p.cpwGap) : ''}
      ${kind === 'cpw' ? dim('cpwGroundWidth', 'Side Ground Width', p.cpwGroundWidth) : ''}
    </div>
    ${kind === 'cpw' ? `
      <div class="form-check form-check-inline mt-2">
        <input class="form-check-input" type="checkbox" id="pf-cpwbg" ${p.cpwBottomGround ? 'checked' : ''}>
        <label class="form-check-label small" for="pf-cpwbg">Bottom ground plane (grounded coplanar)</label>
      </div>` : ''}

    ${kind === 'stripline' ? `
      <div class="form-check mt-2">
        <input class="form-check-input" type="checkbox" id="pf-stripline-split-materials" ${p.striplineSeparateMaterials ? 'checked' : ''}>
        <label class="form-check-label small" for="pf-stripline-split-materials">Different upper and lower laminates</label>
      </div>
      ${p.striplineSeparateMaterials ? `
        <section class="card mt-2" id="pf-stripline-upper">
          <div class="card-body p-2">
            <div class="fw-semibold small">Upper dielectric</div>
            <div class="row g-2">${dim('h2', 'Thickness above trace (h₂)', p.h2, 'col-12')}</div>
            ${materialRow('upper', p.laminateId2, p.er2, p.tanD2, true)}
          </div>
        </section>
        <section class="card mt-2" id="pf-stripline-lower">
          <div class="card-body p-2">
            <div class="fw-semibold small">Lower dielectric</div>
            <div class="row g-2">${dim('h', 'Thickness below trace (h₁)', p.h, 'col-12')}</div>
            ${materialRow('lower', p.laminateId, p.er, p.tanD, true)}
          </div>
        </section>` : `
        <div class="row g-2 mt-1">
          ${dim('h2', 'Dielectric Above Trace (h₂)', p.h2, 'col-6')}
          ${dim('h', 'Dielectric Below Trace (h₁)', p.h, 'col-6', primaryFieldIcon('height'))}
        </div>
        ${materialRow('', p.laminateId, p.er, p.tanD)}
      `}
    ` : materialRow('', p.laminateId, p.er, p.tanD)}

    ${kind !== 'stripline' ? `
    <div class="mt-2">
      <div class="form-check form-check-inline">
        <input class="form-check-input" type="checkbox" id="pf-cover" ${p.cover ? 'checked' : ''}>
        <label class="form-check-label small" for="pf-cover">Soldermask</label>
      </div>
      <div class="row g-2 mt-0 ${p.cover ? '' : 'd-none'}" id="pf-cover-row">
        <div class="col-6">
          <label class="form-label mb-0 small">Mask Material</label>
          <div class="input-group input-group-sm">
            <span class="input-group-text py-0 px-1">
              <svg width="36" height="24" viewBox="0 0 44 24" aria-hidden="true" class="field-icon">
                <rect class="field-icon-dielectric" x="4" y="18" width="36" height="4"/>
                <rect class="field-icon-copper" x="16" y="11" width="12" height="7"/>
                <path class="field-icon-mask" d="M4 16H14V8H30V16H40"/>
              </svg>
            </span>
            <select class="form-select" id="pf-cover-mat">
              <option value="custom" ${coverMatch < 0 ? 'selected' : ''}>— custom —</option>${coverOptions}
            </select>
          </div>
        </div>
        ${p.cover ? `
        <div class="col-6">
          <label class="form-label mb-0 small" for="pf-cover-er">Soldermask ε<sub>r</sub></label>
          <input type="number" step="0.01" min="1" class="form-control form-control-sm" id="pf-cover-er" value="${p.cover.er}">
        </div>` : ''}
        ${p.cover ? dim('cover-cu', 'Mask Over Copper', p.cover.tCopper, 'col-6') : ''}
        ${p.cover ? dim('cover-base', 'Base Mask (on laminate)', p.cover.tBase, 'col-6') : ''}
      </div>
    </div>` : ''}

    <div class="accordion accordion-flush mt-3" id="pf-adv">
      <div class="accordion-item">
        <h2 class="accordion-header">
          <button class="accordion-button collapsed py-2" type="button" data-bs-toggle="collapse" data-bs-target="#pf-adv-body">
            Advanced (conductor material &amp; mesh)
          </button>
        </h2>
        <div id="pf-adv-body" class="accordion-collapse collapse" data-bs-parent="#pf-adv">
          <div class="accordion-body py-2">
            <div class="row g-2">
              <div class="col-6">
                <label class="form-label mb-0 small">Conductor Material</label>
                <select class="form-select form-select-sm" id="pf-conductor">${condOptions}</select>
              </div>
              <div class="col-6">
                <label class="form-label mb-0 small" for="pf-sigma">Conductivity σ (S/m)</label>
                <input type="number" step="1e6" class="form-control form-control-sm" id="pf-sigma" value="${p.sigma}">
              </div>
              <div class="col-6">
                <label class="form-label mb-0 small" for="pf-cseg">Conductor Mesh Segments (CSEG)</label>
                <input type="number" step="1" min="4" max="100" class="form-control form-control-sm" id="pf-cseg" value="${p.cseg}">
              </div>
              <div class="col-6">
                <label class="form-label mb-0 small" for="pf-dseg">Plane/Dielectric Mesh Segments (DSEG)</label>
                <input type="number" step="1" min="4" max="100" class="form-control form-control-sm" id="pf-dseg" value="${p.dseg}">
              </div>
            </div>
            <p class="small text-body-secondary mt-2 mb-0">Mesh density: 10 quick, 20 good, 45+ high accuracy
            (slower).</p>
          </div>
        </div>
      </div>
    </div>

    <div class="card mt-3">
      <div class="card-body py-2">
        <div class="d-flex align-items-end gap-2 flex-wrap">
          <div>
            <label class="form-label mb-0 small">Goal seek — auto-tune to a target impedance</label>
            <div class="input-group input-group-sm">
              <span class="input-group-text">target</span>
              <input type="number" class="form-control" id="gs-target" value="${diff ? 100 : 50}" style="max-width:5.5rem">
              <span class="input-group-text">Ω</span>
              ${diff
                ? `<select class="form-select" id="gs-mode" style="max-width:7rem">
                    <option value="zdiff">Z diff</option><option value="zodd">Z odd</option><option value="zeven">Z even</option>
                  </select>`
                : `<input type="hidden" id="gs-mode" value="z0"><span class="input-group-text">Z₀</span>`}
            </div>
          </div>
          <div class="btn-group btn-group-sm" role="group">
            <input type="radio" class="btn-check" name="gs-param" id="gs-param-w" checked>
            <label class="btn btn-outline-secondary" for="gs-param-w">tune width</label>
            ${diff ? `
            <input type="radio" class="btn-check" name="gs-param" id="gs-param-s">
            <label class="btn btn-outline-secondary" for="gs-param-s">tune gap</label>` : ''}
          </div>
          <button class="btn btn-sm btn-success" id="gs-run">
            <span class="spinner-border spinner-border-sm d-none" id="gs-spinner"></span> Seek
          </button>
        </div>
        <div id="gs-result" class="small mt-2"></div>
      </div>
    </div>
  `;

  /* ---- bindings ---- */
  const upd = (patch: Partial<typeof p>) =>
    store.update({ presetParams: { ...store.get().presetParams, ...patch } });

  for (const k of KINDS) {
    container.querySelector(`#pf-kind-${k.id}`)!.addEventListener('change', () => {
      store.update({ presetKind: k.id });
    });
  }
  container.querySelector('#pf-var-se')!.addEventListener('change', () => store.update({ presetVariant: 'se' }));
  container.querySelector('#pf-var-diff')!.addEventListener('change', () => store.update({ presetVariant: 'diff' }));

  (container.querySelector('#pf-units') as HTMLSelectElement).addEventListener('change', (e) => {
    const u = (e.target as HTMLSelectElement).value as DimUnit;
    store.update({ displayUnit: u });
    retargetDimFields(container, u);
  });

  /* dimension fields (canonical mils) */
  const syncEtchField = (mils: number) => {
    const input = container.querySelector('#pf-etch') as HTMLInputElement | null;
    if (!input) return;
    const inputUnit = input.dataset.unit as DimUnit;
    input.dataset.mils = String(mils);
    input.value = formatDim(mils, inputUnit);
  };
  const DIM_KEYS: Record<string, (v: number) => void> = {
    'pf-w': (v) => {
      const etch = etchReductionOf(v, store.get().presetParams.etch);
      upd({ w: v, etch });
      syncEtchField(etch);
    },
    'pf-s': (v) => upd({ s: v }),
    'pf-t': (v) => {
      upd({ t: v });
      syncCopperWeight(v);
    },
    'pf-h': (v) => upd({ h: v }),
    'pf-h2': (v) => upd({ h2: v }),
    'pf-etch': (v) => {
      const etch = etchReductionOf(store.get().presetParams.w, v);
      upd({ etch });
      syncEtchField(etch);
    },
    'pf-cpwGap': (v) => upd({ cpwGap: v }),
    'pf-cpwGroundWidth': (v) => upd({ cpwGroundWidth: v }),
    'pf-cover-cu': (v) => {
      const cur = store.get().presetParams.cover;
      if (cur) upd({ cover: { ...cur, tCopper: v } });
    },
    'pf-cover-base': (v) => {
      const cur = store.get().presetParams.cover;
      // The exposed-laminate and between-trace mask now share one control.
      if (cur) upd({ cover: { ...cur, tBase: v, tBetween: v } });
    },
  };
  bindDimFields(container, {
    onChange: (id, mils) => DIM_KEYS[id]?.(mils),
  });

  /* copper weight <-> thickness */
  const weightSel = container.querySelector('#pf-copper-weight') as HTMLSelectElement;
  const syncCopperWeight = (tMils: number) => {
    const i = COPPER_WEIGHTS.findIndex((wt) => Math.abs(wt.mils - tMils) / wt.mils < 0.02);
    weightSel.value = i >= 0 ? String(i) : 'custom';
  };
  weightSel.addEventListener('change', () => {
    if (weightSel.value === 'custom') return;
    const wt = COPPER_WEIGHTS[parseInt(weightSel.value, 10)];
    upd({ t: wt.mils });
    const tField = container.querySelector('#pf-t') as HTMLInputElement | null;
    if (tField) {
      tField.dataset.mils = String(wt.mils);
      tField.value = formatDim(wt.mils, tField.dataset.unit as DimUnit);
    }
  });

  const bindNum = (id: string, apply: (v: number) => void) => {
    const el = container.querySelector(`#pf-${id}`) as HTMLInputElement | null;
    el?.addEventListener('change', () => apply(num(el.value, 0)));
  };
  const updateSharedEr = (v: number) => {
    const er = Math.max(v, 1);
    upd(kind === 'stripline'
      ? { laminateId: null, laminateId2: null, er, er2: er }
      : { laminateId: null, er });
  };
  const updateSharedTanD = (v: number) => {
    const tanD = Math.max(v, 0);
    upd(kind === 'stripline'
      ? { laminateId: null, laminateId2: null, tanD, tanD2: tanD }
      : { laminateId: null, tanD });
  };
  const updateLowerEr = (v: number) => {
    const er = Math.max(v, 1);
    upd({ laminateId: null, er });
  };
  const updateLowerTanD = (v: number) => {
    const tanD = Math.max(v, 0);
    upd({ laminateId: null, tanD });
  };
  const updateUpperEr = (v: number) => {
    const er2 = Math.max(v, 1);
    upd({ laminateId2: null, er2 });
  };
  const updateUpperTanD = (v: number) => {
    const tanD2 = Math.max(v, 0);
    upd({ laminateId2: null, tanD2 });
  };
  bindNum('er', updateSharedEr);
  bindNum('tand', updateSharedTanD);
  bindNum('er-lower', updateLowerEr);
  bindNum('tand-lower', updateLowerTanD);
  bindNum('er-upper', updateUpperEr);
  bindNum('tand-upper', updateUpperTanD);
  const updateCoverEr = (v: number) => {
    const cur = store.get().presetParams.cover;
    if (!cur) return;
    upd({ cover: { ...cur, er: Math.max(v, 1) } });
    const material = container.querySelector('#pf-cover-mat') as HTMLSelectElement | null;
    const i = COVER_MATERIALS.findIndex(
      (c) => Math.abs(c.er - v) < 1e-9 && Math.abs(c.tanD - cur.tanD) < 1e-9,
    );
    if (material) material.value = i >= 0 ? String(i) : 'custom';
  };
  bindNum('cover-er', updateCoverEr);
  // Permittivity updates live while typing; auto-solve's debounce still
  // coalesces the keystrokes into one field solve.
  const coverErInput = container.querySelector('#pf-cover-er') as HTMLInputElement | null;
  coverErInput?.addEventListener('input', () => {
    const v = parseFloat(coverErInput.value);
    if (Number.isFinite(v) && v >= 1) updateCoverEr(v);
  });
  bindNum('sigma', (v) => upd({ sigma: v }));
  bindNum('cseg', (v) => upd({ cseg: Math.min(Math.max(Math.round(v), 4), 100) }));
  bindNum('dseg', (v) => upd({ dseg: Math.min(Math.max(Math.round(v), 4), 100) }));

  container.querySelector('#pf-cpwbg')?.addEventListener('change', (e) =>
    upd({ cpwBottomGround: (e.target as HTMLInputElement).checked }),
  );

  const bindLaminate = (
    suffix: '' | 'upper' | 'lower',
    apply: (materialId: string | null, er: number, tanD: number) => void,
  ) => {
    const tail = suffix ? `-${suffix}` : '';
    (container.querySelector(`#pf-laminate${tail}`) as HTMLSelectElement | null)?.addEventListener('change', (e) => {
      const selectedId = (e.target as HTMLSelectElement).value;
      const selected = materialAtFrequency(selectedId, s.designFreqHz);
      if (selected) {
        apply(selected.laminate.id, selected.er, selected.tanD);
        return;
      }

      // Switching to Custom preserves the currently displayed lookup values
      // as the editable starting point.
      const cur = store.get().presetParams;
      const priorId = suffix === 'upper' ? cur.laminateId2 : cur.laminateId;
      const prior = materialAtFrequency(priorId, s.designFreqHz);
      const fallbackEr = suffix === 'upper' ? cur.er2 : cur.er;
      const fallbackTanD = suffix === 'upper' ? cur.tanD2 : cur.tanD;
      apply(null, prior?.er ?? fallbackEr, prior?.tanD ?? fallbackTanD);
    });
  };
  bindLaminate('', (laminateId, er, tanD) => upd(kind === 'stripline'
    ? { laminateId, laminateId2: laminateId, er, tanD, er2: er, tanD2: tanD }
    : { laminateId, er, tanD }));
  bindLaminate('lower', (laminateId, er, tanD) => upd({ laminateId, er, tanD }));
  bindLaminate('upper', (laminateId2, er2, tanD2) => upd({ laminateId2, er2, tanD2 }));

  const splitMaterials = container.querySelector('#pf-stripline-split-materials') as HTMLInputElement | null;
  splitMaterials?.addEventListener('change', () => {
    const cur = store.get().presetParams;
    upd({
      striplineSeparateMaterials: splitMaterials.checked,
      laminateId2: cur.laminateId,
      er2: cur.er,
      tanD2: cur.tanD,
    });
  });
  (container.querySelector('#pf-conductor') as HTMLSelectElement | null)?.addEventListener('change', (e) => {
    const c = CONDUCTORS.find((c) => c.name === (e.target as HTMLSelectElement).value);
    if (c) upd({ sigma: c.sigma });
  });

  const coverBox = container.querySelector('#pf-cover') as HTMLInputElement | null;
  coverBox?.addEventListener('change', () => {
    if (coverBox.checked) {
      const mat = COVER_MATERIALS[0];
      upd({ cover: { ...DEFAULT_COVER, er: mat.er, tanD: mat.tanD } });
    } else {
      upd({ cover: null });
    }
  });
  (container.querySelector('#pf-cover-mat') as HTMLSelectElement | null)?.addEventListener('change', (e) => {
    const mat = COVER_MATERIALS[parseInt((e.target as HTMLSelectElement).value, 10)];
    const cur = store.get().presetParams.cover;
    if (mat && cur) {
      upd({ cover: { ...cur, er: mat.er, tanD: mat.tanD } });
      const er = container.querySelector('#pf-cover-er') as HTMLInputElement | null;
      if (er) er.value = String(mat.er);
    }
  });

  /* ---- goal seek (quiet: result only; details go to the Log tab) ---- */
  const gsBtn = container.querySelector('#gs-run') as HTMLButtonElement;
  const gsSpinner = container.querySelector('#gs-spinner') as HTMLElement;
  const gsResult = container.querySelector('#gs-result') as HTMLElement;
  gsBtn.addEventListener('click', async () => {
    const target = num((container.querySelector('#gs-target') as HTMLInputElement).value, diff ? 100 : 50);
    const mode = ((container.querySelector('#gs-mode') as HTMLSelectElement).value || 'z0') as
      | 'z0' | 'zdiff' | 'zodd' | 'zeven';
    const seekParam = (container.querySelector('#gs-param-s') as HTMLInputElement | null)?.checked ? 's' : 'w';
    gsBtn.disabled = true;
    gsSpinner.classList.remove('d-none');
    gsResult.textContent = '';
    try {
      const res = await hooks.onGoalSeek(mode, seekParam, target);
      gsResult.innerHTML = `<strong class="${res.ok ? 'text-success' : 'text-danger'}">${res.message}</strong>`;
    } catch (e) {
      gsResult.innerHTML = `<span class="text-danger">${(e as Error).message}</span>`;
    } finally {
      gsBtn.disabled = false;
      gsSpinner.classList.add('d-none');
    }
  });
}
