// src/frontend/src/store/overlay-layout.ts
/**
 * BoardViewer overlay slot model — single source of truth for the slot
 * registry, its labels, the default order, the pure edit operations, and
 * persistence reconciliation.
 *
 * The overlay (the floating row of buttons on the board canvas — "the
 * ribbon") is rendered by walking `OverlaySlot[]` and looking each id up in
 * slot-renderers.tsx. It is editable in two places that share this module:
 * right-click on the ribbon (show/hide, position, fold, reset) and
 * Settings ▸ Board ▸ Board overlay (order, visibility, separators).
 *
 * Adding a new slot:
 *   1. add the id to NamedSlotId and NAMED_SLOT_IDS
 *   2. add its label to SLOT_LABELS
 *   3. add it to DEFAULT_OVERLAY_LAYOUT where it belongs
 *   4. add a renderer entry in slot-renderers.tsx
 * `reconcileOverlayLayout` places it into existing users' saved layouts at
 * the position the default gives it (after its nearest default neighbour
 * that the user still has), not at the end.
 */

/** The fixed-name slots (one button each). Separator slots use the
 *  open-ended `sep${number}` ids — see `isSeparatorId` below. */
export type NamedSlotId =
  | 'sideSwitch' | 'butterfly' | 'rotateCCW' | 'rotateCW' | 'transformMenu'
  | 'pdfFollow' | 'scrollMode' | 'fitBoard'
  | 'hoverInfo' | 'netDim' | 'netLines' | 'ghosts' | 'diodeValues' | 'traces'
  | 'partsDropdown' | 'netsDropdown';

export type SeparatorSlotId = `sep${number}`;
export type OverlaySlotId = NamedSlotId | SeparatorSlotId;

export interface OverlaySlot { id: OverlaySlotId; visible: boolean }

const NAMED_SLOT_IDS: ReadonlySet<NamedSlotId> = new Set([
  'sideSwitch', 'butterfly', 'rotateCCW', 'rotateCW', 'transformMenu',
  'pdfFollow', 'scrollMode', 'fitBoard',
  'hoverInfo', 'netDim', 'netLines', 'ghosts', 'diodeValues', 'traces',
  'partsDropdown', 'netsDropdown',
]);

/** Human names, used by the ribbon's right-click menu and the Settings
 *  editor. Short, noun-first, no trailing state ("Hover info", not
 *  "Hover info: ON" — the button's own title carries the state). */
export const SLOT_LABELS: Readonly<Record<NamedSlotId, string>> = {
  sideSwitch:    'Side',
  butterfly:     'Butterfly',
  rotateCCW:     'Rotate left',
  rotateCW:      'Rotate right',
  transformMenu: 'More transforms',
  traces:        'Traces',
  pdfFollow:     'Follow PDF',
  scrollMode:    'Scroll mode',
  fitBoard:      'Fit board',
  hoverInfo:     'Hover info',
  netDim:        'Spotlight',
  netLines:      'Net lines',
  ghosts:        'Ghost parts',
  diodeValues:   'Diode values',
  partsDropdown: 'Find part',
  netsDropdown:  'Find net',
};

export function slotLabel(id: OverlaySlotId): string {
  return isSeparatorId(id) ? 'Separator' : SLOT_LABELS[id];
}

/** True for `sep1`, `sep2`, … — any `sep` followed by a positive integer. */
export function isSeparatorId(id: string): id is SeparatorSlotId {
  return /^sep\d+$/.test(id);
}

/** Recognises both named slots and any separator id. */
export function isKnownSlotId(id: string): id is OverlaySlotId {
  return NAMED_SLOT_IDS.has(id as NamedSlotId) || isSeparatorId(id);
}

/** Pick the next free `sep${N}` id given the slots currently in `layout`.
 *  Used by Settings to add a new separator without colliding. */
