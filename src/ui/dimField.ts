/**
 * Dimension input fields with per-field display units.
 *
 * - The MODEL value is always canonical mils (the .xsctn is emitted in mils).
 * - Every field carries its own display unit; clicking the unit suffix
 *   cycles mils -> mm -> um -> inch. The global units dropdown re-targets
 *   all fields at once.
 * - Typing a value with a unit ("1mm", "35 um", "0.1in") converts
 *   transparently into the field's display unit and the canonical model.
 */

export type DimUnit = 'mils' | 'mm' | 'um' | 'inch';

export const UNIT_CYCLE: DimUnit[] = ['mils', 'mm', 'um', 'inch'];

/** mils per unit */
const TO_MILS: Record<DimUnit, number> = {
  mils: 1,
  mm: 39.37007874015748,
  um: 0.03937007874015748,
  inch: 1000,
};

const UNIT_LABEL: Record<DimUnit, string> = {
  mils: 'mils',
  mm: 'mm',
  um: 'µm',
  inch: 'in',
};

/** aliases accepted when typing */
const PARSE_UNITS: Record<string, DimUnit> = {
  mil: 'mils',
  mils: 'mils',
  thou: 'mils',
  mm: 'mm',
  millimeter: 'mm',
  millimeters: 'mm',
  um: 'um',
  µm: 'um',
  micron: 'um',
  microns: 'um',
  micrometer: 'um',
  in: 'inch',
  inch: 'inch',
  inches: 'inch',
  '"': 'inch',
};

export function toDisplay(mils: number, unit: DimUnit): number {
  return mils / TO_MILS[unit];
}

export function formatDim(mils: number, unit: DimUnit): string {
  const v = toDisplay(mils, unit);
  if (v === 0) return '0';
  const a = Math.abs(v);
  const digits = a >= 100 ? 1 : a >= 10 ? 2 : a >= 1 ? 3 : 4;
  return String(parseFloat(v.toFixed(digits)));
}

/**
 * Parse user input, honoring an optional unit suffix; returns canonical mils.
 * Bare numbers are interpreted in the field's display unit.
 */
export function parseDim(text: string, displayUnit: DimUnit): number | null {
  const m = text
    .trim()
    .match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*([a-zA-Zµ"]*)\s*$/);
  if (!m) return null;
  const num = parseFloat(m[1]);
  if (!Number.isFinite(num)) return null;
  const suffix = m[2].toLowerCase().replace('µ', 'µ');
  const unit = suffix ? PARSE_UNITS[suffix] ?? PARSE_UNITS[m[2]] : displayUnit;
  if (!unit) return null; // unrecognized unit suffix
  return num * TO_MILS[unit];
}

export interface DimFieldOpts {
  id: string;
  label: string;
  /** canonical value in mils */
  mils: number;
  unit: DimUnit;
  min?: number; // canonical mils
  colClass?: string;
}

/** render markup; call bindDimFields() on the container afterwards */
export function dimFieldHtml(o: DimFieldOpts): string {
  return `
    <div class="${o.colClass ?? 'col-6 col-xxl-4'}">
      <label class="form-label mb-0 small" for="${o.id}">${o.label}</label>
      <div class="input-group input-group-sm">
        <input type="text" inputmode="decimal" autocomplete="off" spellcheck="false"
               class="form-control dim-field" id="${o.id}"
               data-mils="${o.mils}" data-unit="${o.unit}" ${o.min != null ? `data-min="${o.min}"` : ''}
               value="${formatDim(o.mils, o.unit)}">
        <button type="button" class="input-group-text dim-unit" tabindex="-1"
                title="click to change units (you can also type e.g. 1mm or 35um)">${UNIT_LABEL[o.unit]}</button>
      </div>
    </div>`;
}

export interface DimBinding {
  /** called with the new canonical mils value after a successful edit */
  onChange: (id: string, mils: number) => void;
  /** called when a field's display unit changes (persist if desired) */
  onUnitChange?: (id: string, unit: DimUnit) => void;
}

export function bindDimFields(container: HTMLElement, binding: DimBinding) {
  container.querySelectorAll<HTMLInputElement>('input.dim-field').forEach((input) => {
    const unitBtn = input.parentElement!.querySelector<HTMLButtonElement>('.dim-unit')!;

    const commit = () => {
      const unit = input.dataset.unit as DimUnit;
      const parsed = parseDim(input.value, unit);
      if (parsed == null) {
        // revert to last good value
        input.value = formatDim(parseFloat(input.dataset.mils!), unit);
        input.classList.add('is-invalid');
        setTimeout(() => input.classList.remove('is-invalid'), 800);
        return;
      }
      const min = input.dataset.min != null ? parseFloat(input.dataset.min) : -Infinity;
      const mils = Math.max(parsed, min);
      input.dataset.mils = String(mils);
      input.value = formatDim(mils, unit); // normalize (e.g. "1mm" -> mm-display or mils-display)
      binding.onChange(input.id, mils);
    };

    input.addEventListener('change', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
    });

    unitBtn.addEventListener('click', () => {
      const cur = input.dataset.unit as DimUnit;
      const next = UNIT_CYCLE[(UNIT_CYCLE.indexOf(cur) + 1) % UNIT_CYCLE.length];
      input.dataset.unit = next;
      unitBtn.textContent = UNIT_LABEL[next];
      input.value = formatDim(parseFloat(input.dataset.mils!), next);
      binding.onUnitChange?.(input.id, next);
    });
  });
}

/** update all fields in a container to one display unit (global dropdown) */
export function retargetDimFields(container: HTMLElement, unit: DimUnit) {
  container.querySelectorAll<HTMLInputElement>('input.dim-field').forEach((input) => {
    input.dataset.unit = unit;
    const btn = input.parentElement!.querySelector<HTMLButtonElement>('.dim-unit');
    if (btn) btn.textContent = UNIT_LABEL[unit];
    input.value = formatDim(parseFloat(input.dataset.mils!), unit);
  });
}
