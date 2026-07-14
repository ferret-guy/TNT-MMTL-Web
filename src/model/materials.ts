/**
 * Material presets, transcribed from TNT's gui/*.list files
 * (vendor/materials/). Conductivity in S/m; laminates pair permittivity
 * with loss tangent from the two matching lists.
 */

export interface ConductorMaterial {
  name: string;
  sigma: number; // S/m
}

export const CONDUCTORS: ConductorMaterial[] = [
  { name: 'copper', sigma: 5.0e7 },
  { name: 'silver', sigma: 6.0e7 },
  { name: 'gold', sigma: 4.0e7 },
  { name: 'aluminum', sigma: 3.0e7 },
  { name: 'brass', sigma: 1.0e7 },
  { name: 'lead', sigma: 5.0e7 },
  { name: 'nichrome', sigma: 10.0e7 },
  { name: 'tin', sigma: 9.0e7 },
  { name: 'tungsten', sigma: 1.0e7 },
];

export interface Laminate {
  /** Stable value persisted in share links and local storage. */
  id: string;
  name: string;
  /** Reference value, normally the 1 GHz anchor. */
  er: number;
  tanD: number;
  /** Characterized/estimated frequency anchors, interpolated in log10(f). */
  samples?: readonly LaminateSample[];
  /** Short provenance/uncertainty note shown below the laminate selector. */
  note?: string;
}

export interface LaminateSample {
  fHz: number;
  er: number;
  tanD: number;
}

export interface LaminateProperties {
  laminate: Laminate;
  er: number;
  tanD: number;
  /** Set only when a multi-point model was clamped outside its anchors. */
  clamped: 'low' | 'high' | null;
}

/**
 * Materials assumed by JLCPCB's impedance calculator.
 *
 * JLCPCB publishes construction-specific effective permittivities rather than
 * one universal Dk for either family. The representative values below are the
 * medians of all core/prepreg values in JLCPCB's June 2026 guide:
 *   NP-155F: 3.91..4.53 -> 4.36
 *   S1000-2M: 3.92..4.56 -> 4.29
 *
 * The 1 GHz anchors are JLC construction medians. Frequency dispersion is
 * interpolated linearly in log10(f), then clamped outside 1 MHz..10 GHz.
 * S1000-2M follows Shengyi's construction tables. NP-155F has manufacturer
 * data only through 1 GHz, so its 3/5/10 GHz anchors are plainly identified
 * consensus FR-4 estimates rather than manufacturer-characterized values.
 *
 * Sources:
 * https://jlcpcb.com/help/article/user-guide-to-the-jlcpcb-impedance-calculator
 * https://ccl.npc.com.tw/cclfile/pdt/Datasheet_NP-155F_1761637097200.pdf?v=51221
 * https://www.syst.com.cn/cn/Product/info_255.aspx?itemid=10979
 * https://www.syst.com.cn/uploadfiles/2025/04/20250422134737183.pdf
 */
export const JLCPCB_LAMINATES: Laminate[] = [
  {
    id: 'jlc-np155f',
    name: 'JLCPCB / Nan Ya NP-155F (4-8 layers)',
    er: 4.36,
    tanD: 0.014,
    samples: [
      { fHz: 1e6, er: 4.835, tanD: 0.018 },
      { fHz: 1e9, er: 4.36, tanD: 0.014 },
      { fHz: 3e9, er: 4.309, tanD: 0.015 },
      { fHz: 5e9, er: 4.258, tanD: 0.016 },
      { fHz: 10e9, er: 4.208, tanD: 0.017 },
    ],
    note: 'JLC 1 GHz construction εr range 3.91–4.53; 4.36 is the median. The 1 MHz point is scaled from Nan Ya FR/FTL data; above 1 GHz, dispersion and tan δ are consensus FR-4 estimates.',
  },
  {
    id: 'jlc-s1000-2m',
    name: 'JLCPCB / Shengyi S1000-2M (10+ layers)',
    er: 4.29,
    tanD: 0.018,
    samples: [
      { fHz: 1e6, er: 4.57, tanD: 0.015 },
      { fHz: 1e9, er: 4.29, tanD: 0.018 },
      { fHz: 3e9, er: 4.24, tanD: 0.019 },
      { fHz: 5e9, er: 4.19, tanD: 0.020 },
      { fHz: 10e9, er: 4.14, tanD: 0.021 },
    ],
    note: 'JLC 1 GHz construction εr range 3.92–4.56; 4.29 is the median. The 1 MHz point is scaled from Shengyi coupon data; 3–10 GHz uses Shengyi construction-table medians.',
  },
];

