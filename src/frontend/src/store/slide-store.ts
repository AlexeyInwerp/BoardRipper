/** Slide mode — mark up the current board view and save it as a PNG.
 *
 *  Annotations (arrow, rectangle, text) live in BOARD space — the top root's
 *  local coordinates — so they stay on the parts while the user pans, zooms
 *  or rotates. Stroke width and text size are screen px, so a note stays
 *  legible at any zoom. Kept per board tab for the session; not persisted.
 *
 *  The mode itself is a session toggle (ribbon slot `slides`), like
 *  Interactive Mode. While it is on the board's primary-button drag draws
 *  with the current tool; wheel zoom, pinch and the other buttons still pan. */
import { Emitter } from './emitter';

export type SlideTool = 'select' | 'arrow' | 'rect' | 'text' | 'pen';

export interface Pt { x: number; y: number }

export interface Annotation {
  id: number;
  kind: 'arrow' | 'rect' | 'text' | 'ink';
  /** Board-space anchor: arrow tail, rect corner, text top-left. */
  a: Pt;
  /** Board-space second point: arrow head, opposite rect corner (unused for text). */
  b: Pt;
  color: string;
  /** Stroke width (arrow/rect) or font size (text), screen px. */
  size: number;
  text?: string;
  /** Freehand stroke, board space (kind 'ink'). `a`/`b` are unused there. */
  points?: Pt[];
}

/** Readings drafted onto a part for the slide (free text, as typed). */
export interface PartReadings { ohm: string; diode: string }

export const SLIDE_COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#ffffff'] as const;
export const STROKE_SIZES = [2, 4, 7] as const;
export const TEXT_SIZES = [14, 20, 30] as const;

export interface SlideSnapshot {
  enabled: boolean;
  tool: SlideTool;
  color: string;
  /** Index into STROKE_SIZES / TEXT_SIZES — one "weight" picker for both. */
  weight: number;
  selectedId: number | null;
  /** Taps on parts add them to / remove them from the multi-selection. */
  multi: boolean;
  /** Bumped on every annotation change, so views can key a redraw on it. */
  rev: number;
}

class SlideStore extends Emitter {
  private _enabled = false;
  private _tool: SlideTool = 'arrow';
  private _color: string = SLIDE_COLORS[0];
  private _weight = 1;
  private _selectedId: number | null = null;
  private _multi = false;
  private readingsByTab = new Map<number, Map<string, PartReadings>>();
  private _rev = 0;
  private nextId = 1;
  private byTab = new Map<number, Annotation[]>();
  private undoByTab = new Map<number, Annotation[][]>();
  private _snapshot: SlideSnapshot = this.make();

  private make(): SlideSnapshot {
    return { enabled: this._enabled, tool: this._tool, color: this._color, weight: this._weight, selectedId: this._selectedId, multi: this._multi, rev: this._rev };
  }
  private changed() { this._snapshot = this.make(); this.notify(); }

  snapshot(): SlideSnapshot { return this._snapshot; }
  get enabled() { return this._enabled; }
  get tool() { return this._tool; }
  get color() { return this._color; }
  get selectedId() { return this._selectedId; }
  get multi() { return this._multi; }
  setMulti(v: boolean) { if (this._multi !== v) { this._multi = v; this.changed(); } }

  /** Drafted Ω / diode readings for a part, by refdes. */
  readings(tabId: number, part: string): PartReadings | undefined {
    return this.readingsByTab.get(tabId)?.get(part);
  }
  setReading(tabId: number, part: string, key: keyof PartReadings, value: string) {
    let m = this.readingsByTab.get(tabId);
    if (!m) { m = new Map(); this.readingsByTab.set(tabId, m); }
    const cur = m.get(part) ?? { ohm: '', diode: '' };
    if (cur[key] === value) return;
    const next = { ...cur, [key]: value };
    if (!next.ohm && !next.diode) m.delete(part); else m.set(part, next);
    this._rev++;
    this.changed();
  }
  strokeSize() { return STROKE_SIZES[this._weight]; }
  textSize() { return TEXT_SIZES[this._weight]; }

  setEnabled(v: boolean) {
    if (this._enabled === v) return;
    this._enabled = v;
    this._selectedId = null;
    this.changed();
  }
  toggle() { this.setEnabled(!this._enabled); }

  setTool(t: SlideTool) { this._tool = t; if (t !== 'select') this._selectedId = null; this.changed(); }

