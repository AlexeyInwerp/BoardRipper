/**
 * Focus relay for the board ribbon's two find fields (Find part / Find net),
 * keyed by board tab and kind. `FilterDropdown` registers while mounted;
 * `useKeyboardShortcuts` asks for the field on Cmd/Ctrl+F. A tab whose
 * ribbon hides the slot has no entry, and the caller falls back to the
 * sidebar search.
 */

export type RibbonFindKind = 'parts' | 'nets';

export interface RibbonFindApi {
  /** Put `text` in the field, open its list, and focus it (expanding the
   *  collapsed vertical-ribbon field first). */
  prefill(text: string): void;
}

const fields = new Map<string, RibbonFindApi>();
const key = (tabId: number, kind: RibbonFindKind) => `${tabId}:${kind}`;

export function registerRibbonFind(tabId: number, kind: RibbonFindKind, api: RibbonFindApi): () => void {
  const k = key(tabId, kind);
  fields.set(k, api);
  return () => { if (fields.get(k) === api) fields.delete(k); };
}

/** Prefill and focus the ribbon field; false when that tab has none. */
export function focusRibbonFind(tabId: number, kind: RibbonFindKind, text: string): boolean {
  const api = fields.get(key(tabId, kind));
  if (!api) return false;
  api.prefill(text);
  return true;
}
