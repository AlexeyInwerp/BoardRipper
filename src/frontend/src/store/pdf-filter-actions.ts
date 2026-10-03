/**
 * PDF filter settings — the one place that writes them.
 *
 * All four are GLOBAL render settings (one value for every PDF, persisted in
 * `boardripper-render-settings` with the rest of `globalSettings`); nothing
 * here is per-document. Two kinds, and the difference is what the filter menu
 * is built around:
 *
 *  - live: the watermark text filter (`pdfWatermarkFilterEnabled` + the term
 *    list). The panel watches these and re-parses operator lists in place.
 *  - on reload: `pdfStripWatermarkImages` and `pdfPruneInvisible` are decided
 *    when pdf.js opens the document. A PDF opened under other values says so
 *    through `pdfStore.needsReparse`, and `pdfStore.reparse` reopens it.
 *
 * Term edits also go to the backend (`pdf_watermark_terms`) so the pdfium
 * indexer filters the same words; before this module only the Settings
 * editor pushed, and a term added from the right-click menu never reached it.
 */
import { renderSettingsStore, type RenderSettings } from './render-settings';
import { hasBackend } from './databank-store';

function update(patch: Partial<RenderSettings>): void {
  renderSettingsStore.applyGlobal({ ...renderSettingsStore.globalSnapshot(), ...patch });
}

/** Push the watermark term list to the backend config. Best effort; no-op
 *  without a backend (desktop, lite). */
export function pushWatermarkTermsToBackend(terms: string[]): void {
  if (!hasBackend()) return;
  void fetch('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'pdf_watermark_terms', value: JSON.stringify(terms) }),
  }).catch(() => { /* best-effort */ });
}

export function setWatermarkTextEnabled(enabled: boolean): void {
  update({ pdfWatermarkFilterEnabled: enabled });
}

/** Replace the whole term list (Settings editor). */
export function setWatermarkTerms(terms: string[]): void {
  update({ pdfWatermarkFilter: terms });
  pushWatermarkTermsToBackend(terms);
}

/** Add a term and switch the filter on — adding one means "hide it now".
 *  Returns false when the term is empty or already listed. */
export function addWatermarkTerm(raw: string): boolean {
  const term = raw.trim();
  const cur = renderSettingsStore.globalSettings.pdfWatermarkFilter ?? [];
  if (!term || cur.includes(term)) return false;
  const next = [...cur, term];
  update({ pdfWatermarkFilter: next, pdfWatermarkFilterEnabled: true });
  pushWatermarkTermsToBackend(next);
  return true;
}

export function removeWatermarkTerm(term: string): void {
  const cur = renderSettingsStore.globalSettings.pdfWatermarkFilter ?? [];
  const next = cur.filter(t => t !== term);
  if (next.length === cur.length) return;
  update({ pdfWatermarkFilter: next });
  pushWatermarkTermsToBackend(next);
}

export function setStripWatermarkImages(enabled: boolean): void {
  update({ pdfStripWatermarkImages: enabled });
}

export function setPruneInvisible(enabled: boolean): void {
  update({ pdfPruneInvisible: enabled });
}
