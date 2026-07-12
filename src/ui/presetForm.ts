/**
 * Guided preset form: geometry + materials + advanced accordion + goal seek.
 */
import { CONDUCTORS, COVER_MATERIALS, LAMINATES } from '../model/materials.ts';
import type { PresetKind } from '../model/presets.ts';
import { store } from '../model/store.ts';
import type { GoalSeekIter } from '../analysis/goalSeek.ts';

const KINDS: Array<{ id: PresetKind; label: string }> = [
  { id: 'microstrip', label: 'Microstrip' },
  { id: 'stripline', label: 'Stripline' },
  { id: 'cpw', label: 'Coplanar' },
];

export interface PresetFormHooks {
  onGoalSeek: (
    mode: 'z0' | 'zdiff' | 'zodd' | 'zeven',
    seekParam: 'w' | 's',
    target: number,
    onIter: (it: GoalSeekIter) => void,
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

  const numField = (id: string, label: string, value: number, step = 'any', suffix: string = s.presetParams.units) => `
    <div class="col-6 col-xxl-4">
      <label class="form-label mb-0 small" for="pf-${id}">${label}</label>
      <div class="input-group input-group-sm">
        <input type="number" step="${step}" class="form-control" id="pf-${id}" value="${value}">
        <span class="input-group-text">${suffix}</span>
      </div>
    </div>`;

  const lamOptions = LAMINATES.map(
    (l) => `<option value="${l.name}" ${Math.abs(l.er - p.er) < 1e-9 && Math.abs(l.tanD - p.tanD) < 1e-9 ? 'selected' : ''}>${l.name} (εr ${l.er})</option>`,
  ).join('');
  // several materials share a conductivity (copper/lead both 5.0e7):
  // mark only the first match selected
  const firstCondMatch = CONDUCTORS.findIndex((c) => Math.abs(c.sigma - p.sigma) < 1);
  const condOptions = CONDUCTORS.map(
    (c, i) => `<option value="${c.name}" ${i === firstCondMatch ? 'selected' : ''}>${c.name}</option>`,
  ).join('');
  const coverOptions = COVER_MATERIALS.map((c, i) => `<option value="${i}">${c.name} (εr ${c.er})</option>`).join('');

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
      <select class="form-select form-select-sm w-auto ms-auto" id="pf-units" title="units">
        ${['mils', 'microns', 'inches', 'meters'].map((u) => `<option ${u === p.units ? 'selected' : ''}>${u}</option>`).join('')}
      </select>
    </div>

    <div class="row g-2">
      ${numField('w', 'Trace width w', p.w)}
      ${diff ? numField('s', 'Gap s (edge–edge)', p.s) : ''}
      ${numField('t', 'Trace thickness t', p.t)}
      ${numField('etch', 'Etch factor', p.etch, '0.05', 'per side')}
      ${numField('h', kind === 'stripline' ? 'Dielectric below h₁' : 'Dielectric height h', p.h)}
      ${kind === 'stripline' ? numField('h2', 'Dielectric above h₂', p.h2) : ''}
      ${kind === 'cpw' ? numField('cpwGap', 'Coplanar gap g', p.cpwGap) : ''}
      ${kind === 'cpw' ? numField('cpwGroundWidth', 'Side ground width', p.cpwGroundWidth) : ''}
    </div>
    ${kind === 'cpw' ? `
      <div class="form-check form-check-inline mt-2">
        <input class="form-check-input" type="checkbox" id="pf-cpwbg" ${p.cpwBottomGround ? 'checked' : ''}>
        <label class="form-check-label small" for="pf-cpwbg">Bottom ground plane (grounded CPW)</label>
      </div>` : ''}

    <div class="row g-2 mt-1">
      <div class="col-6">
        <label class="form-label mb-0 small">Laminate</label>
        <select class="form-select form-select-sm" id="pf-laminate">
          <option value="">— custom —</option>${lamOptions}
        </select>
      </div>
      <div class="col-3">
        <label class="form-label mb-0 small" for="pf-er">εr</label>
        <input type="number" step="0.01" class="form-control form-control-sm" id="pf-er" value="${p.er}">
      </div>
      <div class="col-3">
        <label class="form-label mb-0 small" for="pf-tand">tan δ</label>
        <input type="number" step="0.001" class="form-control form-control-sm" id="pf-tand" value="${p.tanD}">
      </div>
      <div class="col-6">
        <label class="form-label mb-0 small">Conductor</label>
        <select class="form-select form-select-sm" id="pf-conductor">${condOptions}</select>
      </div>
      <div class="col-6">
        <label class="form-label mb-0 small" for="pf-sigma">σ (S/m)</label>
        <input type="number" step="1e6" class="form-control form-control-sm" id="pf-sigma" value="${p.sigma}">
      </div>
    </div>

    ${kind !== 'stripline' ? `
    <div class="mt-2">
      <div class="form-check form-check-inline">
        <input class="form-check-input" type="checkbox" id="pf-cover" ${p.cover ? 'checked' : ''}>
        <label class="form-check-label small" for="pf-cover">Cover dielectric (solder mask)</label>
      </div>
      <div class="row g-2 mt-0 ${p.cover ? '' : 'd-none'}" id="pf-cover-row">
        <div class="col-6">
          <select class="form-select form-select-sm" id="pf-cover-mat">${coverOptions}</select>
        </div>
        ${numField('cover-t', 'Mask thickness', p.cover?.thickness ?? Math.max(p.t * 1.4, 1))}
      </div>
    </div>` : ''}

    <div class="accordion accordion-flush mt-3" id="pf-adv">
      <div class="accordion-item">
        <h2 class="accordion-header">
          <button class="accordion-button collapsed py-2" type="button" data-bs-toggle="collapse" data-bs-target="#pf-adv-body">
            Advanced (mesh &amp; crosstalk line params)
          </button>
        </h2>
        <div id="pf-adv-body" class="accordion-collapse collapse" data-bs-parent="#pf-adv">
          <div class="accordion-body py-2">
            <div class="row g-2">
              ${numField('cseg', 'Conductor segments (CSEG)', p.cseg, '1', 'segs')}
              ${numField('dseg', 'Plane/dielectric segments (DSEG)', p.dseg, '1', 'segs')}
              ${numField('cplen', 'Coupling length', p.couplingLengthM * 1000, 'any', 'mm')}
              ${numField('rise', 'Rise time', p.riseTimePs, '1', 'ps')}
            </div>
            <p class="small text-body-secondary mt-2 mb-0">CSEG/DSEG control BEM mesh density: 10 is quick,
            20 good, 45+ high accuracy (slower). Coupling length &amp; rise time affect only the crosstalk figures.</p>
          </div>
        </div>
      </div>
    </div>

    <div class="card mt-3">
      <div class="card-body py-2">
        <div class="d-flex align-items-end gap-2 flex-wrap">
          <div>
            <label class="form-label mb-0 small">Goal seek</label>
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
            <label class="btn btn-outline-secondary" for="gs-param-w">tune w</label>
            ${diff ? `
            <input type="radio" class="btn-check" name="gs-param" id="gs-param-s">
            <label class="btn btn-outline-secondary" for="gs-param-s">tune s</label>` : ''}
          </div>
          <button class="btn btn-sm btn-success" id="gs-run">Seek</button>
        </div>
        <div id="gs-progress" class="small font-monospace mt-2"></div>
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
  (container.querySelector('#pf-units') as HTMLSelectElement).addEventListener('change', (e) =>
    upd({ units: (e.target as HTMLSelectElement).value as typeof p.units }),
  );

  const bindNum = (id: string, apply: (v: number) => void) => {
    const el = container.querySelector(`#pf-${id}`) as HTMLInputElement | null;
    el?.addEventListener('change', () => apply(num(el.value, 0)));
  };
  bindNum('w', (v) => upd({ w: v }));
  bindNum('s', (v) => upd({ s: v }));
  bindNum('t', (v) => upd({ t: v }));
  bindNum('etch', (v) => upd({ etch: Math.min(Math.max(v, 0), 1) }));
  bindNum('h', (v) => upd({ h: v }));
  bindNum('h2', (v) => upd({ h2: v }));
  bindNum('cpwGap', (v) => upd({ cpwGap: v }));
  bindNum('cpwGroundWidth', (v) => upd({ cpwGroundWidth: v }));
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
      upd({ cover: { thickness: Math.max(p.t * 1.4, 1), er: mat.er, tanD: mat.tanD } });
    } else {
      upd({ cover: null });
    }
  });
  (container.querySelector('#pf-cover-mat') as HTMLSelectElement | null)?.addEventListener('change', (e) => {
    const mat = COVER_MATERIALS[parseInt((e.target as HTMLSelectElement).value, 10)];
    const cur = store.get().presetParams.cover;
    if (mat && cur) upd({ cover: { ...cur, er: mat.er, tanD: mat.tanD } });
  });
  bindNum('cover-t', (v) => {
    const cur = store.get().presetParams.cover;
    if (cur) upd({ cover: { ...cur, thickness: v } });
  });

  /* ---- goal seek ---- */
  const gsBtn = container.querySelector('#gs-run') as HTMLButtonElement;
  const gsProgress = container.querySelector('#gs-progress') as HTMLElement;
  gsBtn.addEventListener('click', async () => {
    const target = num((container.querySelector('#gs-target') as HTMLInputElement).value, diff ? 100 : 50);
    const mode = ((container.querySelector('#gs-mode') as HTMLSelectElement).value || 'z0') as
      | 'z0' | 'zdiff' | 'zodd' | 'zeven';
    const seekParam = (container.querySelector('#gs-param-s') as HTMLInputElement | null)?.checked ? 's' : 'w';
    gsBtn.disabled = true;
    gsProgress.textContent = 'seeking…';
    const lines: string[] = [];
    try {
      const res = await hooks.onGoalSeek(mode, seekParam, target, (it) => {
        lines.push(
          `#${it.i}  ${seekParam} = ${it.x.toPrecision(5)}  →  ${it.z == null ? 'failed' : it.z.toFixed(2) + ' Ω'}  (cseg ${it.cseg})`,
        );
        gsProgress.innerHTML = lines.slice(-6).join('<br>');
      });
      gsProgress.innerHTML = `${lines.slice(-4).join('<br>')}<br><strong class="${res.ok ? 'text-success' : 'text-danger'}">${res.message}</strong>`;
    } catch (e) {
      gsProgress.innerHTML = `<span class="text-danger">${(e as Error).message}</span>`;
    } finally {
      gsBtn.disabled = false;
    }
  });
}
