/**
 * Minimal observable app state + localStorage persistence.
 */
import type { LossParams, SolveOutput, Stackup } from './types.ts';
import {
  buildPreset,
  DEFAULT_COVER,
  defaultParams,
  etchReductionOf,
  normalizeCover,
  type PresetKind,
  type PresetParams,
  type PresetVariant,
} from './presets.ts';
import { laminateById } from './materials.ts';

export type InputMode = 'preset' | 'freeform';
export type DisplayUnit = 'mils' | 'mm' | 'um' | 'inch';

export interface AppState {
  mode: InputMode;
  presetKind: PresetKind;
  presetVariant: PresetVariant;
  presetParams: PresetParams;
  /** free-form stackup (independent of presets) */
  freeform: Stackup;
  lossParams: LossParams;
  /** default display unit for dimension fields (model is canonical mils) */
  displayUnit: DisplayUnit;
  /** line length [m] + design frequency [Hz] for the loss/line stats panel */
  lineLengthM: number;
  /** edge rise time [ps] used by the solver's crosstalk calculation */
  riseTimePs: number;
  designFreqHz: number;
  lastSolve: SolveOutput | null;
  solving: boolean;
}

const LS_KEY = 'tnt-web-state-v3';
const CFG_VERSION = 3;

/**
 * Add the loss property introduced for finite dielectric shapes without
 * breaking saved states and shared links created before it existed.
 */
export function normalizeFreeformDielectricLosses(stackup: Stackup): Stackup {
  const items = Array.isArray(stackup.items) ? stackup.items : [];
  return {
    ...stackup,
    items: items.map((item) => {
      if (
        item.kind !== 'DielectricLayer' &&
        item.kind !== 'RectangleDielectric' &&
        item.kind !== 'TrapezoidDielectric' &&
        item.kind !== 'CircleDielectric'
      ) {
        return item;
      }
      const stored = (item as typeof item & { lossTangent?: unknown }).lossTangent;
      return {
        ...item,
        lossTangent:
          typeof stored === 'number' && Number.isFinite(stored) ? stored : 0,
      };
    }),
  };
}

/** the shareable/persistable subset of the state */
function persistable(s: AppState) {
  const { lastSolve: _ls, solving: _sv, ...keep } = s;
  return { v: CFG_VERSION, ...keep };
}

/* ---------------- readable URL config ----------------
 *
 * Preset configs serialize as flat, human-scannable hash params, and only
 * values that differ from the preset defaults are included, e.g.
 *     #v=3&kind=stripline&var=diff&w=6.5&er=4.2
 * All dimensions are in mils. The free-form stackup doesn't flatten, so
 * freeform mode carries it as URI-encoded JSON in `stack=`.
 */

/** [urlKey, presetParams field, unit note] — plain numeric params */
const NUM_PARAMS: Array<[string, keyof PresetParams]> = [
  ['w', 'w'],
  ['s', 's'],
  ['t', 't'],
  ['h', 'h'],
  ['h2', 'h2'],
  ['er', 'er'],
  ['tand', 'tanD'],
  ['er2', 'er2'],
  ['tand2', 'tanD2'],
  ['sigma', 'sigma'],
  ['cpw_gap', 'cpwGap'],
  ['cpw_gnd_w', 'cpwGroundWidth'],
  ['cseg', 'cseg'],
  ['dseg', 'dseg'],
];

