#!/usr/bin/env node
/**
 * Physics sanity suite: solves textbook cases through the real pipeline
 * (preset builder -> xsctn generator -> wasm solver -> result parser) and
 * checks against closed-form references and design bands.
 *
 * Requires Node >= 23 (native TypeScript type stripping) since it imports
 * the app's TS modules directly.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

const { buildPreset, defaultParams, topWidthOf } = await import(pathToFileURL(join(root, 'src/model/presets.ts')));
const { generateXsctn } = await import(pathToFileURL(join(root, 'src/xsctn/generate.ts')));
const { computeGeometry } = await import(pathToFileURL(join(root, 'src/ui/crossSection.ts')));
const { runGoalSeek } = await import(pathToFileURL(join(root, 'src/analysis/goalSeek.ts')));
const { parseResult } = await import(pathToFileURL(join(root, 'src/solver/parseResult.mjs')));
const createBemModule = (await import(pathToFileURL(join(root, 'public/wasm/bem.mjs')))).default;

async function solve({ xsctn, cseg, dseg }) {
  const stdout = [];
  const mod = await createBemModule({ print: (s) => stdout.push(s), printErr: (s) => stdout.push(s) });
  mod.FS.mkdir('/work');
  mod.FS.writeFile('/work/case.xsctn', xsctn);
  mod.FS.chdir('/work');
  try {
    mod.callMain(['/work/case', String(cseg), String(dseg)]);
  } catch (e) {
    if (e?.name !== 'ExitStatus') throw e;
  }
  const log = stdout.join('\n');
  let result = null;
  try {
    result = parseResult(mod.FS.readFile('/work/case.result', { encoding: 'utf8' }));
  } catch {
    /* fallthrough */
  }
  return { ok: log.includes('MMTL is done') && !!result, result, log };
}

async function solvePreset(kind, variant, mutate = (p) => p) {
  const params = mutate(defaultParams(kind, variant));
  const stackup = buildPreset(kind, variant, params);
  const out = await solve({ xsctn: generateXsctn(stackup), cseg: stackup.cseg, dseg: stackup.dseg });
  if (!out.ok) throw new Error(`${kind}/${variant} solve failed`);
  return { params, r: out.result, log: out.log };
}

/* ---- closed forms ---- */
const ETA0 = 376.730313668;

function hammerstadZ0(w, h, er) {
  const u = w / h;
  const eeff = (er + 1) / 2 + ((er - 1) / 2) / Math.sqrt(1 + 12 / u);
  let z0;
  if (u <= 1) {
    z0 = (ETA0 / (2 * Math.PI * Math.sqrt(eeff))) * Math.log(8 / u + u / 4);
  } else {
    z0 = ETA0 / (Math.sqrt(eeff) * (u + 1.393 + 0.667 * Math.log(u + 1.444)));
  }
  return { z0, eeff };
}

function wadellStriplineZ0(w, b, er) {
  // zero-thickness symmetric stripline, wide-strip form (w/b > 0.35)
  const weff = w / b;
  return (30 * Math.PI) / (Math.sqrt(er) * (weff + 0.441));
}

/* ---- checks ---- */
let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!cond) failures++;
};
const near = (a, b, relPct) => Math.abs(a - b) <= (Math.abs(b) * relPct) / 100;

