#!/usr/bin/env node
/** About-page free-form example links and native-solver benchmarks. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

// Importing store.ts creates the browser store singleton. Supply the same
// minimal browser surface used by the other state-serialization tests.
globalThis.window = { location: { hash: '' } };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const {
  CAT5E_PAIR_EXAMPLE_STATE,
  FREEFORM_EXAMPLES,
  FREEFORM_EXAMPLES_BY_ID,
  RIBBON_CABLE_EXAMPLE_STATE,
  WIDE_RIBBON_CABLE_EXAMPLE_STATE,
  freeformExampleHref,
} = await import('../../src/model/freeformExamples.ts');
const { currentStackup, decodeHash, defaultState, encodeConfig } = await import('../../src/model/store.ts');
const { isConductor, signalCount } = await import('../../src/model/types.ts');
const { computeGeometry } = await import('../../src/ui/crossSection.ts');
const { generateXsctn, validateStackup } = await import('../../src/xsctn/generate.ts');
const { parseResult } = await import('../../src/solver/parseResult.mjs');
const {
  isExplicitReferenceStackup,
  prepareExplicitReferenceStackup,
  reduceExplicitReferenceResults,
} = await import('../../src/analysis/explicitReference.ts');
const { freeSpaceStackup } = await import('../../src/analysis/meshReferenceLoss.ts');
const createBemModule = (
  await import(new URL('../../public/wasm/bem.mjs', import.meta.url).href)
).default;

const aboutHtml = await readFile(new URL('../../about.html', import.meta.url), 'utf8');

async function solveStackup(stackup, caseName) {
  const stdout = [];
  const mod = await createBemModule({
    print: (line) => stdout.push(line),
    printErr: (line) => stdout.push(line),
  });
  mod.FS.mkdir('/work');
  mod.FS.writeFile(`/work/${caseName}.xsctn`, generateXsctn(stackup));
  mod.FS.chdir('/work');

  let exitCode = 0;
  try {
    exitCode = mod.callMain([
      `/work/${caseName}`,
      String(stackup.cseg),
      String(stackup.dseg),
    ]);
  } catch (error) {
    if (error?.name === 'ExitStatus') exitCode = error.status;
    else throw error;
  }

  const log = stdout.join('\n');
  assert.equal(exitCode ?? 0, 0, log);
  assert.match(log, /MMTL is done/, log);
  return parseResult(mod.FS.readFile(`/work/${caseName}.result`, { encoding: 'utf8' }));
}

/** Exercise the same explicit-reference reduction used by the live page. */
async function solveExample(state) {
  const stackup = currentStackup(state);
  if (!isExplicitReferenceStackup(stackup)) {
    return solveStackup(stackup, 'example');
  }
  const preparation = prepareExplicitReferenceStackup(stackup);
  const primary = await solveStackup(preparation.solverStackup, 'primary');
  const freeSpace = await solveStackup(
    freeSpaceStackup(preparation.solverStackup),
    'free-space',
  );
  return reduceExplicitReferenceResults(
    preparation,
    primary,
    freeSpace,
  ).result;
}