  /** Picking a colour or weight also restyles the selected annotation. */
  setColor(c: string) {
    this._color = c;
    if (this._selectedId !== null) this.restyleSelected({ color: c });
    this.changed();
  }
  setWeight(w: number) {
    this._weight = Math.max(0, Math.min(STROKE_SIZES.length - 1, w));
    const sel = this.findSelected();
    if (sel) this.restyleSelected({ size: sel.kind === 'text' ? TEXT_SIZES[this._weight] : STROKE_SIZES[this._weight] });
    this.changed();
  }
  private findSelected(): Annotation | undefined {
    if (this._selectedId === null) return undefined;
    for (const list of this.byTab.values()) {
      const ann = list.find(x => x.id === this._selectedId);
      if (ann) return ann;
    }
    return undefined;
  }
  private restyleSelected(patch: Partial<Annotation>) {
    for (const [tab, list] of this.byTab) {
      const i = list.findIndex(x => x.id === this._selectedId);
      if (i < 0) continue;
      this.pushUndo(tab);
      const next = list.slice();
      next[i] = { ...next[i], ...patch };
      this.byTab.set(tab, next);
      this._rev++;
    }
  }

  select(id: number | null) {
    if (this._selectedId === id) return;
    this._selectedId = id;
    this.changed();
  }

  list(tabId: number): readonly Annotation[] { return this.byTab.get(tabId) ?? []; }

  private pushUndo(tabId: number) {
    const stack = this.undoByTab.get(tabId) ?? [];
    stack.push(this.byTab.get(tabId) ?? []);
    if (stack.length > 100) stack.shift();
    this.undoByTab.set(tabId, stack);
  }

  add(tabId: number, ann: Omit<Annotation, 'id'>): number {
    this.pushUndo(tabId);
    const id = this.nextId++;
    this.byTab.set(tabId, [...this.list(tabId), { ...ann, id }]);
    this._rev++;
    this.changed();
    return id;
  }

  /** Replace one annotation. `recordUndo: false` for the frames of a drag —
   *  the drag records one undo step when it starts. */
  update(tabId: number, id: number, patch: Partial<Annotation>, recordUndo = true) {
    const list = this.list(tabId);
    const i = list.findIndex(x => x.id === id);
    if (i < 0) return;
    if (recordUndo) this.pushUndo(tabId);
    const next = list.slice();
    next[i] = { ...next[i], ...patch, id };
    this.byTab.set(tabId, next);
    this._rev++;
    this.changed();
  }

  /** Record an undo step without changing anything (start of a drag). */
  checkpoint(tabId: number) { this.pushUndo(tabId); }

  remove(tabId: number, id: number) {
    const list = this.list(tabId);
    if (!list.some(x => x.id === id)) return;
    this.pushUndo(tabId);
    this.byTab.set(tabId, list.filter(x => x.id !== id));
    if (this._selectedId === id) this._selectedId = null;
    this._rev++;
    this.changed();
  }

  /** Take back an annotation that was just added and never became anything
   *  (a click without a drag): gone, and its undo step with it. */
  abandon(tabId: number, id: number) {
    const list = this.list(tabId);
    if (list[list.length - 1]?.id !== id) { this.remove(tabId, id); return; }
    this.byTab.set(tabId, list.slice(0, -1));
    this.undoByTab.get(tabId)?.pop();
    if (this._selectedId === id) this._selectedId = null;
    this._rev++;
    this.changed();
  }

  clear(tabId: number) {
    if (!this.list(tabId).length) return;
    this.pushUndo(tabId);
    this.byTab.set(tabId, []);
    this._selectedId = null;
    this._rev++;
    this.changed();
  }

  undo(tabId: number): boolean {
    const stack = this.undoByTab.get(tabId);
    if (!stack?.length) return false;
    this.byTab.set(tabId, stack.pop()!);
    this._selectedId = null;
    this._rev++;
    this.changed();
    return true;
  }

  canUndo(tabId: number) { return (this.undoByTab.get(tabId)?.length ?? 0) > 0; }

  /** A closed tab's annotations go with it. */
  dropTab(tabId: number) { this.byTab.delete(tabId); this.undoByTab.delete(tabId); this.readingsByTab.delete(tabId); }
}

export const slideStore = new SlideStore();

if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot!.invalidate());
}

if (typeof window !== 'undefined' && import.meta.env.DEV) {
  (window as { __slideStore?: typeof slideStore }).__slideStore = slideStore;
}
