/**
 * Parse the solver's .result text into a structured object.
 * Anchored on the literal section headers written by
 * nmmtl_output_headers.cpp / nmmtl_output_matrices.cpp /
 * output_charimp_propvel.cpp / nmmtl_dc_resistance.cpp / output_crosstalk.cpp.
 *
 * Plain ESM (no TS syntax): imported by the Vite app, the node golden
 * harness, and the physics sanity suite alike.
 */

const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/;

/** strip the '::' Tcl-namespace prefix the solver puts on instance names */
const cleanName = (s) => s.replace(/^::/, '').trim();

/**
 * @param {string} text
 * @returns {import('../model/types').SolveResult}
 */
export function parseResult(text) {
  const lines = text.split(/\r?\n/);
  const warnings = [];

  /** ordered list of signal names as first encountered in the B matrix */
  const names = [];
  const nameIdx = (n) => {
    let i = names.indexOf(n);
    if (i < 0) {
      names.push(n);
      i = names.length - 1;
    }
    return i;
  };

  const matEntries = { B: [], L: [], Rdc: [] };
  const perLine = {}; // section -> [{name, value}]
  const oddEven = {}; // section -> {odd, even}
  const fxt = [];
  const bxt = [];
  let nSignalsHeader = null;
  let couplingLengthM;
  let riseTimePs;
  let minFreqMHz;

  let section = null;
  const SECTIONS = [
    ['Mutual and Self Electrostatic Induction', 'B'],
    ['Mutual and Self Inductance', 'L'],
    ['Characteristic Impedance Odd/Even', 'z0oe'],
    ['Characteristic Impedance', 'z0'],
    ['Effective Dielectric Constant', 'eps'],
    ['Propagation Velocity Odd/Even', 'veloe'],
    ['Propagation Velocity', 'vel'],
    ['Propagation Delay Odd/Even', 'delayoe'],
    ['Propagation Delay', 'delay'],
    ['Rdc', 'Rdc'],
    ['Far-End', 'FXT'],
    ['Near-End', 'BXT'],
  ];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const hdr = SECTIONS.find(([h]) => line.startsWith(h));
    if (hdr) {
      section = hdr[1];
      continue;
    }

    let m;
    if ((m = line.match(/^Number of Signal Lines\s*=\s*(\d+)/))) {
      nSignalsHeader = parseInt(m[1], 10);
      continue;
    }
    if ((m = line.match(new RegExp(`^Coupling Length\\s*=\\s*(${NUM.source})\\s*meters`)))) {
      couplingLengthM = parseFloat(m[1]);
      continue;
    }
    if ((m = line.match(new RegExp(`^Rise Time\\s*=\\s*(${NUM.source})\\s*picoseconds`)))) {
      riseTimePs = parseFloat(m[1]);
      continue;
    }
    if ((m = line.match(new RegExp(`minimum frequency.*?is\\s*(${NUM.source})\\s*MHz`)))) {
      minFreqMHz = parseFloat(m[1]);
      continue;
    }
    if (/^\*+/.test(line) || /^Warning/i.test(line)) {
      warnings.push(line.replace(/^\*+\s*/, ''));
      continue;
    }

    // matrix entries: B( ::a , ::b )=   v     (same for L, Rdc)
    if ((m = line.match(new RegExp(`^(B|L|Rdc)\\(\\s*(\\S+)\\s*,\\s*(\\S+)\\s*\\)=\\s*(${NUM.source})`)))) {
      const [, kind, a, b, v] = m;
      matEntries[kind].push({ a: cleanName(a), b: cleanName(b), v: parseFloat(v) });
      continue;
    }

    // crosstalk: FXT( a , b )= v =  d dB   |   FXT( a , b )= v = infinite dB
    if ((m = line.match(new RegExp(`^(FXT|BXT)\\(\\s*(\\S+)\\s*,\\s*(\\S+)\\s*\\)=\\s*(${NUM.source})\\s*=\\s*(\\S+)`)))) {
      const [, kind, a, b, v, d] = m;
      (kind === 'FXT' ? fxt : bxt).push({
        active: cleanName(a),
        passive: cleanName(b),
        value: parseFloat(v),
        dB: /inf/i.test(d) ? null : parseFloat(d),
      });
      continue;
    }

    // per-line values: "For Signal Line ::name= 30.8011"
    if ((m = line.match(new RegExp(`^For Signal Line\\s+(\\S+?)=\\s*(${NUM.source})`)))) {
      (perLine[section] ??= []).push({ name: cleanName(m[1]), value: parseFloat(m[2]) });
      continue;
    }

    // odd/even: "odd= 55.98" / "even= 59.85" inside *Odd/Even sections
    if ((m = line.match(new RegExp(`^(odd|even)=\\s*(${NUM.source})`)))) {
      const base = section === 'z0oe' ? 'z0' : section === 'veloe' ? 'vel' : 'delay';
      (oddEven[base] ??= {})[m[1]] = parseFloat(m[2]);
      continue;
    }
  }

  // establish name order from per-line impedance first (stable), else matrices
  for (const e of perLine['z0'] ?? []) nameIdx(e.name);
  for (const e of matEntries.B) {
    nameIdx(e.a);
    nameIdx(e.b);
  }
  const n = names.length;
  const buildMatrix = (entries) => {
    const M = Array.from({ length: n }, () => Array(n).fill(NaN));
    for (const { a, b, v } of entries) {
      const i = nameIdx(a);
      const j = nameIdx(b);
      M[i][j] = v;
      if (Number.isNaN(M[j][i])) M[j][i] = v; // mirror when only triangle printed
    }
    return M;
  };

  const perLineVec = (sec) => {
    const vec = Array(n).fill(NaN);
    for (const e of perLine[sec] ?? []) vec[nameIdx(e.name)] = e.value;
    return vec;
  };

  if (nSignalsHeader !== null && nSignalsHeader !== n && n > 0) {
    warnings.push(`header says ${nSignalsHeader} signals but parsed ${n}`);
  }

  return {
    nSignals: n || nSignalsHeader || 0,
    names,
    B: buildMatrix(matEntries.B),
    L: buildMatrix(matEntries.L),
    Rdc: buildMatrix(matEntries.Rdc),
    z0: perLineVec('z0'),
    zOdd: oddEven.z0?.odd,
    zEven: oddEven.z0?.even,
    epsEff: perLineVec('eps'),
    velocity: perLineVec('vel'),
    velocityOdd: oddEven.vel?.odd,
    velocityEven: oddEven.vel?.even,
    delay: perLineVec('delay'),
    delayOdd: oddEven.delay?.odd,
    delayEven: oddEven.delay?.even,
    fxt,
    bxt,
    couplingLengthM,
    riseTimePs,
    minFreqMHz,
    warnings,
  };
}
