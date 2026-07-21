/**
 * Emit .xsctn text for the solver.
 *
 * The solver's parser (vendor/mmtl/bem/src/nmmtl_parse_xsctn.cpp) is a
 * hand-rolled fgets/strstr/sscanf scanner, so this generator clones the
 * dialect of the shipped fixtures (bem/tests/trap_test.xsctn) exactly:
 *  - one "-attr value" per line, backslash continuation
 *  - conductivity always carries units ("3.0e+07siemens/meter")
 *  - geometry values unitless => defaultLengthUnits applies
 *  - couplingLength is written in METERS (parser convention)
 *  - object names are program-generated; user text never reaches the file
 *    (a name containing e.g. "Rec" or "-width" would confuse strstr).
 */
import type {
  CircleDielectricItem,
  ConductorItem,
  Stackup,
  StackupItem,
} from '../model/types.ts';
import { isConductor } from '../model/types.ts';

const fmt = (v: number): string => {
  if (!Number.isFinite(v)) throw new Error(`non-finite value in stackup: ${v}`);
  return String(v);
};

/**
 * The legacy CSDL parser has no circular dielectric primitive. Three touching
 * trapezoids form a regular octagon with the requested exact X/Y diameter.
 * Finer touching-band decompositions make the legacy dielectric matrix
 * singular, so eight sides are also the solver's deliberate stability limit.
 */
export interface CircleDielectricBand {
  bottomWidth: number;
  topWidth: number;
  height: number;
  xOffset: number;
  yOffset: number;
}

export function circleDielectricBands(
  item: CircleDielectricItem,
): CircleDielectricBand[] {
  const capWidth = item.diameter * (Math.SQRT2 - 1);
  const capHeight = item.diameter * (1 - 1 / Math.SQRT2);
  const middleHeight = item.diameter * (Math.SQRT2 - 1);
  return [
    {
      bottomWidth: capWidth,
      topWidth: item.diameter,
      height: capHeight,
      xOffset: item.xOffset,
      yOffset: item.yOffset,
    },
    {
      bottomWidth: item.diameter,
      topWidth: item.diameter,
      height: middleHeight,
      xOffset: item.xOffset,
      yOffset: item.yOffset + capHeight,
    },
    {
      bottomWidth: item.diameter,
      topWidth: capWidth,
      height: capHeight,
      xOffset: item.xOffset,
      yOffset: item.yOffset + capHeight + middleHeight,
    },
  ];
}