const fixedLaminate = (name: string, er: number, tanD: number): Laminate => ({
  id: name.toLowerCase(),
  name,
  er,
  tanD,
});

export const LAMINATES: Laminate[] = [
  ...JLCPCB_LAMINATES,
  fixedLaminate('FR402', 4.27, 0.016),
  fixedLaminate('FR404', 4.26, 0.014),
  fixedLaminate('FR406', 4.28, 0.014),
  fixedLaminate('FR406BC', 4.2, 0.014),
  fixedLaminate('FR408', 3.7, 0.01),
  fixedLaminate('NP130(FR4)', 4.8, 0.025),
  fixedLaminate('G10', 4.8, 0.025),
  fixedLaminate('NP511(G11)', 4.8, 0.2),
  fixedLaminate('GETEK', 3.9, 0.012),
  fixedLaminate('RO3003', 3.0, 0.001),
  fixedLaminate('RO3006', 6.15, 0.0025),
  fixedLaminate('RO3203', 3.02, 0.0016),
  fixedLaminate('RO3210', 10.2, 0.003),
  fixedLaminate('RO4003', 3.38, 0.0027),
  fixedLaminate('RO4350', 3.48, 0.004),
  fixedLaminate('RT5870', 2.33, 0.0012),
  fixedLaminate('RT5880', 2.2, 0.0009),
  fixedLaminate('RT6002', 2.94, 0.0012),
  fixedLaminate('CLTE', 2.94, 0.0025),
  fixedLaminate('ULTRALAM', 2.6, 0.0019),
  fixedLaminate('AR320', 3.2, 0.003),
  fixedLaminate('AR450', 4.5, 0.0035),
  fixedLaminate('AR600', 6.0, 0.0035),
  fixedLaminate('AR1000', 10.0, 0.0035),
  fixedLaminate('ADS-96R', 9.5, 0.004),
  fixedLaminate('ADS-995', 9.9, 0.0001),
  fixedLaminate('ADS-996', 9.9, 0.0001),
  fixedLaminate('ADOS090R', 10.3, 0.005),
  fixedLaminate('BerloxK-150', 6.7, 0.0002),
];

export function laminateById(id: string | null | undefined): Laminate | null {
  return id ? LAMINATES.find((laminate) => laminate.id === id) ?? null : null;
}

/** Resolve a material at frequency using log-frequency interpolation. */
export function materialAtFrequency(
  material: string | Laminate | null | undefined,
  fHz: number,
): LaminateProperties | null {
  const laminate = typeof material === 'string' ? laminateById(material) : material ?? null;
  if (!laminate) return null;
  const samples = laminate.samples;
  if (!samples?.length) return { laminate, er: laminate.er, tanD: laminate.tanD, clamped: null };

  const f = Number.isFinite(fHz) && fHz > 0 ? fHz : samples[0].fHz;
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (f <= first.fHz) {
    return { laminate, er: first.er, tanD: first.tanD, clamped: f < first.fHz ? 'low' : null };
  }
  if (f >= last.fHz) {
    return { laminate, er: last.er, tanD: last.tanD, clamped: f > last.fHz ? 'high' : null };
  }

  const hiIndex = samples.findIndex((sample) => sample.fHz >= f);
  const lo = samples[hiIndex - 1];
  const hi = samples[hiIndex];
  if (f === hi.fHz) return { laminate, er: hi.er, tanD: hi.tanD, clamped: null };
  const t = (Math.log10(f) - Math.log10(lo.fHz)) /
    (Math.log10(hi.fHz) - Math.log10(lo.fHz));
  return {
    laminate,
    er: lo.er + t * (hi.er - lo.er),
    tanD: lo.tanD + t * (hi.tanD - lo.tanD),
    clamped: null,
  };
}

/** solder-mask style cover coats (not in TNT's lists; common values) */
export const COVER_MATERIALS: Laminate[] = [
  fixedLaminate('Solder mask (LPI)', 3.8, 0.02),
  fixedLaminate('Polyimide', 3.5, 0.008),
];
