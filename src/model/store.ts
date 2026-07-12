/**
 * Minimal observable app state + localStorage persistence.
 */
import type { LossParams, SolveOutput, Stackup } from './types.ts';
import { buildPreset, defaultParams, type PresetKind, type PresetParams, type PresetVariant } from './presets.ts';

export type InputMode = 'preset' | 'freeform';

export interface AppState {
  mode: InputMode;
  presetKind: PresetKind;
  presetVariant: PresetVariant;
  presetParams: PresetParams;
  /** free-form stackup (independent of presets) */
  freeform: Stackup;
  lossParams: LossParams;
  lastSolve: SolveOutput | null;
  solving: boolean;
}

const LS_KEY = 'tnt-web-state-v1';

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
    lastSolve: null,
    solving: false,
  };
}

type Listener = (s: AppState) => void;

class Store {
  private state: AppState;
  private listeners = new Set<Listener>();

  constructor() {
    this.state = this.load() ?? defaultState();
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
      const { lastSolve: _ls, solving: _s, ...keep } = this.state;
      localStorage.setItem(LS_KEY, JSON.stringify(keep));
    } catch {
      /* quota/private mode: fine */
    }
  }

  private load(): AppState | null {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      const saved = JSON.parse(raw);
      // merge over defaults so new fields appear after upgrades
      const d = defaultState();
      return {
        ...d,
        ...saved,
        presetParams: { ...d.presetParams, ...saved.presetParams },
        lossParams: { ...d.lossParams, ...saved.lossParams },
        freeform: saved.freeform ?? d.freeform,
        lastSolve: null,
        solving: false,
      };
    } catch {
      return null;
    }
  }
}

export const store = new Store();