test('free-form examples preserve their source-derived geometry and app settings', () => {
  assert.deepEqual(
    FREEFORM_EXAMPLES.map(({ id }) => id),
    ['ribbon', 'ribbon-many-port', 'cat5'],
  );
  assert.equal(FREEFORM_EXAMPLES_BY_ID.ribbon.state, RIBBON_CABLE_EXAMPLE_STATE);
  assert.equal(
    FREEFORM_EXAMPLES_BY_ID['ribbon-many-port'].state,
    WIDE_RIBBON_CABLE_EXAMPLE_STATE,
  );
  assert.equal(FREEFORM_EXAMPLES_BY_ID.cat5.state, CAT5E_PAIR_EXAMPLE_STATE);

  const ribbon = RIBBON_CABLE_EXAMPLE_STATE;
  assert.equal(ribbon.mode, 'freeform');
  assert.equal(ribbon.displayUnit, 'mm');
  assert.equal(ribbon.lineLengthM, 1);
  assert.equal(ribbon.riseTimePs, 100);
  assert.equal(ribbon.designFreqHz, 1e6);
  assert.equal(ribbon.freeform.title, 'Belden 9R280 G-S-G ribbon approximation');
  assert.equal(ribbon.freeform.units, 'mils');
  assert.equal(ribbon.freeform.cseg, 45);
  assert.equal(ribbon.freeform.dseg, 45);
  assert.deepEqual(validateStackup(ribbon.freeform), []);
  assert.equal(signalCount(ribbon.freeform), 1);
  assert.deepEqual(ribbon.freeform.items, [
    {
      kind: 'CircleDielectric', id: 'PVC-insulation', diameter: 36,
      number: 2, pitch: 100, permittivity: 2.89, lossTangent: 0.048,
      xOffset: 257, yOffset: 0,
    },
    {
      kind: 'RectangleDielectric', id: 'PVC-body', width: 100, height: 36,
      permittivity: 2.89, lossTangent: 0.048, xOffset: 275, yOffset: 0,
    },
    {
      kind: 'CircleConductors', id: 'GND', isGround: true, conductivity: 5e7,
      number: 2, pitch: 100, xOffset: 268.385, yOffset: 11.385, diameter: 13.23,
    },
    {
      kind: 'CircleConductors', id: 'SIG', isGround: false, conductivity: 5e7,
      number: 1, pitch: 0, xOffset: 318.385, yOffset: 11.385, diameter: 13.23,
    },
  ]);

  const cat5 = CAT5E_PAIR_EXAMPLE_STATE;
  assert.equal(cat5.mode, 'freeform');
  assert.equal(cat5.displayUnit, 'mm');
  assert.equal(cat5.lineLengthM, 1);
  assert.equal(cat5.riseTimePs, 100);
  assert.equal(cat5.designFreqHz, 1e8);
  assert.equal(cat5.lossParams.roughnessModel, 'hammerstad');
  assert.equal(cat5.lossParams.roughnessRqUm, 5);
  assert.equal(cat5.freeform.title, 'Belden Cat5e pair straight-section approximation');
  assert.equal(cat5.freeform.units, 'mils');
  assert.equal(cat5.freeform.cseg, 45);
  assert.equal(cat5.freeform.dseg, 45);
  assert.deepEqual(validateStackup(cat5.freeform), []);
  assert.equal(signalCount(cat5.freeform), 2);
  assert.deepEqual(cat5.freeform.items, [
    {
      kind: 'CircleDielectric', id: 'PE', diameter: 35.03937007874016,
      number: 2, pitch: 35.03937007874016,
      permittivity: 2.34, lossTangent: 0.00002, xOffset: 0, yOffset: 0,
    },
    {
      kind: 'CircleConductors', id: 'Pair', isGround: false, conductivity: 5.2e7,
      number: 2, pitch: 35.03937007874016, xOffset: 7.460629921259844,
      yOffset: 7.460629921259844, diameter: 20.118110236220474,
    },
  ]);
});

