/**
 * Free-form TNT-style stackup editor: ordered item list (bottom -> top),
 * add/duplicate/delete/move, per-type parameter forms, live validation.
 */
import type {
  ConductorItem,
  StackupItem,
} from '../model/types.ts';
import { isConductor, signalCount } from '../model/types.ts';
import { validateStackup } from '../xsctn/generate.ts';
import { store } from '../model/store.ts';
import { bindDimFields, dimFieldHtml, retargetDimFields, type DimUnit } from './dimField.ts';

let uid = 1;
const newId = () => `it${Date.now().toString(36)}${uid++}`;

const TEMPLATES: Array<{ label: string; make: () => StackupItem }> = [
  { label: 'Ground plane', make: () => ({ kind: 'GroundPlane', id: newId() }) },
  {
    label: 'Dielectric layer',
    make: () => ({ kind: 'DielectricLayer', id: newId(), thickness: 5, permittivity: 4.27, lossTangent: 0.016 }),
  },
  {
    label: 'Dielectric block',
    make: () => ({ kind: 'RectangleDielectric', id: newId(), width: 20, height: 3, permittivity: 3.8, xOffset: 0, yOffset: 0 }),
  },
  {
    label: 'Trapezoid dielectric',
    make: () => ({
      kind: 'TrapezoidDielectric', id: newId(), topWidth: 18, bottomWidth: 20,
      height: 3, permittivity: 3.8, xOffset: 0, yOffset: 0,
    }),
  },
  {
    label: 'Rectangle conductors',
    make: () => ({
      kind: 'RectangleConductors', id: newId(), isGround: false, conductivity: 5e7,
      number: 1, pitch: 0, xOffset: 0, yOffset: 0, width: 10, height: 1.4,
    }),
  },
  {
    label: 'Trapezoid conductors',
    make: () => ({
      kind: 'TrapezoidConductors', id: newId(), isGround: false, conductivity: 5e7,
      number: 1, pitch: 0, xOffset: 0, yOffset: 0, topWidth: 9, bottomWidth: 10, height: 1.4,
    }),
  },
  {
    label: 'Circular conductors',
    make: () => ({
      kind: 'CircleConductors', id: newId(), isGround: false, conductivity: 5e7,
      number: 1, pitch: 0, xOffset: 0, yOffset: 0, diameter: 5,
    }),
  },
];

const KIND_LABEL: Record<StackupItem['kind'], string> = {
  GroundPlane: 'Ground plane',
  DielectricLayer: 'Dielectric layer',
  RectangleDielectric: 'Dielectric block',
  TrapezoidDielectric: 'Trapezoid dielectric',
  RectangleConductors: 'Rect conductors',
  TrapezoidConductors: 'Trap conductors',
  CircleConductors: 'Circle conductors',
};

interface FieldSpec {
  key: string;
  label: string;
  /** dimension fields get unit handling; plain fields are bare numbers */
  dim?: boolean;
}

function fieldsFor(item: StackupItem): FieldSpec[] {
  switch (item.kind) {
    case 'GroundPlane':
      return [];
    case 'DielectricLayer':
      return [
        { key: 'thickness', label: 'Thickness', dim: true },
        { key: 'permittivity', label: 'Permittivity εr' },
        { key: 'lossTangent', label: 'Loss Tangent' },
      ];
    case 'RectangleDielectric':
      return [
        { key: 'width', label: 'Width', dim: true },
        { key: 'height', label: 'Height', dim: true },
        { key: 'permittivity', label: 'Permittivity εr' },
        { key: 'xOffset', label: 'X Offset', dim: true },
        { key: 'yOffset', label: 'Y Offset', dim: true },
      ];
    case 'TrapezoidDielectric':
      return [
        { key: 'bottomWidth', label: 'Bottom Width', dim: true },
        { key: 'topWidth', label: 'Top Width', dim: true },
        { key: 'height', label: 'Height', dim: true },
        { key: 'permittivity', label: 'Permittivity Îµr' },
        { key: 'xOffset', label: 'X Offset', dim: true },
        { key: 'yOffset', label: 'Y Offset', dim: true },
      ];
    case 'RectangleConductors':
      return [
        { key: 'width', label: 'Width', dim: true },
        { key: 'height', label: 'Height', dim: true },
        { key: 'number', label: 'Count' },
        { key: 'pitch', label: 'Pitch', dim: true },
        { key: 'xOffset', label: 'X Offset', dim: true },
        { key: 'yOffset', label: 'Y Offset', dim: true },
        { key: 'conductivity', label: 'Conductivity (S/m)' },
      ];
    case 'TrapezoidConductors':
      return [
        { key: 'bottomWidth', label: 'Bottom Width', dim: true },
        { key: 'topWidth', label: 'Top Width', dim: true },
        { key: 'height', label: 'Height', dim: true },
        { key: 'number', label: 'Count' },
        { key: 'pitch', label: 'Pitch', dim: true },
        { key: 'xOffset', label: 'X Offset', dim: true },
        { key: 'yOffset', label: 'Y Offset', dim: true },
        { key: 'conductivity', label: 'Conductivity (S/m)' },
      ];
    case 'CircleConductors':
      return [
        { key: 'diameter', label: 'Diameter', dim: true },
        { key: 'number', label: 'Count' },
        { key: 'pitch', label: 'Pitch', dim: true },
        { key: 'xOffset', label: 'X Offset', dim: true },
        { key: 'yOffset', label: 'Y Offset', dim: true },
        { key: 'conductivity', label: 'Conductivity (S/m)' },
      ];
  }
}