export function encodeConfig(s: AppState): string {
  const q = new URLSearchParams();
  q.set('v', String(CFG_VERSION));
  if (s.mode === 'freeform') {
    q.set('mode', 'freeform');
    // Length and rise time are app-level settings.  Keep them out of the
    // embedded stack so a share link can never contain two conflicting
    // values for the same physical input.
    const { couplingLengthM: _length, riseTimePs: _rise, ...stack } = s.freeform;
    q.set('stack', JSON.stringify(stack));
  } else {
    q.set('kind', s.presetKind);
    q.set('var', s.presetVariant);
    const defs = defaultParams(s.presetKind, s.presetVariant);
    const p = s.presetParams;
    if (p.laminateId && laminateById(p.laminateId)) q.set('mat', p.laminateId);
    if (s.presetKind === 'stripline' && p.striplineSeparateMaterials &&
        p.laminateId2 && laminateById(p.laminateId2)) q.set('mat2', p.laminateId2);
    for (const [key, field] of NUM_PARAMS) {
      if ((field === 'er2' || field === 'tanD2') &&
          (s.presetKind !== 'stripline' || !p.striplineSeparateMaterials)) continue;
      if ((field === 'er' || field === 'tanD') && p.laminateId) continue;
      if ((field === 'er2' || field === 'tanD2') && p.laminateId2) continue;
      const v = p[field] as number;
      if (Number.isFinite(v) && v !== (defs[field] as number)) q.set(key, String(+v.toPrecision(6)));
    }
    const etch = etchReductionOf(p.w, p.etch);
    if (Number.isFinite(etch) && etch !== defs.etch)
      q.set('etch_delta', String(+etch.toPrecision(6)));
    if (p.cpwBottomGround !== defs.cpwBottomGround) q.set('cpw_bottom_gnd', p.cpwBottomGround ? '1' : '0');
    if (s.presetKind === 'stripline' && p.striplineSeparateMaterials) q.set('split_lam', '1');
    if (!p.referencePlaneSameWeight) {
      q.set('ref_same_wt', '0');
      q.set('ref_t', String(+p.referencePlaneThickness.toPrecision(6)));
    }
    const dCover = defs.cover;
    if (!!p.cover !== !!dCover) q.set('mask', p.cover ? '1' : '0');
    if (p.cover) {
      if (p.cover.tCopper !== (dCover?.tCopper ?? -1)) q.set('mask_cu', String(+p.cover.tCopper.toPrecision(6)));
      if (p.cover.tBase !== (dCover?.tBase ?? -1)) q.set('mask_base', String(+p.cover.tBase.toPrecision(6)));
      if (p.cover.tBetween !== (dCover?.tBetween ?? -1)) q.set('mask_gap', String(+p.cover.tBetween.toPrecision(6)));
      if (p.cover.er !== (dCover?.er ?? -1)) q.set('mask_er', String(p.cover.er));
      if (p.cover.tanD !== (dCover?.tanD ?? -1)) q.set('mask_tand', String(p.cover.tanD));
    }
  }
  const d = defaultState();
  if (s.displayUnit !== d.displayUnit) q.set('units', s.displayUnit);
  if (s.lineLengthM !== d.lineLengthM) q.set('len_mm', String(+(s.lineLengthM * 1000).toPrecision(6)));
  if (s.riseTimePs !== d.riseTimePs) q.set('rise_ps', String(+s.riseTimePs.toPrecision(6)));
  if (s.designFreqHz !== d.designFreqHz) q.set('f_hz', String(s.designFreqHz));
  if (s.lossParams.roughnessModel !== d.lossParams.roughnessModel) q.set('rough', s.lossParams.roughnessModel);
  if (s.lossParams.roughnessRqUm !== d.lossParams.roughnessRqUm) q.set('rq_um', String(s.lossParams.roughnessRqUm));
  if (s.lossParams.hurayRadiusUm !== d.lossParams.hurayRadiusUm) q.set('huray_r_um', String(s.lossParams.hurayRadiusUm));
  if (s.lossParams.hurayRatio !== d.lossParams.hurayRatio) q.set('huray_sr', String(s.lossParams.hurayRatio));
  if (s.lossParams.includeReferencePlaneLoss !== d.lossParams.includeReferencePlaneLoss) {
    q.set('ref_loss', s.lossParams.includeReferencePlaneLoss ? '1' : '0');
  }
  return q.toString();
}