/* 0. The solder-mask solve uses a true parallel-offset trapezoid. This is a
   geometry check before the physics checks so rectangular shoulders cannot
   silently return. The guided UI ties C1 and C3. */
{
  const p = {
    ...defaultParams('microstrip', 'diff'),
    w: 8,
    s: 8,
    h: 6,
    t: 1.6,
    etch: 0.5,
    cover: { tCopper: 0.6, tBase: 0.8, tBetween: 0.8, er: 3.8, tanD: 0.02 },
  };
  const stackup = buildPreset('microstrip', 'diff', p);
  const geometry = computeGeometry(stackup);
  const base = stackup.items.find((item) => item.id === 'coverBaseLayer');
  const shoulderItems = stackup.items
    .filter((item) => item.kind === 'TrapezoidDielectric' && item.id.startsWith('coverShoulder'))
    .sort((a, b) => a.xOffset - b.xOffset);
  const shoulderPolys = geometry.polys
    .filter((poly) => poly.kind === 'block' && poly.item?.id.startsWith('coverShoulder'))
    .sort((a, b) => a.x0 - b.x0);
  check(
    'soldermask exact C1/C3 base',
    base?.kind === 'DielectricLayer' && near(base.thickness, 0.8, 1e-8),
    `base=${base?.kind === 'DielectricLayer' ? base.thickness : 'missing'} mil`,
  );
  check(
    'soldermask exact C2 top rise',
    shoulderPolys.length === 2 && shoulderPolys.every((poly) => near(poly.y1 - p.h, p.t + 0.6, 1e-8)),
    `tops=${shoulderPolys.map((poly) => (poly.y1 - p.h).toFixed(3)).join(',')} mil`,
  );
  const conductorSideSlope = (p.w - topWidthOf(p.w, p.etch)) / (2 * p.t);
  const shoulderSideSlope = shoulderItems[0]
    ? (shoulderItems[0].bottomWidth - shoulderItems[0].topWidth) / (2 * shoulderItems[0].height)
    : NaN;
  check(
    'soldermask shoulder follows etched side',
    shoulderItems.length === 2 && near(shoulderSideSlope, conductorSideSlope, 1e-8),
    `mask slope=${shoulderSideSlope.toFixed(6)}, copper slope=${conductorSideSlope.toFixed(6)}`,
  );
  const first = shoulderItems[0];
  const topWidth = topWidthOf(p.w, p.etch);
  // Compare the shoulder top to the copper side line extrapolated through
  // the C2 miter rise (not to the copper's top corner at a lower y).
  const horizontalSeparation = first
    ? first.topWidth / 2 - (topWidth / 2 - conductorSideSlope * p.cover.tCopper)
    : NaN;
  const normalSeparation = horizontalSeparation / Math.hypot(1, conductorSideSlope);
  check(
    'soldermask side normal thickness is C2',
    near(normalSeparation, 0.6, 1e-8),
    `normal=${normalSeparation.toFixed(6)} mil`,
  );
  const xsctn = generateXsctn(stackup);
  check(
    'soldermask emitted as trapezoid solver regions',
    (xsctn.match(/TrapezoidDielectric/g) ?? []).length === 2,
    'two BEM dielectric trapezoids over the tied base layer',
  );
}

/* 1. ~50 ohm microstrip: h=10 mil, er=4.3, w=19 mil, thin trace */
{
  const { r } = await solvePreset('microstrip', 'se', (p) => ({
    ...p, w: 19, h: 10, er: 4.3, tanD: 0.02, t: 0.7, etch: 0, cover: null, cseg: 30, dseg: 30,
  }));
  const ref = hammerstadZ0(19, 10, 4.3);
  check('microstrip 50R', r.z0[0] > 47 && r.z0[0] < 53, `Z0=${r.z0[0].toFixed(2)} (band 47..53)`);
  check('microstrip vs Hammerstad-Jensen', near(r.z0[0], ref.z0, 4), `Z0=${r.z0[0].toFixed(2)} ref=${ref.z0.toFixed(2)} (4%)`);
  check('microstrip eeff', near(r.epsEff[0], ref.eeff, 6), `eeff=${r.epsEff[0].toFixed(3)} ref=${ref.eeff.toFixed(3)} (6%)`);
}

/* 2. symmetric stripline: b=20 mil, w=8.5 mil, er=4.3, near-zero thickness
   (the closed form assumes t=0; a 0.7 mil trace shifts Z0 by several %) */
{
  const t = 0.15;
  const { r } = await solvePreset('stripline', 'se', (p) => ({
    ...p, w: 8.5, h: (20 - t) / 2, h2: (20 - t) / 2, t, er: 4.3, etch: 0, cseg: 30, dseg: 30,
  }));
  const ref = wadellStriplineZ0(8.5, 20, 4.3);
  check('stripline vs closed form', near(r.z0[0], ref, 5), `Z0=${r.z0[0].toFixed(2)} ref=${ref.toFixed(2)} (5%)`);
  check('stripline eeff = er', near(r.epsEff[0], 4.3, 2), `eeff=${r.epsEff[0].toFixed(3)} (er=4.3)`);
}

