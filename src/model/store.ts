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

/** base64url-encode the config for use in a URL hash */
export function encodeConfig(s: AppState): string {
  const json = JSON.stringify(persistable(s));
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

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

  /** #cfg=... in the URL wins over localStorage (shared links) */
  private loadFromUrl(): AppState | null {
    try {
      const m = window.location.hash.match(/[#&]cfg=([A-Za-z0-9_-]+)/);
      if (!m) return null;
      const saved = decodeConfig(m[1]);
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
