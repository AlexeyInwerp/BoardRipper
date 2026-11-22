import type { Part } from '../parsers/types';

export type MetaRow = [label: string, value: string];

/** Exporter placeholders that name nothing: `Device2949`, `DEV_298`. */
const PLACEHOLDER = /^(device|dev_?)\d+$/i;

const norm = (s: string) => s.toLowerCase().replace(/[\s_\-./,]+/g, '');

/**
 * Component Info's metadata, split in two. `main` holds what helps a repair —
 * the value, the part number, a description — and only when it says
 * something: a value that repeats the refdes or the package, an exporter
 * placeholder, or a part number / description that repeats the value is moved
 * to `more`. `more` holds everything else the file carried (package, type,
 * sheet, height, rotation), shown behind a disclosure.
 */
export function splitPartMeta(part: Pick<Part, 'name' | 'meta' | 'angleDeg'>): { main: MetaRow[]; more: MetaRow[] } {
  const m = part.meta ?? {};
  const main: MetaRow[] = [];
  const more: MetaRow[] = [];
  const shown: string[] = [];
  const says = (v: string, ...same: Array<string | undefined>) =>
    !PLACEHOLDER.test(v.trim()) && !same.some(s => s && norm(s) === norm(v)) && !shown.some(s => norm(s) === norm(v));

  const put = (label: string, v: string | undefined, ...same: Array<string | undefined>) => {
    if (!v) return;
    if (says(v, ...same)) { main.push([label, v]); shown.push(v); }
    else more.push([label, v]);
  };
  put('Value', m.value, part.name, m.package);
  put('Part number', m.serial, part.name);
  put('Description', m.description, part.name);

  if (m.package) more.push(['Package', m.package]);
  if (m.partType) more.push(['Type', m.partType]);
  if (m.sheet) more.push(['Sheet', m.sheet]);
  if (m.heightMils != null) more.push(['Height', `${m.heightMils.toFixed(2)} mils`]);
  const angle = m.angleDeg ?? part.angleDeg;
  if (angle != null) more.push(['Rotation', `${angle}°`]);
  return { main, more };
}