/* 3. edge-coupled differential microstrip vs IPC-2141 approximation:
   Zdiff = 2 Z0 (1 - 0.48 exp(-0.96 s/h)) */
{
  const [w, s, h, er] = [7, 8, 4, 4.2];
  const { r } = await solvePreset('microstrip', 'diff', (p) => ({
    ...p, w, s, h, er, t: 0.7, etch: 0, cover: null, cseg: 30, dseg: 30,
  }));
  const zdiff = 2 * r.zOdd;
  const z0se = hammerstadZ0(w, h, er).z0;
  const ref = 2 * z0se * (1 - 0.48 * Math.exp(-0.96 * (s / h)));
  check('diff pair vs IPC-2141', near(zdiff, ref, 10), `Zdiff=${zdiff.toFixed(2)} ref=${ref.toFixed(2)} (10%)`);
  check('diff pair ~100R class', zdiff > 85 && zdiff < 115, `Zdiff=${zdiff.toFixed(2)}`);
  check('diff pair odd<even', r.zOdd < r.zEven, `odd=${r.zOdd.toFixed(2)} even=${r.zEven.toFixed(2)}`);
}

/* 4. grounded CPW: sane band + eeff between air and er */
{
  const { r } = await solvePreset('cpw', 'se', (p) => ({
    ...p, w: 12, cpwGap: 8, h: 6, er: 4.27, t: 0.7, cseg: 30, dseg: 30,
  }));
  check('gcpw Z0 sane', r.z0[0] > 30 && r.z0[0] < 90, `Z0=${r.z0[0].toFixed(2)} (band 30..90)`);
  check('gcpw eeff bounded', r.epsEff[0] > 1.5 && r.epsEff[0] < 4.27, `eeff=${r.epsEff[0].toFixed(3)}`);
}

/* 5. trapezoid == rectangle at etch=0 (regression for the wasm angle fix) */
{
  const trap = await solvePreset('microstrip', 'se', (p) => ({ ...p, etch: 0, cseg: 20, dseg: 20 }));
  check('uncovered trapezoid physical', trap.r.epsEff[0] > 2.0, `eeff=${trap.r.epsEff[0].toFixed(3)} (must be >> 1, substrate visible)`);
}

/* 5b. Exact mask regions are accepted by the production WASM and increase
   capacitance, so the coated line has lower impedance than the bare line. */
{
  const mutate = (cover) => (p) => ({
    ...p,
    w: 12,
    h: 6,
    t: 1.6,
    etch: 0.2,
    cover,
    cseg: 24,
    dseg: 24,
  });
  const mask = { tCopper: 0.6, tBase: 1.2, tBetween: 1.2, er: 3.8, tanD: 0.02 };
  const coated = await solvePreset('microstrip', 'se', mutate(mask));
  const coatedFine = await solvePreset('microstrip', 'se', (p) => ({
    ...mutate(mask)(p),
    cseg: 36,
    dseg: 36,
  }));
  const bare = await solvePreset('microstrip', 'se', mutate(null));
  check(
    'exact soldermask lowers Z0',
    coated.r.z0[0] < bare.r.z0[0],
    `coated=${coated.r.z0[0].toFixed(3)} bare=${bare.r.z0[0].toFixed(3)}`,
  );
  check(
    'exact soldermask has no orphan boundaries',
    !coated.log.includes('ORPHAN'),
    coated.log.includes('ORPHAN')
      ? coated.log.split('\n').filter((line) => line.includes('ORPHAN')).join(' | ')
      : 'all conductor edges assigned',
  );
  check(
    'exact soldermask mesh convergence',
    near(coated.r.z0[0], coatedFine.r.z0[0], 1),
    `DSEG 24=${coated.r.z0[0].toFixed(3)} DSEG 36=${coatedFine.r.z0[0].toFixed(3)} (1%)`,
  );
}

/* 6. goal seek converges to 50 ohms on microstrip */
{
  const params = { ...defaultParams('microstrip', 'se'), cseg: 20, dseg: 20 };
  let iters = 0;
  const res = await runGoalSeek(
    {
      kind: 'microstrip', variant: 'se', params, designFreqHz: 1e9,
      seekParam: 'w', mode: 'z0', target: 50,
      tolOhms: 0.25, maxIter: 24, coarseCseg: 10,
    },
    solve,
    () => iters++,
  );
  check('goal seek converged', res.ok, res.message);
  check('goal seek <= 14 solves', iters <= 14, `${iters} solves`);
}

console.log(failures === 0 ? 'ALL SANITY CHECKS PASSED' : `${failures} CHECKS FAILED`);
process.exit(failures === 0 ? 0 : 1);