function itemLines(item: StackupItem, idx: number): string {
  switch (item.kind) {
    case 'GroundPlane':
      return `GroundPlane G${idx} \n`;
    case 'DielectricLayer':
      return (
        `DielectricLayer D${idx}  \\\n` +
        `\t -thickness ${fmt(item.thickness)} \\\n` +
        `\t -lossTangent ${fmt(item.lossTangent)} \\\n` +
        `\t -permittivity ${fmt(item.permittivity)}\n`
      );
    case 'RectangleDielectric':
      return (
        `RectangleDielectric B${idx}  \\\n` +
        `\t -width ${fmt(item.width)} \\\n` +
        `\t -height ${fmt(item.height)} \\\n` +
        `\t -lossTangent ${fmt(item.lossTangent)} \\\n` +
        `\t -permittivity ${fmt(item.permittivity)} \\\n` +
        `\t -number 1 \\\n` +
        `\t -pitch 0 \\\n` +
        `\t -yOffset ${fmt(item.yOffset)} \\\n` +
        `\t -xOffset ${fmt(item.xOffset)}\n`
      );
    case 'TrapezoidDielectric':
      return (
        `TrapezoidDielectric B${idx}  \\\n` +
        `\t -topWidth ${fmt(item.topWidth)} \\\n` +
        `\t -bottomWidth ${fmt(item.bottomWidth)} \\\n` +
        `\t -height ${fmt(item.height)} \\\n` +
        `\t -lossTangent ${fmt(item.lossTangent)} \\\n` +
        `\t -permittivity ${fmt(item.permittivity)} \\\n` +
        `\t -number 1 \\\n` +
        `\t -pitch 0 \\\n` +
        `\t -yOffset ${fmt(item.yOffset)} \\\n` +
        `\t -xOffset ${fmt(item.xOffset)}\n`
      );
    case 'CircleDielectric':
      return circleDielectricBands(item).map((band, bandIndex) => (
        `TrapezoidDielectric B${idx}C${bandIndex + 1}  \\\n` +
        `\t -topWidth ${fmt(band.topWidth)} \\\n` +
        `\t -bottomWidth ${fmt(band.bottomWidth)} \\\n` +
        `\t -height ${fmt(band.height)} \\\n` +
        `\t -lossTangent ${fmt(item.lossTangent)} \\\n` +
        `\t -permittivity ${fmt(item.permittivity)} \\\n` +
        `\t -number ${item.number} \\\n` +
        `\t -pitch ${fmt(item.pitch)} \\\n` +
        `\t -yOffset ${fmt(band.yOffset)} \\\n` +
        `\t -xOffset ${fmt(band.xOffset)}\n`
      )).join('');
    case 'RectangleConductors': {
      const name = item.isGround ? `grFlank${idx}` : `Cond${idx}`;
      return (
        `RectangleConductors ${name}  \\\n` +
        `\t -width ${fmt(item.width)} \\\n` +
        `\t -height ${fmt(item.height)} \\\n` +
        `\t -conductivity ${item.conductivity.toExponential()}siemens/meter \\\n` +
        `\t -number ${item.number} \\\n` +
        `\t -pitch ${fmt(item.pitch)} \\\n` +
        `\t -yOffset ${fmt(item.yOffset)} \\\n` +
        `\t -xOffset ${fmt(item.xOffset)}\n`
      );
    }
    case 'TrapezoidConductors': {
      const name = item.isGround ? `grFlank${idx}` : `Trap${idx}`;
      return (
        `TrapezoidConductors ${name}  \\\n` +
        `\t -topWidth ${fmt(item.topWidth)} \\\n` +
        `\t -bottomWidth ${fmt(item.bottomWidth)} \\\n` +
        `\t -height ${fmt(item.height)} \\\n` +
        `\t -conductivity ${item.conductivity.toExponential()}siemens/meter \\\n` +
        `\t -number ${item.number} \\\n` +
        `\t -pitch ${fmt(item.pitch)} \\\n` +
        `\t -yOffset ${fmt(item.yOffset)} \\\n` +
        `\t -xOffset ${fmt(item.xOffset)}\n`
      );
    }
    case 'CircleConductors': {
      const name = item.isGround ? `grFlank${idx}` : `Circ${idx}`;
      return (
        `CircleConductors ${name}  \\\n` +
        `\t -diameter ${fmt(item.diameter)} \\\n` +
        `\t -conductivity ${item.conductivity.toExponential()}siemens/meter \\\n` +
        `\t -number ${item.number} \\\n` +
        `\t -pitch ${fmt(item.pitch)} \\\n` +
        `\t -yOffset ${fmt(item.yOffset)} \\\n` +
        `\t -xOffset ${fmt(item.xOffset)}\n`
      );
    }
  }
}

export function generateXsctn(s: Stackup): string {
  const head =
    `#----------------------------------\n` +
    `# Generated by Web-MMTL\n` +
    `#----------------------------------\n\n` +
    `package require csdl\n\n` +
    `set _title "Web-MMTL"\n` +
    `set ::Stackup::couplingLength "${s.couplingLengthM}"\n` +
    `set ::Stackup::riseTime "${s.riseTimePs}"\n` +
    `set ::Stackup::frequency "1e9"\n` +
    `set ::Stackup::defaultLengthUnits "${s.units}"\n` +
    `set CSEG ${s.cseg}\n` +
    `set DSEG ${s.dseg}\n\n`;

  const body = s.items.map((item, i) => itemLines(item, i + 1)).join('');
  return head + body;
}

export interface SolverSignalBinding {
  solverName: string;
  userName: string;
  conductor: ConductorItem;
}

/**
 * Reconstruct the low-level signal names created by the CSDL conductor-set
 * objects. Solver result order is not stackup order, so consumers must join by
 * these names rather than zip arrays by index.
 */
export function solverSignalBindings(s: Stackup): SolverSignalBinding[] {
  const out: SolverSignalBinding[] = [];
  let signalOrdinal = 0;
  s.items.forEach((item, zeroBasedIndex) => {
    if (!isConductor(item) || item.isGround) return;
    const idx = zeroBasedIndex + 1;
    const [base, type] =
      item.kind === 'RectangleConductors'
        ? [`Cond${idx}`, 'R']
        : item.kind === 'TrapezoidConductors'
          ? [`Trap${idx}`, 'T']
          : [`Circ${idx}`, 'C'];
    for (let member = 0; member < item.number; member++) {
      out.push({
        solverName: `${base}${type}${signalOrdinal}`,
        userName: item.number > 1 ? `${item.id}[${member + 1}]` : item.id,
        conductor: item,
      });
      signalOrdinal++;
    }
  });
  return out;
}