export function renderStackupEditor(container: HTMLElement) {
  const s = store.get();
  const st = s.freeform;
  const unit = s.displayUnit as DimUnit;
  const errors = validateStackup(st);
  const nSignals = signalCount(st);

  const itemCard = (item: StackupItem, i: number): string => {
    const fields = fieldsFor(item)
      .map((f) => {
        const value = (item as unknown as Record<string, number>)[f.key];
        if (f.dim) {
          return dimFieldHtml({
            id: `sk-${i}-${f.key}`,
            label: f.label,
            mils: value,
            unit,
            colClass: 'col-4 col-xl-3',
          });
        }
        return `
        <div class="col-4 col-xl-3">
          <label class="form-label mb-0 tiny">${f.label}</label>
          <input type="number" step="any" class="form-control form-control-sm sk-field"
                 data-idx="${i}" data-key="${f.key}"
                 value="${value}">
        </div>`;
      })
      .join('');
    const groundToggle = isConductor(item)
      ? `<div class="form-check form-check-inline ms-2 mb-0">
          <input class="form-check-input sk-ground" type="checkbox" data-idx="${i}" ${item.isGround ? 'checked' : ''}>
          <label class="form-check-label tiny">ground wires</label>
        </div>`
      : '';
    return `
    <div class="list-group-item px-2 py-2">
      <div class="d-flex align-items-center gap-1">
        <span class="badge text-bg-${item.kind === 'GroundPlane' ? 'secondary' : isConductor(item) ? (item.isGround ? 'secondary' : 'warning') : 'info'}">${KIND_LABEL[item.kind]}</span>
        ${groundToggle}
        <div class="ms-auto btn-group btn-group-sm">
          <button class="btn btn-outline-secondary sk-up" data-idx="${i}" title="move down in stack (earlier in file)" ${i === 0 ? 'disabled' : ''}>↓</button>
          <button class="btn btn-outline-secondary sk-down" data-idx="${i}" title="move up in stack" ${i === st.items.length - 1 ? 'disabled' : ''}>↑</button>
          <button class="btn btn-outline-secondary sk-dup" data-idx="${i}" title="duplicate">⧉</button>
          <button class="btn btn-outline-danger sk-del" data-idx="${i}" title="delete">✕</button>
        </div>
      </div>
      ${fields ? `<div class="row g-1 mt-1">${fields}</div>` : ''}
    </div>`;
  };

  // draw top of stack first (visually top = last item)
  const cards = st.items.map((it, i) => ({ html: itemCard(it, i), i })).reverse();

  container.innerHTML = `
    <div class="d-flex align-items-center gap-2 mb-2 flex-wrap">
      <div class="dropdown">
        <button class="btn btn-sm btn-primary dropdown-toggle" data-bs-toggle="dropdown">Add item</button>
        <ul class="dropdown-menu">
          ${TEMPLATES.map((t, i) => `<li><a class="dropdown-item sk-add" data-tpl="${i}" href="#">${t.label}</a></li>`).join('')}
        </ul>
      </div>
      <select class="form-select form-select-sm w-auto" id="sk-units" title="display units (each field's unit button also cycles; typing 1mm / 35um converts)">
        ${(['mils', 'mm', 'um', 'inch'] as DimUnit[]).map((u) => `<option value="${u}" ${u === unit ? 'selected' : ''}>${u === 'um' ? 'µm' : u === 'inch' ? 'in' : u}</option>`).join('')}
      </select>
      <span class="badge text-bg-${nSignals === 0 ? 'danger' : 'primary'}">${nSignals} signal conductor${nSignals === 1 ? '' : 's'}</span>
      ${nSignals === 2 ? '<span class="badge text-bg-success">odd/even &amp; Zdiff available</span>' : ''}
      <span class="tiny text-body-secondary ms-auto">top of board ↑, list order = stackup order</span>
    </div>
    ${errors.length ? `<div class="alert alert-warning py-2 small">${errors.join('<br>')}</div>` : ''}
    <div class="list-group">${cards.map((c) => c.html).join('')}</div>
    <div class="row g-2 mt-1">
      <div class="col-6"><label class="tiny form-label mb-0">CSEG</label>
        <input type="number" class="form-control form-control-sm" id="sk-cseg" value="${st.cseg}"></div>
      <div class="col-6"><label class="tiny form-label mb-0">DSEG</label>
        <input type="number" class="form-control form-control-sm" id="sk-dseg" value="${st.dseg}"></div>
    </div>
  `;

  const setItems = (items: StackupItem[]) =>
    store.update({ freeform: { ...store.get().freeform, items } });

  container.querySelectorAll<HTMLAnchorElement>('.sk-add').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const tpl = TEMPLATES[parseInt(a.dataset.tpl!, 10)];
      setItems([...store.get().freeform.items, tpl.make()]);
    }),
  );
  container.querySelectorAll<HTMLButtonElement>('.sk-del').forEach((b) =>
    b.addEventListener('click', () => {
      const items = [...store.get().freeform.items];
      items.splice(parseInt(b.dataset.idx!, 10), 1);
      setItems(items);
    }),
  );
  container.querySelectorAll<HTMLButtonElement>('.sk-dup').forEach((b) =>
    b.addEventListener('click', () => {
      const items = [...store.get().freeform.items];
      const i = parseInt(b.dataset.idx!, 10);
      items.splice(i + 1, 0, { ...items[i], id: newId() });
      setItems(items);
    }),
  );
  const move = (i: number, dir: -1 | 1) => {
    const items = [...store.get().freeform.items];
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
    setItems(items);
  };
  container.querySelectorAll<HTMLButtonElement>('.sk-up').forEach((b) =>
    b.addEventListener('click', () => move(parseInt(b.dataset.idx!, 10), -1)),
  );
  container.querySelectorAll<HTMLButtonElement>('.sk-down').forEach((b) =>
    b.addEventListener('click', () => move(parseInt(b.dataset.idx!, 10), 1)),
  );
  container.querySelectorAll<HTMLInputElement>('.sk-field').forEach((inp) =>
    inp.addEventListener('change', () => {
      const items = [...store.get().freeform.items];
      const i = parseInt(inp.dataset.idx!, 10);
      const v = parseFloat(inp.value);
      if (!Number.isFinite(v)) return;
      const key = inp.dataset.key!;
      items[i] = { ...items[i], [key]: key === 'number' ? Math.max(1, Math.round(v)) : v } as StackupItem;
      setItems(items);
    }),
  );
  // dimension fields: id pattern sk-<itemIdx>-<key>, canonical mils
  bindDimFields(container, {
    onChange: (id, mils) => {
      const m = id.match(/^sk-(\d+)-(.+)$/);
      if (!m) return;
      const items = [...store.get().freeform.items];
      const i = parseInt(m[1], 10);
      items[i] = { ...items[i], [m[2]]: mils } as StackupItem;
      setItems(items);
    },
  });
  container.querySelectorAll<HTMLInputElement>('.sk-ground').forEach((inp) =>
    inp.addEventListener('change', () => {
      const items = [...store.get().freeform.items];
      const i = parseInt(inp.dataset.idx!, 10);
      items[i] = { ...(items[i] as ConductorItem), isGround: inp.checked };
      setItems(items);
    }),
  );
  (container.querySelector('#sk-units') as HTMLSelectElement).addEventListener('change', (e) => {
    const u = (e.target as HTMLSelectElement).value as DimUnit;
    store.update({ displayUnit: u });
    retargetDimFields(container, u);
  });
  (container.querySelector('#sk-cseg') as HTMLInputElement).addEventListener('change', (e) =>
    store.update({
      freeform: { ...store.get().freeform, cseg: Math.min(Math.max(parseInt((e.target as HTMLInputElement).value, 10) || 10, 4), 100) },
    }),
  );
  (container.querySelector('#sk-dseg') as HTMLInputElement).addEventListener('change', (e) =>
    store.update({
      freeform: { ...store.get().freeform, dseg: Math.min(Math.max(parseInt((e.target as HTMLInputElement).value, 10) || 10, 4), 100) },
    }),
  );
}