test('wide ribbon fixture is a rounded alternating 6-ground/5-signal geometry', () => {
  const state = WIDE_RIBBON_CABLE_EXAMPLE_STATE;
  const stackup = state.freeform;
  assert.equal(state.mode, 'freeform');
  assert.equal(state.displayUnit, 'mm');
  assert.equal(state.lineLengthM, 1);
  assert.equal(state.designFreqHz, 1e6);
  assert.equal(stackup.units, 'mils');
  assert.equal(stackup.cseg, 45);
  assert.equal(stackup.dseg, 45);
  assert.deepEqual(validateStackup(stackup), []);
  assert.equal(signalCount(stackup), 5);

  const conductorSets = stackup.items.filter(isConductor);
  assert.equal(
    conductorSets.filter((item) => item.isGround)
      .reduce((total, item) => total + item.number, 0),
    6,
  );
  assert.equal(
    conductorSets.filter((item) => !item.isGround)
      .reduce((total, item) => total + item.number, 0),
    5,
  );

  const geometry = computeGeometry(stackup);
  const conductors = geometry.polys
    .filter((poly) => poly.kind === 'conductor')
    .sort((a, b) => a.x0 - b.x0);
  assert.equal(conductors.length, 11);
  assert.deepEqual(
    conductors.map((poly) => poly.isGroundConductor ? 'G' : 'S'),
    ['G', 'S', 'G', 'S', 'G', 'S', 'G', 'S', 'G', 'S', 'G'],
  );
  assert.deepEqual(
    conductors.slice(1).map((poly, index) =>
      Number((poly.x0 - conductors[index].x0).toFixed(9))),
    Array(10).fill(50),
  );

  const pvc = geometry.polys.filter((poly) => poly.kind === 'block');
  assert.equal(pvc.length, 3, 'two rounded end caps plus the joining body');
  assert.equal(Math.min(...pvc.map((poly) => poly.x0)), 257);
  assert.equal(Math.max(...pvc.map((poly) => poly.x1)), 793);
  assert.equal(Math.max(...pvc.map((poly) => poly.y1)), 36);
});

test('About-page cable cards link their titles and publish solved benchmark accuracy', () => {
  assert.doesNotMatch(aboutHtml, /XX%|Treat this as an impedance benchmark/);
  assert.match(
    aboutHtml,
    /<h3 class="about-cable-title">\s*<a [^>]*data-freeform-example="ribbon"[^>]*>Ribbon cable<\/a>/,
  );
  assert.match(
    aboutHtml,
    /<h3 class="about-cable-title">\s*<a [^>]*data-freeform-example="cat5"[^>]*>Cat5e twisted pair<\/a>/,
  );
  assert.match(aboutHtml, /estimated tan\(delta\) = 0\.048/);
  assert.match(aboutHtml, /estimated tan\(delta\) = 0\.00002/);
  assert.match(aboutHtml, /specified value to within 0\.5%/);
  assert.match(aboutHtml, /specified value to within 4\.8%/);
});

test('Ribbon card exposes one relative link to the many-port fixture', () => {
  const links = [...aboutHtml.matchAll(
    /<a\s+href="([^"]+)"\s+data-freeform-example="ribbon-many-port">([^<]+)<\/a>/g,
  )];
  assert.equal(links.length, 1);
  assert.equal(links[0][1], './');
  assert.equal(
    links[0][2],
    'Open the 5-signal, 6-ground many-port ribbon example',
  );
  assert.match(FREEFORM_EXAMPLES_BY_ID['ribbon-many-port'].href, /^\.\/#v=3&mode=freeform&stack=/);
});

