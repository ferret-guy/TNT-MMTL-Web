/**
 * Guided preset form: geometry + materials + advanced accordion + goal seek.
 * All dimension fields are canonical-mils dimFields with per-field units.
 */
import { CONDUCTORS, COVER_MATERIALS, LAMINATES } from '../model/materials.ts';
import type { PresetKind } from '../model/presets.ts';
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

export function renderPresetForm(container: HTMLElement, hooks: PresetFormHooks) {
  const s = store.get();
  const p = s.presetParams;
  const kind = s.presetKind;
  const variant = s.presetVariant;
  const diff = variant === 'diff';
  const unit = s.displayUnit as DimUnit;

  const dim = (id: string, label: string, mils: number) =>
    dimFieldHtml({ id: `pf-${id}`, label, mils, unit, min: 0.01 });

  const lamOptions = LAMINATES.map(
    (l) =>
      `<option value="${l.name}" ${Math.abs(l.er - p.er) < 1e-9 && Math.abs(l.tanD - p.tanD) < 1e-9 ? 'selected' : ''}>${l.name} (εr ${l.er})</option>`,
  ).join('');
  const firstCondMatch = CONDUCTORS.findIndex((c) => Math.abs(c.sigma - p.sigma) < 1);
  const condOptions = CONDUCTORS.map(
    (c, i) => `<option value="${c.name}" ${i === firstCondMatch ? 'selected' : ''}>${c.name}</option>`,
  ).join('');
  const coverOptions = COVER_MATERIALS.map((c, i) => `<option value="${i}">${c.name} (εr ${c.er})</option>`).join('');
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
      ${dim('w', 'Trace Width', p.w)}
      ${diff ? dim('s', 'Pair Gap (edge to edge)', p.s) : ''}
      <div class="col-6 col-xxl-4">
        <label class="form-label mb-0 small" for="pf-copper-weight">Copper Weight</label>
        <select class="form-select form-select-sm" id="pf-copper-weight">
          ${COPPER_WEIGHTS.map((wt, i) => `<option value="${i}" ${i === wIdx ? 'selected' : ''}>${wt.label}</option>`).join('')}
          <option value="custom" ${wIdx < 0 ? 'selected' : ''}>custom…</option>
        </select>
      </div>
      ${dim('t', 'Trace Thickness', p.t)}
      <div class="col-6 col-xxl-4">
        <label class="form-label mb-0 small" for="pf-etch">Etch Factor (inset per side)</label>
        <div class="input-group input-group-sm">
          <input type="number" step="0.05" min="0" max="1" class="form-control" id="pf-etch" value="${p.etch}">
          <span class="input-group-text">× t</span>
        </div>
      </div>
      ${dim('h', kind === 'stripline' ? 'Dielectric Below Trace (h₁)' : 'Dielectric Height', p.h)}
      ${kind === 'stripline' ? dim('h2', 'Dielectric Above Trace (h₂)', p.h2) : ''}
      ${kind === 'cpw' ? dim('cpwGap', 'Coplanar Gap (trace to ground)', p.cpwGap) : ''}
      ${kind === 'cpw' ? dim('cpwGroundWidth', 'Side Ground Width', p.cpwGroundWidth) : ''}
    </div>
    ${kind === 'cpw' ? `
      <div class="form-check form-check-inline mt-2">
        <input class="form-check-input" type="checkbox" id="pf-cpwbg" ${p.cpwBottomGround ? 'checked' : ''}>
        <label class="form-check-label small" for="pf-cpwbg">Bottom ground plane (grounded coplanar)</label>
      </div>` : ''}

    <div class="row g-2 mt-1">
      <div class="col-6">
        <label class="form-label mb-0 small">Laminate</label>
        <select class="form-select form-select-sm" id="pf-laminate">
          <option value="">— custom —</option>${lamOptions}
        </select>
      </div>
      <div class="col-3">
        <label class="form-label mb-0 small" for="pf-er">Permittivity ε<sub>r</sub></label>
        <input type="number" step="0.01" class="form-control form-control-sm" id="pf-er" value="${p.er}">
      </div>
      <div class="col-3">
        <label class="form-label mb-0 small" for="pf-tand">Loss Tangent</label>
        <input type="number" step="0.001" class="form-control form-control-sm" id="pf-tand" value="${p.tanD}">
      </div>
    </div>

    ${kind !== 'stripline' ? `
    <div class="mt-2">
      <div class="form-check form-check-inline">
        <input class="form-check-input" type="checkbox" id="pf-cover" ${p.cover ? 'checked' : ''}>
        <label class="form-check-label small" for="pf-cover">Cover dielectric (conformal solder mask — constant thickness following the copper)</label>
      </div>
      <div class="row g-2 mt-0 ${p.cover ? '' : 'd-none'}" id="pf-cover-row">
        <div class="col-6">
          <label class="form-label mb-0 small">Mask Material</label>
          <select class="form-select form-select-sm" id="pf-cover-mat">${coverOptions}</select>
        </div>
        ${p.cover ? dim('cover-t', 'Mask Thickness', p.cover.thickness) : ''}
      </div>
    </div>` : ''}

    <div class="accordion accordion-flush mt-3" id="pf-adv">
      <div class="accordion-item">
        <h2 class="accordion-header">
          <button class="accordion-button collapsed py-2" type="button" data-bs-toggle="collapse" data-bs-target="#pf-adv-body">
            Advanced (conductor material, mesh &amp; crosstalk parameters)
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
              <div class="col-6">
                <label class="form-label mb-0 small" for="pf-cplen">Coupling Length (crosstalk)</label>
                <div class="input-group input-group-sm">
                  <input type="number" step="any" class="form-control" id="pf-cplen" value="${p.couplingLengthM * 1000}">
                  <span class="input-group-text">mm</span>
                </div>
              </div>
              <div class="col-6">
                <label class="form-label mb-0 small" for="pf-rise">Rise Time (crosstalk)</label>
                <div class="input-group input-group-sm">
                  <input type="number" step="1" class="form-control" id="pf-rise" value="${p.riseTimePs}">
                  <span class="input-group-text">ps</span>
                </div>
              </div>
            </div>
            <p class="small text-body-secondary mt-2 mb-0">Mesh density: 10 quick, 20 good, 45+ high accuracy
            (slower). Coupling length &amp; rise time only affect the crosstalk figures.</p>
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
              <select class="form-select" id="gs-mode" style="max-width:7rem">
                ${diff
                  ? `<option value="zdiff">Z diff</option><option value="zodd">Z odd</option><option value="zeven">Z even</option>`
                  : `<option value="z0">Z₀</option>`}
              </select>
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
        <div class="tiny text-body-secondary">iteration details appear in the Log tab</div>
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
  const DIM_KEYS: Record<string, (v: number) => void> = {
    'pf-w': (v) => upd({ w: v }),
    'pf-s': (v) => upd({ s: v }),
    'pf-t': (v) => {
      upd({ t: v });
      syncCopperWeight(v);
    },
    'pf-h': (v) => upd({ h: v }),
    'pf-h2': (v) => upd({ h2: v }),
    'pf-cpwGap': (v) => upd({ cpwGap: v }),
    'pf-cpwGroundWidth': (v) => upd({ cpwGroundWidth: v }),
    'pf-cover-t': (v) => {
      const cur = store.get().presetParams.cover;
      if (cur) upd({ cover: { ...cur, thickness: v } });
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
  bindNum('etch', (v) => upd({ etch: Math.min(Math.max(v, 0), 1) }));
  bindNum('er', (v) => upd({ er: v }));
  bindNum('tand', (v) => upd({ tanD: v }));
  bindNum('sigma', (v) => upd({ sigma: v }));
  bindNum('cseg', (v) => upd({ cseg: Math.min(Math.max(Math.round(v), 4), 100) }));
  bindNum('dseg', (v) => upd({ dseg: Math.min(Math.max(Math.round(v), 4), 100) }));
  bindNum('cplen', (v) => upd({ couplingLengthM: v / 1000 }));
  bindNum('rise', (v) => upd({ riseTimePs: v }));

  container.querySelector('#pf-cpwbg')?.addEventListener('change', (e) =>
    upd({ cpwBottomGround: (e.target as HTMLInputElement).checked }),
  );

  (container.querySelector('#pf-laminate') as HTMLSelectElement | null)?.addEventListener('change', (e) => {
    const name = (e.target as HTMLSelectElement).value;
    const lam = LAMINATES.find((l) => l.name === name);
    if (lam) upd({ er: lam.er, tanD: lam.tanD });
  });
  (container.querySelector('#pf-conductor') as HTMLSelectElement | null)?.addEventListener('change', (e) => {
    const c = CONDUCTORS.find((c) => c.name === (e.target as HTMLSelectElement).value);
    if (c) upd({ sigma: c.sigma });
  });

  const coverBox = container.querySelector('#pf-cover') as HTMLInputElement | null;
  coverBox?.addEventListener('change', () => {
    if (coverBox.checked) {
      const mat = COVER_MATERIALS[0];
      upd({ cover: { thickness: 1.0, er: mat.er, tanD: mat.tanD } });
    } else {
      upd({ cover: null });
    }
  });
  (container.querySelector('#pf-cover-mat') as HTMLSelectElement | null)?.addEventListener('change', (e) => {
    const mat = COVER_MATERIALS[parseInt((e.target as HTMLSelectElement).value, 10)];
    const cur = store.get().presetParams.cover;
    if (mat && cur) upd({ cover: { ...cur, er: mat.er, tanD: mat.tanD } });
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
