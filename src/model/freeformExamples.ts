/**
 * Source-backed free-form configurations linked from the About page.
 *
 * Keep the geometry here rather than embedding serialized hashes in HTML so
 * example links always follow the current AppState URL schema.
 */
import {
  defaultState,
  encodeConfig,
  type AppState,
} from './store.ts';
import type { Stackup } from './types.ts';

export type FreeformExampleId = 'ribbon' | 'ribbon-many-port' | 'cat5';

export interface FreeformExampleBenchmark {
  quantity: 'single-ended Z0' | 'differential Z';
  ohms: number;
  label: string;
}

export interface FreeformExample {
  id: FreeformExampleId;
  title: string;
  summary: string;
  /** Published comparison point, when the example is intended as a benchmark. */
  benchmark?: FreeformExampleBenchmark;
  state: AppState;
  href: string;
}

const ONE_METRE = 1;
const EXAMPLE_RISE_TIME_PS = 100;

function freeformState(stackup: Stackup, designFreqHz: number): AppState {
  return {
    ...defaultState(),
    mode: 'freeform',
    // Geometry remains in source-friendly mils; the editor opens in mm to
    // match the dimensions quoted on the About page.
    displayUnit: 'mm',
    lineLengthM: ONE_METRE,
    riseTimePs: EXAMPLE_RISE_TIME_PS,
    designFreqHz,
    freeform: {
      ...stackup,
      couplingLengthM: ONE_METRE,
      riseTimePs: EXAMPLE_RISE_TIME_PS,
    },
  };
}

export const RIBBON_CABLE_EXAMPLE_STATE: AppState = freeformState(
  {
    title: 'Belden 9R280 G-S-G ribbon approximation',
    units: 'mils',
    couplingLengthM: ONE_METRE,
    riseTimePs: EXAMPLE_RISE_TIME_PS,
    cseg: 45,
    dseg: 45,
    items: [
      {
        kind: 'CircleDielectric',
        id: 'PVC-insulation',
        diameter: 36,
        number: 2,
        pitch: 100,
        permittivity: 2.89,
        lossTangent: 0.048,
        xOffset: 257,
        yOffset: 0,
      },
      {
        kind: 'RectangleDielectric',
        id: 'PVC-body',
        width: 100,
        height: 36,
        permittivity: 2.89,
        lossTangent: 0.048,
        xOffset: 275,
        yOffset: 0,
      },
      {
        kind: 'CircleConductors',
        id: 'GND',
        isGround: true,
        conductivity: 5e7,
        number: 2,
        pitch: 100,
        xOffset: 268.385,
        yOffset: 11.385,
        diameter: 13.23,
      },
      {
        kind: 'CircleConductors',
        id: 'SIG',
        isGround: false,
        conductivity: 5e7,
        number: 1,
        pitch: 0,
        xOffset: 318.385,
        yOffset: 11.385,
        diameter: 13.23,
      },
    ],
  },
  1e6,
);

/**
 * Eleven adjacent Belden 9R280 positions arranged G-S-G-S-G-S-G-S-G-S-G.
 * The two dielectric circles form the rounded ends of the 36 mil body; the
 * rectangle joins their centers across the ten 50 mil conductor intervals.
 */
export const WIDE_RIBBON_CABLE_EXAMPLE_STATE: AppState = freeformState(
  {
    title: 'Belden 9R280 five-signal wide ribbon approximation',
    units: 'mils',
    couplingLengthM: ONE_METRE,
    riseTimePs: EXAMPLE_RISE_TIME_PS,
    cseg: 45,
    dseg: 45,
    items: [
      {
        kind: 'CircleDielectric',
        id: 'PVC-insulation',
        diameter: 36,
        number: 2,
        pitch: 500,
        permittivity: 2.89,
        lossTangent: 0.048,
        xOffset: 257,
        yOffset: 0,
      },
      {
        kind: 'RectangleDielectric',
        id: 'PVC-body',
        width: 500,
        height: 36,
        permittivity: 2.89,
        lossTangent: 0.048,
        xOffset: 275,
        yOffset: 0,
      },
      {
        kind: 'CircleConductors',
        id: 'GND',
        isGround: true,
        conductivity: 5e7,
        number: 6,
        pitch: 100,
        xOffset: 268.385,
        yOffset: 11.385,
        diameter: 13.23,
      },
      {
        kind: 'CircleConductors',
        id: 'SIG',
        isGround: false,
        conductivity: 5e7,
        number: 5,
        pitch: 100,
        xOffset: 318.385,
        yOffset: 11.385,
        diameter: 13.23,
      },
    ],
  },
  1e6,
);

export const CAT5E_PAIR_EXAMPLE_STATE: AppState = freeformState(
  {
    title: 'Belden Cat5e pair straight-section approximation',
    units: 'mils',
    couplingLengthM: ONE_METRE,
    riseTimePs: EXAMPLE_RISE_TIME_PS,
    cseg: 45,
    dseg: 45,
    items: [
      {
        kind: 'CircleDielectric',
        id: 'PE',
        diameter: 35.03937007874016,
        number: 2,
        pitch: 35.03937007874016,
        permittivity: 2.34,
        lossTangent: 0.00002,
        xOffset: 0,
        yOffset: 0,
      },
      {
        kind: 'CircleConductors',
        id: 'Pair',
        isGround: false,
        conductivity: 5.2e7,
        number: 2,
        pitch: 35.03937007874016,
        xOffset: 7.460629921259844,
        yOffset: 7.460629921259844,
        diameter: 20.118110236220474,
      },
    ],
  },
  1e8,
);

/** Relative calculator link suitable for an About-page anchor. */
export function freeformExampleHref(state: AppState): string {
  return `./#${encodeConfig(state)}`;
}

export const FREEFORM_EXAMPLES: readonly FreeformExample[] = [
  {
    id: 'ribbon',
    title: 'Belden 9R280 G-S-G ribbon benchmark',
    summary: 'A ground-signal-ground slice through a PVC ribbon cable.',
    benchmark: {
      quantity: 'single-ended Z0',
      ohms: 105,
      label: 'Belden 9R280 nominal G-S-G impedance',
    },
    state: RIBBON_CABLE_EXAMPLE_STATE,
    href: freeformExampleHref(RIBBON_CABLE_EXAMPLE_STATE),
  },
  {
    id: 'ribbon-many-port',
    title: 'Belden 9R280 five-signal wide ribbon',
    summary: 'Five signal wires alternate with six explicit ground wires in a rounded PVC ribbon body.',
    state: WIDE_RIBBON_CABLE_EXAMPLE_STATE,
    href: freeformExampleHref(WIDE_RIBBON_CABLE_EXAMPLE_STATE),
  },
  {
    id: 'cat5',
    title: 'Belden Cat5e pair',
    summary: 'A straight 2-D section through one PE-insulated Cat5e pair.',
    benchmark: {
      quantity: 'differential Z',
      ohms: 100,
      label: 'Belden Cat5e nominal differential impedance',
    },
    state: CAT5E_PAIR_EXAMPLE_STATE,
    href: freeformExampleHref(CAT5E_PAIR_EXAMPLE_STATE),
  },
];

export const FREEFORM_EXAMPLES_BY_ID: Readonly<
  Record<FreeformExampleId, FreeformExample>
> = Object.fromEntries(FREEFORM_EXAMPLES.map((example) => [example.id, example])) as Record<
  FreeformExampleId,
  FreeformExample
>;