/** Basic validity checks mirroring solver requirements; returns error strings. */
export function validateStackup(s: Stackup): string[] {
  const errs: string[] = [];
  const grounds = s.items.filter((i) => i.kind === 'GroundPlane').length;
  const explicitGrounds = s.items
    .filter((i): i is ConductorItem => isConductor(i) && i.isGround)
    .reduce((count, conductor) => count + conductor.number, 0);
  const signals = s.items.filter(
    (i): i is ConductorItem => isConductor(i) && !i.isGround,
  );
  const signalMembers = signals.reduce(
    (count, conductor) => count + conductor.number,
    0,
  );
  const floatingPair =
    grounds === 0 &&
    explicitGrounds === 0 &&
    signals.every(
      (conductor) => Number.isInteger(conductor.number) && conductor.number >= 1,
    ) &&
    signalMembers === 2;
  if (grounds < 1 && explicitGrounds < 1 && !floatingPair) {
    errs.push(
      'Add a bottom ground plane, at least one explicit ground conductor, or exactly two signal conductors for a floating pair.',
    );
  }
  if (grounds > 2) errs.push('At most 2 ground planes are supported (bottom and top).');
  if (signals.length === 0) errs.push('Add at least one signal conductor set.');
  if (grounds > 0 && s.items.length > 0 && s.items[0].kind !== 'GroundPlane')
    errs.push('The first (bottom) item must be a ground plane.');
  const layerCount = s.items.filter((i) => i.kind === 'DielectricLayer').length;
  if (grounds > 0 && layerCount === 0) {
    errs.push('Add at least one dielectric layer.');
  }
  for (const it of s.items) {
    if (it.kind === 'DielectricLayer' && it.thickness <= 0)
      errs.push('Dielectric thickness must be > 0.');
    if (it.kind === 'RectangleDielectric' && (it.width <= 0 || it.height <= 0))
      errs.push('Dielectric rectangle width/height must be > 0.');
    if (it.kind === 'RectangleConductors' && (it.width <= 0 || it.height <= 0))
      errs.push('Conductor width/height must be > 0.');
    if (it.kind === 'TrapezoidConductors' && (it.topWidth <= 0 || it.bottomWidth <= 0 || it.height <= 0))
      errs.push('Trapezoid widths/height must be > 0.');
    if (it.kind === 'TrapezoidDielectric' && (it.topWidth <= 0 || it.bottomWidth <= 0 || it.height <= 0))
      errs.push('Dielectric trapezoid widths/height must be > 0.');
    if (it.kind === 'CircleDielectric' && it.diameter <= 0)
      errs.push('Dielectric circle diameter must be > 0.');
    if (it.kind === 'CircleConductors' && it.diameter <= 0)
      errs.push('Circle diameter must be > 0.');
    if (
      (it.kind === 'DielectricLayer' ||
        it.kind === 'RectangleDielectric' ||
        it.kind === 'TrapezoidDielectric' ||
        it.kind === 'CircleDielectric') &&
      (!Number.isFinite(it.permittivity) || it.permittivity <= 0)
    ) {
      errs.push('Dielectric permittivity must be finite and > 0.');
    }
    if (
      (it.kind === 'DielectricLayer' ||
        it.kind === 'RectangleDielectric' ||
        it.kind === 'TrapezoidDielectric' ||
        it.kind === 'CircleDielectric') &&
      (!Number.isFinite(it.lossTangent) || it.lossTangent < 0)
    ) {
      errs.push('Dielectric loss tangent must be finite and >= 0.');
    }
    if (isConductor(it) && (!Number.isInteger(it.number) || it.number < 1))
      errs.push('Conductor count must be a positive integer.');
    if (isConductor(it) && it.number > 1 && it.pitch <= 0)
      errs.push('Conductor sets with number > 1 need a positive pitch.');
    if (it.kind === 'CircleDielectric' && (!Number.isInteger(it.number) || it.number < 1))
      errs.push('Dielectric circle count must be a positive integer.');
    if (it.kind === 'CircleDielectric' && it.number > 1 && it.pitch <= 0)
      errs.push('Dielectric circle sets with number > 1 need a positive pitch.');
  }
  return errs;
}