test('free-form example links round-trip through the readable hash schema', () => {
  for (const example of FREEFORM_EXAMPLES) {
    const href = freeformExampleHref(example.state);
    assert.equal(example.href, href);
    assert.equal(href, `./#${encodeConfig(example.state)}`);
    assert.match(href, /^\.\/#v=3&mode=freeform&stack=/);

    const decoded = decodeHash(href.slice(2));
    assert.equal(decoded?.mode, 'freeform');
    assert.deepEqual(decoded?.freeform?.items, example.state.freeform.items);
    assert.equal(decoded?.freeform?.title, example.state.freeform.title);
    assert.equal(decoded?.freeform?.units, example.state.freeform.units);
    assert.equal(decoded?.freeform?.cseg, 45);
    assert.equal(decoded?.freeform?.dseg, 45);
    assert.equal(decoded?.displayUnit, 'mm');
    assert.equal(decoded?.lineLengthM, 1);
    assert.equal(decoded?.riseTimePs ?? defaultState().riseTimePs, 100);
    assert.equal(decoded?.designFreqHz, example.state.designFreqHz);
    const decodedLossParams = {
      ...defaultState().lossParams,
      ...(decoded?.lossParams ?? {}),
    };
    assert.equal(
      decodedLossParams.roughnessModel,
      example.state.lossParams.roughnessModel,
    );
    assert.equal(
      decodedLossParams.roughnessRqUm,
      example.state.lossParams.roughnessRqUm,
    );
  }
});

test('finite dielectric loss tangents round-trip and old links default to lossless', () => {
  const state = defaultState();
  state.mode = 'freeform';
  state.freeform = {
    ...state.freeform,
    items: [
      { kind: 'GroundPlane', id: 'gnd' },
      {
        kind: 'DielectricLayer', id: 'layer', thickness: 10,
        permittivity: 4.2, lossTangent: 0.014,
      },
      {
        kind: 'RectangleDielectric', id: 'block', width: 20, height: 5,
        permittivity: 2.8, lossTangent: 0.023, xOffset: 0, yOffset: 0,
      },
      {
        kind: 'TrapezoidDielectric', id: 'trapezoid', bottomWidth: 20,
        topWidth: 18, height: 4, permittivity: 3.1, lossTangent: 0.031,
        xOffset: 0, yOffset: 0,
      },
      {
        kind: 'RectangleConductors', id: 'signal', isGround: false,
        conductivity: 5.8e7, number: 1, pitch: 0, xOffset: 8,
        yOffset: 0, width: 4, height: 1,
      },
    ],
  };

  const decoded = decodeHash(`#${encodeConfig(state)}`);
  assert.deepEqual(
    decoded?.freeform?.items
      .filter((item) => 'lossTangent' in item)
      .map((item) => item.lossTangent),
    [0.014, 0.023, 0.031],
  );

  const legacy = structuredClone(state.freeform);
  for (const item of legacy.items) {
    if (item.kind === 'RectangleDielectric' || item.kind === 'TrapezoidDielectric') {
      delete item.lossTangent;
    }
  }
  const query = new URLSearchParams({
    v: '3',
    mode: 'freeform',
    stack: JSON.stringify(legacy),
  });
  const decodedLegacy = decodeHash(`#${query.toString()}`);
  assert.deepEqual(
    decodedLegacy?.freeform?.items
      .filter((item) =>
        item.kind === 'RectangleDielectric' || item.kind === 'TrapezoidDielectric')
      .map((item) => item.lossTangent),
    [0, 0],
  );
});

test('native BEM ribbon example is near the published 105 ohm benchmark', async () => {
  const result = await solveExample(RIBBON_CABLE_EXAMPLE_STATE);
  assert.equal(result.nSignals, 1);
  assert.ok(
    result.z0[0] >= 104.4 && result.z0[0] <= 104.6,
    `ribbon Z0=${result.z0[0]} ohm`,
  );
  const benchmark = FREEFORM_EXAMPLES_BY_ID.ribbon.benchmark.ohms;
  assert.equal(benchmark, 105);
  assert.equal((Math.abs(result.z0[0] - benchmark) / benchmark * 100).toFixed(1), '0.5');
});

test('native BEM Cat5e example is a 100 ohm differential pair', async () => {
  const result = await solveExample(CAT5E_PAIR_EXAMPLE_STATE);
  assert.equal(result.nSignals, 1);
  assert.ok(result.floatingDifferential);
  const differentialOhms = result.z0[0];
  assert.ok(
    differentialOhms >= 104.6 && differentialOhms <= 104.9,
    `Cat5e differential Z=${differentialOhms} ohm`,
  );
  const benchmark = FREEFORM_EXAMPLES_BY_ID.cat5.benchmark.ohms;
  assert.equal(benchmark, 100);
  assert.equal((Math.abs(differentialOhms - benchmark) / benchmark * 100).toFixed(1), '4.8');
});
