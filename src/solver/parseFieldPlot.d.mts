export interface FieldElement {
  type: 'conductor' | 'dielectric';
  x: number[];
  y: number[];
  sigma: number[];
  edges: Array<{ end: 0 | 1; nu: number }>;
  /** contacting dielectric constant (conductor elements; tnt-web extension) */
  epsilon: number;
  epsilonPlus: number;
  epsilonMinus: number;
}
export interface FieldSolution {
  line: string;
  elements: FieldElement[];
}
export declare function parseFieldPlot(text: string): FieldSolution[];
