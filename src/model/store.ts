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
    for (const [key, field] of NUM_PARAMS) {
      if ((field === 'er2' || field === 'tanD2') &&
          (s.presetKind !== 'stripline' || !p.striplineSeparateMaterials)) continue;
      const v = p[field] as number;
      if (Number.isFinite(v) && v !== (defs[field] as number)) q.set(key, String(+v.toPrecision(6)));
    }
    const etch = etchReductionOf(p.w, p.etch);
    if (Number.isFinite(etch) && etch !== defs.etch)
      q.set('etch_delta', String(+etch.toPrecision(6)));
    if (p.cpwBottomGround !== defs.cpwBottomGround) q.set('cpw_bottom_gnd', p.cpwBottomGround ? '1' : '0');
    if (s.presetKind === 'stripline' && p.striplineSeparateMaterials) q.set('split_lam', '1');
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
      if (stack && Array.isArray(stack.items)) out.freeform = stack;
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
      for (const [key, field] of NUM_PARAMS) {
        const v = num(key);
        if (v !== null) (p[field] as number) = v;
      }
      p.striplineSeparateMaterials = kind === 'stripline' && q.get('split_lam') === '1';
      if (p.striplineSeparateMaterials) {
        if (!q.has('er2')) p.er2 = p.er;
        if (!q.has('tand2')) p.tanD2 = p.tanD;
      }
      const etchDelta = num('etch_delta');
      if (etchDelta !== null) p.etch = Math.max(0, etchDelta);
      p.etch = etchReductionOf(p.w, p.etch);
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
  if (rough || rq !== null) {
    const d = defaultState();
    out.lossParams = {
      ...d.lossParams,
      ...(rough && ['none', 'hammerstad', 'huray'].includes(rough)
        ? { roughnessModel: rough as LossParams['roughnessModel'] }
        : {}),
      ...(rq !== null ? { roughnessRqUm: rq } : {}),
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
  const presetParams = {
    ...d.presetParams,
    ...(saved.presetParams ?? {}),
    couplingLengthM: lineLengthM,
    riseTimePs,
  };
  presetParams.etch = etchReductionOf(presetParams.w, presetParams.etch);
  presetParams.cover = presetParams.cover ? normalizeCover(presetParams.cover) : null;
  const freeform = {
    ...d.freeform,
    ...(saved.freeform ?? {}),
    couplingLengthM: lineLengthM,
    riseTimePs,
  };
  return {
    ...d,
    ...saved,
    presetParams,
    lossParams: { ...d.lossParams, ...(saved.lossParams ?? {}) },
    freeform,
    lineLengthM,
    riseTimePs,
    lastSolve: null,
    solving: false,
  };
}

export function currentStackup(s: AppState): Stackup {
  const stackup = s.mode === 'preset'
    ? buildPreset(s.presetKind, s.presetVariant, s.presetParams)
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
      roughnessModel: 'hammerstad',
      roughnessRqUm: 1.0,
      hurayRatio: 2.2,
      fMinHz: 1e6,
      fMaxHz: 1e11,
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
