/**
 * Parse <name>.result_field_plot_data written by
 * vendor/mmtl/bem/src/nmmtl_write_plot_data.cpp:
 *
 *   Start Solution Output:
 *   Active Line: <name>
 *   [blank]
 *   Element Type: Conductor|Dielectric
 *   X Points: x0 x1 x2          (INTERP_PTS = 3, quadratic elements)
 *   Y Points: y0 y1 y2
 *   [Edge: 0 <nu>] [Edge: 1 <nu>]
 *   Charge Values: s0 s1 s2
 *   [blank]
 *   ... more elements ...
 *   End Solution Output:
 *   ... next Active Line block (one per driven signal line)
 *
 * Geometry is in meters; charge values are the BEM sigma at the element's
 * three interpolation nodes. Conductor blocks include the (discretized)
 * ground planes, so the free-space log kernel over ALL elements reconstructs
 * the potential without image terms.
 */

/**
 * @typedef {{type: 'conductor'|'dielectric', x: number[], y: number[],
 *            sigma: number[], edges: Array<{end: 0|1, nu: number}>}} FieldElement
 * @typedef {{line: string, elements: FieldElement[]}} FieldSolution
 */

/**
 * @param {string} text
 * @returns {FieldSolution[]}
 */
export function parseFieldPlot(text) {
  const solutions = [];
  let cur = null;
  let el = null;
  const flushEl = () => {
    if (el && el.x.length && el.sigma.length && cur) cur.elements.push(el);
    el = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('Start Solution Output')) {
      cur = { line: '', elements: [] };
      continue;
    }
    if (line.startsWith('Active Line:')) {
      if (cur) cur.line = line.slice('Active Line:'.length).trim().replace(/^::/, '');
      continue;
    }
    if (line.startsWith('End Solution Output')) {
      flushEl();
      if (cur) solutions.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('Element Type:')) {
      flushEl();
      el = {
        type: /Conductor/i.test(line) ? 'conductor' : 'dielectric',
        x: [],
        y: [],
        sigma: [],
        edges: [],
        epsilon: 1, // contacting dielectric (conductor elements)
        epsilonPlus: 1,
        epsilonMinus: 1,
      };
      continue;
    }
    if (!el) continue;
    if (line.startsWith('X Points:')) {
      el.x = line.slice('X Points:'.length).trim().split(/\s+/).map(Number);
    } else if (line.startsWith('Y Points:')) {
      el.y = line.slice('Y Points:'.length).trim().split(/\s+/).map(Number);
    } else if (line.startsWith('Charge Values:')) {
      el.sigma = line.slice('Charge Values:'.length).trim().split(/\s+/).map(Number);
    } else if (line.startsWith('Epsilon:')) {
      el.epsilon = Number(line.slice('Epsilon:'.length).trim()) || 1;
    } else if (line.startsWith('EpsilonPM:')) {
      const [p, m] = line.slice('EpsilonPM:'.length).trim().split(/\s+/).map(Number);
      el.epsilonPlus = p || 1;
      el.epsilonMinus = m || 1;
    } else if (line.startsWith('Edge:')) {
      const m = line.match(/^Edge:\s*(\d)\s+(\S+)/);
      if (m) el.edges.push({ end: Number(m[1]) === 1 ? 1 : 0, nu: Number(m[2]) });
    }
  }
  flushEl();
  if (cur) solutions.push(cur);
  return solutions;
}