/** Parse the current readable URL format. */
export function decodeHash(hash: string): Partial<AppState> | null {
  const raw = hash.replace(/^#/, '');
  if (!raw) return null;
  const q = new URLSearchParams(raw);
  if (q.get('v') !== String(CFG_VERSION) || ['etch', 'mask_t', 'couple_mm'].some((key) => q.has(key))) return null;
  if (!q.has('kind') && !q.has('mode')) return null;

  const out: Partial<AppState> = {};
  const num = (key: string): number | null => {
    const v = parseFloat(q.get(key) ?? '');
    return Number.isFinite(v) ? v : null;
  };

  if (q.get('mode') === 'freeform') {
    out.mode = 'freeform';
    try {
      const stack = JSON.parse(q.get('stack') ?? '');
      if (stack && Array.isArray(stack.items)) {
        out.freeform = normalizeFreeformDielectricLosses(stack as Stackup);
      }
    } catch {
      /* bad stack JSON: ignore */
    }
  } else {
    out.mode = 'preset';
    const kind = q.get('kind') as PresetKind | null;
    const variant = (q.get('var') === 'diff' ? 'diff' : 'se') as PresetVariant;
    if (kind && ['microstrip', 'stripline', 'cpw'].includes(kind)) {
      out.presetKind = kind;
      out.presetVariant = variant;
      const p = defaultParams(kind, variant);
      p.laminateId = laminateById(q.get('mat'))?.id ?? null;
      p.laminateId2 = laminateById(q.get('mat2'))?.id ?? null;
      for (const [key, field] of NUM_PARAMS) {
        const v = num(key);
        if (v !== null) (p[field] as number) = v;
      }
      p.striplineSeparateMaterials = kind === 'stripline' && q.get('split_lam') === '1';
      if (p.striplineSeparateMaterials) {
        if (!q.has('er2')) p.er2 = p.er;
        if (!q.has('tand2')) p.tanD2 = p.tanD;
        if (!q.has('mat2') && !q.has('er2') && !q.has('tand2')) p.laminateId2 = p.laminateId;
      }
      const etchDelta = num('etch_delta');
      if (etchDelta !== null) p.etch = Math.max(0, etchDelta);
      p.etch = etchReductionOf(p.w, p.etch);
      const referenceThickness = num('ref_t');
      p.referencePlaneSameWeight =
        q.get('ref_same_wt') !== '0' && referenceThickness === null;
      p.referencePlaneThickness = p.referencePlaneSameWeight
        ? p.t
        : referenceThickness !== null && referenceThickness > 0
          ? referenceThickness
          : p.t;
      if (q.has('cpw_bottom_gnd')) p.cpwBottomGround = q.get('cpw_bottom_gnd') !== '0';
      if (q.get('mask') === '0') p.cover = null;
      else if (q.get('mask') === '1' && !p.cover) p.cover = { ...DEFAULT_COVER };
      if (p.cover) {
        const mcu = num('mask_cu');
        if (mcu !== null) p.cover.tCopper = mcu;
        const mbase = num('mask_base');
        if (mbase !== null) p.cover.tBase = mbase;
        const mgap = num('mask_gap');
        if (mgap !== null) p.cover.tBetween = mgap;
        const mer = num('mask_er');
        if (mer !== null) p.cover.er = mer;
        const mtd = num('mask_tand');
        if (mtd !== null) p.cover.tanD = mtd;
      }
      out.presetParams = p;
    }
  }

  const units = q.get('units');
  if (units && ['mils', 'mm', 'um', 'inch'].includes(units)) out.displayUnit = units as DisplayUnit;
  const len = num('len_mm');
  if (len !== null) out.lineLengthM = len / 1000;
  const rise = num('rise_ps');
  if (rise !== null) out.riseTimePs = rise;
  const f = num('f_hz');
  if (f !== null) out.designFreqHz = f;
  const rough = q.get('rough');
  const rq = num('rq_um');
  const hurayRadius = num('huray_r_um');
  const hurayRatio = num('huray_sr');
  const referenceLoss = q.get('ref_loss');
  if (
    rough ||
    rq !== null ||
    hurayRadius !== null ||
    hurayRatio !== null ||
    referenceLoss !== null
  ) {
    const d = defaultState();
    out.lossParams = {
      ...d.lossParams,
      ...(rough && ['none', 'hammerstad', 'huray'].includes(rough)
        ? { roughnessModel: rough as LossParams['roughnessModel'] }
        : {}),
      ...(rq !== null ? { roughnessRqUm: Math.max(0, rq) } : {}),
      // Compatibility with links created by the earlier shared-Rq Huray UI:
      // its implementation interpreted the Rq value as a nodule diameter.
      ...(hurayRadius !== null
        ? { hurayRadiusUm: Math.max(0, hurayRadius) }
        : rough === 'huray' && rq !== null
          ? { hurayRadiusUm: Math.max(0, rq / 2) }
          : {}),
      ...(hurayRatio !== null ? { hurayRatio: Math.max(0, hurayRatio) } : {}),
      ...(referenceLoss !== null
        ? { includeReferencePlaneLoss: referenceLoss !== '0' }
        : {}),
    };
  }
  return out;
}

/** Merge a current saved/shared partial state over defaults. */
function mergeOverDefaults(saved: Partial<AppState>): AppState {
  const d = defaultState();
  const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const lineLengthM = positive(saved.lineLengthM) ? saved.lineLengthM : d.lineLengthM;
  const riseTimePs = positive(saved.riseTimePs) ? saved.riseTimePs : d.riseTimePs;
  const savedPreset = saved.presetParams as (Partial<PresetParams> | undefined);
  const hasSavedMaterial = !!savedPreset && Object.prototype.hasOwnProperty.call(savedPreset, 'laminateId');
  const hasSavedMaterial2 = !!savedPreset && Object.prototype.hasOwnProperty.call(savedPreset, 'laminateId2');
  const presetParams = {
    ...d.presetParams,
    ...(savedPreset ?? {}),
    laminateId: hasSavedMaterial && laminateById(savedPreset?.laminateId)?.id
      ? laminateById(savedPreset?.laminateId)?.id ?? null
      : null,
    laminateId2: hasSavedMaterial2 && laminateById(savedPreset?.laminateId2)?.id
      ? laminateById(savedPreset?.laminateId2)?.id ?? null
      : null,
    couplingLengthM: lineLengthM,
    riseTimePs,
  };
  presetParams.referencePlaneSameWeight =
    savedPreset?.referencePlaneSameWeight !== false;
  presetParams.referencePlaneThickness = presetParams.referencePlaneSameWeight
    ? presetParams.t
    : positive(savedPreset?.referencePlaneThickness)
      ? savedPreset.referencePlaneThickness
      : presetParams.t;
  presetParams.etch = etchReductionOf(presetParams.w, presetParams.etch);
  presetParams.cover = presetParams.cover ? normalizeCover(presetParams.cover) : null;
  const freeform = normalizeFreeformDielectricLosses({
    ...d.freeform,
    ...(saved.freeform ?? {}),
    couplingLengthM: lineLengthM,
    riseTimePs,
  });
  const rawLoss = { ...d.lossParams, ...(saved.lossParams ?? {}) };
  const nonnegative = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
  const fMinHz = positive(rawLoss.fMinHz) ? rawLoss.fMinHz : d.lossParams.fMinHz;
  const fMaxHz = positive(rawLoss.fMaxHz) && rawLoss.fMaxHz >= fMinHz
    ? rawLoss.fMaxHz
    : Math.max(fMinHz, d.lossParams.fMaxHz);
  const lossParams: LossParams = {
    includeReferencePlaneLoss:
      typeof rawLoss.includeReferencePlaneLoss === 'boolean'
        ? rawLoss.includeReferencePlaneLoss
        : d.lossParams.includeReferencePlaneLoss,
    roughnessModel: ['none', 'hammerstad', 'huray'].includes(rawLoss.roughnessModel)
      ? rawLoss.roughnessModel
      : d.lossParams.roughnessModel,
    roughnessRqUm: nonnegative(rawLoss.roughnessRqUm, d.lossParams.roughnessRqUm),
    hurayRadiusUm: nonnegative(rawLoss.hurayRadiusUm, d.lossParams.hurayRadiusUm),
    hurayRatio: nonnegative(rawLoss.hurayRatio, d.lossParams.hurayRatio),
    fMinHz,
    fMaxHz,
    nPoints: typeof rawLoss.nPoints === 'number' && Number.isFinite(rawLoss.nPoints)
      ? Math.max(2, Math.round(rawLoss.nPoints))
      : d.lossParams.nPoints,
  };
  return {
    ...d,
    ...saved,
    presetParams,
    lossParams,
    freeform,
    lineLengthM,
    riseTimePs,
    lastSolve: null,
    solving: false,
  };
}

export function currentStackup(s: AppState): Stackup {
  const stackup = s.mode === 'preset'
    ? buildPreset(s.presetKind, s.presetVariant, s.presetParams, s.designFreqHz)
    : s.freeform;
  // The native file format still requires these fields on Stackup.  Always
  // inject the canonical app settings at this boundary as a final safeguard.
  return { ...stackup, couplingLengthM: s.lineLengthM, riseTimePs: s.riseTimePs };
}

function defaultFreeform(): Stackup {
  const st = buildPreset('microstrip', 'se', defaultParams('microstrip', 'se'));
  return { ...st, title: 'custom stackup' };
}

export function defaultState(): AppState {
  return {
    mode: 'preset',
    presetKind: 'microstrip',
    presetVariant: 'se',
    presetParams: defaultParams('microstrip', 'se'),
    freeform: defaultFreeform(),
    lossParams: {
      includeReferencePlaneLoss: true,
      // Roughness is material/foil-specific. Defaulting to smooth avoids
      // inventing a surface measurement the user did not supply.
      roughnessModel: 'none',
      roughnessRqUm: 1.0,
      hurayRadiusUm: 0.5,
      hurayRatio: 2.2,
      fMinHz: 1e6,
      // The bundled dispersive JLC material anchors stop at 10 GHz.
      fMaxHz: 1e10,
      nPoints: 160,
    },
    displayUnit: 'mils',
    lineLengthM: 0.0254, // 1 inch
    riseTimePs: 100,
    designFreqHz: 1e9,
    lastSolve: null,
    solving: false,
  };
}

type Listener = (s: AppState) => void;

/** Decode only the current persisted-state schema. */
export function decodeSavedState(raw: string): AppState | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const { v, ...saved } = parsed as Partial<AppState> & { v?: unknown };
    if (v !== CFG_VERSION) return null;
    return mergeOverDefaults(saved);
  } catch {
    return null;
  }
}

