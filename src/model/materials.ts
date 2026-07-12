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
  name: string;
  er: number;
  tanD: number;
}

export const LAMINATES: Laminate[] = [
  { name: 'FR402', er: 4.27, tanD: 0.016 },
  { name: 'FR404', er: 4.26, tanD: 0.014 },
  { name: 'FR406', er: 4.28, tanD: 0.014 },
  { name: 'FR406BC', er: 4.2, tanD: 0.014 },
  { name: 'FR408', er: 3.7, tanD: 0.01 },
  { name: 'NP130(FR4)', er: 4.8, tanD: 0.025 },
  { name: 'G10', er: 4.8, tanD: 0.025 },
  { name: 'NP511(G11)', er: 4.8, tanD: 0.2 },
  { name: 'GETEK', er: 3.9, tanD: 0.012 },
  { name: 'RO3003', er: 3.0, tanD: 0.001 },
  { name: 'RO3006', er: 6.15, tanD: 0.0025 },
  { name: 'RO3203', er: 3.02, tanD: 0.0016 },
  { name: 'RO3210', er: 10.2, tanD: 0.003 },
  { name: 'RO4003', er: 3.38, tanD: 0.0027 },
  { name: 'RO4350', er: 3.48, tanD: 0.004 },
  { name: 'RT5870', er: 2.33, tanD: 0.0012 },
  { name: 'RT5880', er: 2.2, tanD: 0.0009 },
  { name: 'RT6002', er: 2.94, tanD: 0.0012 },
  { name: 'CLTE', er: 2.94, tanD: 0.0025 },
  { name: 'ULTRALAM', er: 2.6, tanD: 0.0019 },
  { name: 'AR320', er: 3.2, tanD: 0.003 },
  { name: 'AR450', er: 4.5, tanD: 0.0035 },
  { name: 'AR600', er: 6.0, tanD: 0.0035 },
  { name: 'AR1000', er: 10.0, tanD: 0.0035 },
  { name: 'ADS-96R', er: 9.5, tanD: 0.004 },
  { name: 'ADS-995', er: 9.9, tanD: 0.0001 },
  { name: 'ADS-996', er: 9.9, tanD: 0.0001 },
  { name: 'ADOS090R', er: 10.3, tanD: 0.005 },
  { name: 'BerloxK-150', er: 6.7, tanD: 0.0002 },
];

/** solder-mask style cover coats (not in TNT's lists; common values) */
export const COVER_MATERIALS: Laminate[] = [
  { name: 'Solder mask (LPI)', er: 3.8, tanD: 0.02 },
  { name: 'Polyimide', er: 3.5, tanD: 0.008 },
];