export function nextSeparatorId(layout: ReadonlyArray<OverlaySlot>): SeparatorSlotId {
  let max = 0;
  for (const s of layout) {
    const m = /^sep(\d+)$/.exec(s.id);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return `sep${max + 1}`;
}

/**
 * Default order. The two `sep` slots carry the visual gap between the
 * button groups; without them the overlay collapses to one uninterrupted row.
 */
export const DEFAULT_OVERLAY_LAYOUT: ReadonlyArray<Readonly<OverlaySlot>> = [
  // Board transforms (moved down from the app toolbar in v0.39): the
  // controls a repair session touches most lead the row. `sep0` is a
  // default-only id — nextSeparatorId() starts at sep1, so no saved layout
  // can already own it.
  { id: 'sideSwitch',    visible: true },
  { id: 'butterfly',     visible: true },
  { id: 'rotateCCW',     visible: true },
  { id: 'rotateCW',      visible: true },
  { id: 'transformMenu', visible: true },
  { id: 'sep0',          visible: true },
  { id: 'pdfFollow',     visible: true },
  { id: 'scrollMode',    visible: true },
  { id: 'fitBoard',      visible: true },
  { id: 'sep1',          visible: true },
  { id: 'hoverInfo',     visible: true },
  { id: 'netDim',        visible: true },
  { id: 'netLines',      visible: true },
  { id: 'ghosts',        visible: true },
  { id: 'diodeValues',   visible: true },
  { id: 'traces',        visible: true },
  { id: 'sep2',          visible: true },
  { id: 'partsDropdown', visible: true },
  { id: 'netsDropdown',  visible: true },
];

// ---- pure edit operations (used by the store; never mutate their input) ----

export function setSlotVisible(layout: ReadonlyArray<OverlaySlot>, id: OverlaySlotId, visible: boolean): OverlaySlot[] {
  return layout.map(s => (s.id === id ? { id: s.id, visible } : { ...s }));
}

/** Swap the slot with its neighbour. `delta` −1 moves it up/left, +1 down/right. */
export function moveSlot(layout: ReadonlyArray<OverlaySlot>, id: OverlaySlotId, delta: -1 | 1): OverlaySlot[] {
  const out = layout.map(s => ({ ...s }));
  const i = out.findIndex(s => s.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= out.length) return out;
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** Move `id` so it sits directly before `beforeId` (or at the end when
 *  `beforeId` is null). Visibility travels with the slot. */
export function moveSlotBefore(layout: ReadonlyArray<OverlaySlot>, id: OverlaySlotId, beforeId: OverlaySlotId | null): OverlaySlot[] {
  const moved = layout.find(s => s.id === id);
  if (!moved || id === beforeId) return layout.map(s => ({ ...s }));
  const without = layout.filter(s => s.id !== id).map(s => ({ ...s }));
  if (beforeId === null) return [...without, { ...moved }];
  const k = without.findIndex(s => s.id === beforeId);
  if (k < 0) return [...without, { ...moved }];
  without.splice(k, 0, { ...moved });
  return without;
}

/** Remove a slot outright. Only separators are removable from the UI —
 *  named slots are hidden instead, so they can come back. */
export function removeSlot(layout: ReadonlyArray<OverlaySlot>, id: OverlaySlotId): OverlaySlot[] {
  return layout.filter(s => s.id !== id).map(s => ({ ...s }));
}

/**
 * Reconcile a saved OverlaySlot[] with the current known slot set.
 *
 *  • Keeps saved order and visibility
 *  • Drops slot ids we no longer recognise (forward-compat after a rename)
 *  • Inserts any DEFAULT_OVERLAY_LAYOUT entry the user hasn't seen at the
 *    position the default gives it: directly after the *last-placed* of the
 *    default slots that precede it in DEFAULT_OVERLAY_LAYOUT and that the
 *    user still has, or at the front if none of them exist. "Last-placed"
 *    (max index in the user's order), not "nearest in the default", so a
 *    new slot never lands inside a run the user arranged — it joins after
 *    it. Appending at the end (the old rule) put every new control after
 *    the Parts/Nets filters, wrong for anything meant to lead the row.
 *
 * Always returns a fresh array — never mutates the input.
 */
export function reconcileOverlayLayout(saved: unknown): OverlaySlot[] {
  const out: OverlaySlot[] = [];
  const seen = new Set<OverlaySlotId>();

  if (Array.isArray(saved)) {
    for (const raw of saved) {
      if (!raw || typeof raw !== 'object') continue;
      const id = (raw as { id?: unknown }).id;
      const visible = (raw as { visible?: unknown }).visible;
      if (typeof id !== 'string') continue;
      if (!isKnownSlotId(id)) continue;
      if (seen.has(id)) continue;
      out.push({ id, visible: visible !== false });
      seen.add(id);
    }
  }

  for (let d = 0; d < DEFAULT_OVERLAY_LAYOUT.length; d++) {
    const def = DEFAULT_OVERLAY_LAYOUT[d];
    if (seen.has(def.id)) continue;
    let insertAt = 0;
    for (let k = 0; k < d; k++) {
      const idx = out.findIndex(s => s.id === DEFAULT_OVERLAY_LAYOUT[k].id);
      if (idx >= 0 && idx + 1 > insertAt) insertAt = idx + 1;
    }
    out.splice(insertAt, 0, { id: def.id, visible: def.visible });
    seen.add(def.id);
  }

  return out;
}
