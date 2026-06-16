// src/frontend/src/store/overlay-layout.ts
/**
 * BoardViewer overlay slot model — single source of truth for the slot
 * registry, default order, and persistence reconciliation.
 *
 * The overlay (the floating row of buttons on the board canvas) is rendered
 * by walking `OverlaySlot[]` and looking each id up in slot-renderers.tsx.
 * Adding a new slot:
 *   1. add the id to OverlaySlotId
 *   2. add it to KNOWN_SLOT_IDS
 *   3. add it to DEFAULT_OVERLAY_LAYOUT (anywhere, with visible: true)
 *   4. add a renderer entry in slot-renderers.tsx
 * `reconcileOverlayLayout` will append it to existing users' saved layouts
 * automatically on next load.
 */

/** The fixed-name slots (one button each). Separator slots use the
 *  open-ended `sep${number}` ids — see `isSeparatorId` below. */
export type NamedSlotId =
  | 'pdfFollow' | 'scrollMode' | 'fitBoard'
  | 'hoverInfo' | 'netDim' | 'netLines' | 'ghosts' | 'diodeValues'
  | 'partsDropdown' | 'netsDropdown';

export type SeparatorSlotId = `sep${number}`;
export type OverlaySlotId = NamedSlotId | SeparatorSlotId;

export interface OverlaySlot { id: OverlaySlotId; visible: boolean }

const NAMED_SLOT_IDS: ReadonlySet<NamedSlotId> = new Set([
  'pdfFollow', 'scrollMode', 'fitBoard',
  'hoverInfo', 'netDim', 'netLines', 'ghosts', 'diodeValues',
  'partsDropdown', 'netsDropdown',
]);

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
 * Default order — reproduces today's UI byte-for-byte. The two `sep` slots
 * carry the visual gap between the existing button groups; without them
 * the overlay collapses to a single uninterrupted row.
 */
export const DEFAULT_OVERLAY_LAYOUT: ReadonlyArray<Readonly<OverlaySlot>> = [
  { id: 'pdfFollow',     visible: true },
  { id: 'scrollMode',    visible: true },
  { id: 'fitBoard',      visible: true },
  { id: 'sep1',          visible: true },
  { id: 'hoverInfo',     visible: true },
  { id: 'netDim',        visible: true },
  { id: 'netLines',      visible: true },
  { id: 'ghosts',        visible: true },
  { id: 'diodeValues',   visible: true },
  { id: 'sep2',          visible: true },
  { id: 'partsDropdown', visible: true },
  { id: 'netsDropdown',  visible: true },
];

/**
 * Reconcile a saved OverlaySlot[] with the current known slot set.
 *
 *  • Keeps saved order
 *  • Drops slot ids we no longer recognise (forward-compat after a rename)
 *  • Appends any slot id from DEFAULT_OVERLAY_LAYOUT the user hasn't seen
 *    (covers upgrade paths where new buttons land after the user's layout
 *    was saved).
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

  // Append any DEFAULT_OVERLAY_LAYOUT entries the user hasn't seen yet
  // (handles upgrade paths after new built-in slots are added). Extra
  // separators the user has created beyond sep1/sep2 are preserved as-is
  // by the loop above.
  for (const def of DEFAULT_OVERLAY_LAYOUT) {
    if (!seen.has(def.id)) out.push({ id: def.id, visible: def.visible });
  }

  return out;
}
