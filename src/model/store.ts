/**
 * Minimal observable app state + localStorage persistence.
 */
import type { LossParams, SolveOutput, Stackup } from './types.ts';
import { buildPreset, defaultParams, type PresetKind, type PresetParams, type PresetVariant } from './presets.ts';

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
  designFreqHz: number;
  lastSolve: SolveOutput | null;
  solving: boolean;
}

const LS_KEY = 'tnt-web-state-v1';
const CFG_VERSION = 1;

/** the shareable/persistable subset of the state */
function persistable(s: AppState) {
  const { lastSolve: _ls, solving: _sv, ...keep } = s;
  return { v: CFG_VERSION, ...keep };
}

/** legacy (v1 share links): base64url JSON in #cfg= */
export function decodeConfig(str: string): Partial<AppState> | null {
  try {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as Partial<AppState>;
  } catch {
    return null;
  }
}

/* ---------------- readable URL config ----------------
 *
 * Preset configs serialize as flat, human-scannable hash params, and only
 * values that differ from the preset defaults are included, e.g.
 *     #kind=stripline&var=diff&w=6.5&er=4.2
 * All dimensions are in mils. The free-form stackup doesn't flatten, so
 * freeform mode carries it as URI-encoded JSON in `stack=`.
 */

/** [urlKey, presetParams field, unit note] — plain numeric params */
const NUM_PARAMS: Array<[string, keyof PresetParams]> = [
  ['w', 'w'],
  ['s', 's'],
  ['t', 't'],
  ['etch', 'etch'],
  ['h', 'h'],
  ['h2', 'h2'],
  ['er', 'er'],
  ['tand', 'tanD'],
  ['sigma', 'sigma'],
  ['cpw_gap', 'cpwGap'],
  ['cpw_gnd_w', 'cpwGroundWidth'],
  ['cseg', 'cseg'],
  ['dseg', 'dseg'],
  ['rise_ps', 'riseTimePs'],
];

export function encodeConfig(s: AppState): string {
  const q = new URLSearchParams();
  if (s.mode === 'freeform') {
    q.set('mode', 'freeform');
    q.set('stack', JSON.stringify(s.freeform));
  } else {
    q.set('kind', s.presetKind);
    q.set('var', s.presetVariant);
    const defs = defaultParams(s.presetKind, s.presetVariant);
    const p = s.presetParams;
    for (const [key, field] of NUM_PARAMS) {
      const v = p[field] as number;
      if (Number.isFinite(v) && v !== (defs[field] as number)) q.set(key, String(+v.toPrecision(6)));
    }
    if (p.couplingLengthM !== defs.couplingLengthM) q.set('couple_mm', String(+(p.couplingLengthM * 1000).toPrecision(6)));
    if (p.cpwBottomGround !== defs.cpwBottomGround) q.set('cpw_bottom_gnd', p.cpwBottomGround ? '1' : '0');
    const dCover = defs.cover;
    if (!!p.cover !== !!dCover) q.set('mask', p.cover ? '1' : '0');
    if (p.cover) {
      if (p.cover.thickness !== (dCover?.thickness ?? -1)) q.set('mask_t', String(+p.cover.thickness.toPrecision(6)));
      if (p.cover.er !== (dCover?.er ?? -1)) q.set('mask_er', String(p.cover.er));
      if (p.cover.tanD !== (dCover?.tanD ?? -1)) q.set('mask_tand', String(p.cover.tanD));
    }
  }
  const d = defaultState();
  if (s.displayUnit !== d.displayUnit) q.set('units', s.displayUnit);
  if (s.lineLengthM !== d.lineLengthM) q.set('len_mm', String(+(s.lineLengthM * 1000).toPrecision(6)));
  if (s.designFreqHz !== d.designFreqHz) q.set('f_hz', String(s.designFreqHz));
  if (s.lossParams.roughnessModel !== d.lossParams.roughnessModel) q.set('rough', s.lossParams.roughnessModel);
  if (s.lossParams.roughnessRqUm !== d.lossParams.roughnessRqUm) q.set('rq_um', String(s.lossParams.roughnessRqUm));
  return q.toString();
}

/** parse the readable format (also detects legacy cfg=) */
export function decodeHash(hash: string): Partial<AppState> | null {
  const raw = hash.replace(/^#/, '');
  if (!raw) return null;
  const legacy = raw.match(/(?:^|&)cfg=([A-Za-z0-9_-]+)/);
  if (legacy) return decodeConfig(legacy[1]);
  const q = new URLSearchParams(raw);
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
      const couple = num('couple_mm');
      if (couple !== null) p.couplingLengthM = couple / 1000;
      if (q.has('cpw_bottom_gnd')) p.cpwBottomGround = q.get('cpw_bottom_gnd') !== '0';
      if (q.get('mask') === '0') p.cover = null;
      else if (q.get('mask') === '1' && !p.cover) p.cover = { thickness: 1, er: 3.8, tanD: 0.02 };
      if (p.cover) {
        const mt = num('mask_t');
        if (mt !== null) p.cover.thickness = mt;
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

/** merge a saved/shared partial state over defaults (tolerates old versions) */
function mergeOverDefaults(saved: Partial<AppState>): AppState {
  const d = defaultState();
  return {
    ...d,
    ...saved,
    presetParams: { ...d.presetParams, ...(saved.presetParams ?? {}) },
    lossParams: { ...d.lossParams, ...(saved.lossParams ?? {}) },
    freeform: (saved.freeform as AppState['freeform']) ?? d.freeform,
    lastSolve: null,
    solving: false,
  };
}

export function currentStackup(s: AppState): Stackup {
  return s.mode === 'preset'
    ? buildPreset(s.presetKind, s.presetVariant, s.presetParams)
    : s.freeform;
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
    lineLengthM: 0.1, // 10 cm
    designFreqHz: 1e9,
    lastSolve: null,
    solving: false,
  };
}

type Listener = (s: AppState) => void;

class Store {
  private state: AppState;
  private listeners = new Set<Listener>();

  constructor() {
    this.state = this.loadFromUrl() ?? this.load() ?? defaultState();
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
    this.state = { ...this.state, ...patch };
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
      // merge over defaults so new fields appear after upgrades
      return mergeOverDefaults(JSON.parse(raw));
    } catch {
      return null;
    }
  }
}

export const store = new Store();