class Store {
  private state: AppState;
  private listeners = new Set<Listener>();

  constructor() {
    const hasHashConfig = window.location.hash.replace(/^#/, '').length > 0;
    this.state = hasHashConfig
      ? this.loadFromUrl() ?? defaultState()
      : this.load() ?? defaultState();
  }

  /** a config in the URL hash wins over localStorage (shared links) */
  private loadFromUrl(): AppState | null {
    try {
      const saved = decodeHash(window.location.hash);
      return saved ? mergeOverDefaults(saved) : null;
    } catch {
      return null;
    }
  }

  get(): AppState {
    return this.state;
  }

  update(patch: Partial<AppState>) {
    if (patch.presetParams && patch.presetParams.cover === null && this.state.presetParams.cover !== null) {
      console.trace('TNTWEB-DEBUG cover -> null');
    }
    const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
    const lineLengthM = positive(patch.lineLengthM) ? patch.lineLengthM : this.state.lineLengthM;
    const riseTimePs = positive(patch.riseTimePs) ? patch.riseTimePs : this.state.riseTimePs;

    const next = { ...this.state, ...patch, lineLengthM, riseTimePs };
    const presetParams = { ...next.presetParams, couplingLengthM: lineLengthM, riseTimePs };
    presetParams.etch = etchReductionOf(presetParams.w, presetParams.etch);
    this.state = {
      ...next,
      presetParams,
      freeform: { ...next.freeform, couplingLengthM: lineLengthM, riseTimePs },
    };
    this.persist();
    for (const l of this.listeners) l(this.state);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private persist() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(persistable(this.state)));
    } catch {
      /* quota/private mode: fine */
    }
  }

  private load(): AppState | null {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      return decodeSavedState(raw);
    } catch {
      return null;
    }
  }
}

export const store = new Store();
