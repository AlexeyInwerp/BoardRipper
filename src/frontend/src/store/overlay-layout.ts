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

export type OverlaySlotId =
  | 'pdfFollow' | 'scrollMode' | 'fitBoard'
  | 'hoverInfo' | 'netDim' | 'netLines' | 'ghosts'
  | 'partsDropdown' | 'netsDropdown'
  | 'sep1' | 'sep2';

export interface OverlaySlot { id: OverlaySlotId; visible: boolean }

export const KNOWN_SLOT_IDS: ReadonlySet<OverlaySlotId> = new Set([
  'pdfFollow', 'scrollMode', 'fitBoard',
  'hoverInfo', 'netDim', 'netLines', 'ghosts',
  'partsDropdown', 'netsDropdown',
  'sep1', 'sep2',
]);

/**
 * Default order — reproduces today's UI byte-for-byte. The two `sep` slots
 * carry the visual gap between the existing button groups; without them
 * the overlay collapses to a single uninterrupted row.
 */
export const DEFAULT_OVERLAY_LAYOUT: OverlaySlot[] = [
  { id: 'pdfFollow',     visible: true },
  { id: 'scrollMode',    visible: true },
  { id: 'fitBoard',      visible: true },
  { id: 'sep1',          visible: true },
  { id: 'hoverInfo',     visible: true },
  { id: 'netDim',        visible: true },
  { id: 'netLines',      visible: true },
  { id: 'ghosts',        visible: true },
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
      if (!KNOWN_SLOT_IDS.has(id as OverlaySlotId)) continue;
      const slotId = id as OverlaySlotId;
      if (seen.has(slotId)) continue;
      out.push({ id: slotId, visible: visible !== false });
      seen.add(slotId);
    }
  }

  for (const def of DEFAULT_OVERLAY_LAYOUT) {
    if (!seen.has(def.id)) out.push({ id: def.id, visible: true });
  }

  return out;
}
