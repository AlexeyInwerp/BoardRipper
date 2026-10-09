/**
 * PDF render quality presets — one choice that sets every knob of the PDF
 * render pipeline at once. Same four names as the board's presets
 * (`store/quality-preset.ts`), so "Fast" means the same trade on both sides.
 *
 * The stored ids predate the names (`max | high | medium | low`, saved under
 * `boardripper-pdf-render-quality`) and stay as they are, so a saved choice
 * survives. The pipeline the knobs feed:
 *
 *   zoom → mainTierFromZoom (≤ maxMainTier) → quantiseTier → hysteresisFilter
 *        → clampCanvasScale (≤ maxCanvasDim) → page.render()
 *
 * and, beside the current page, the neighbour pages of continuous mode. What
 * the neighbours cost and look like was the largest finding of the PDF
 * performance review (docs/specs/2026-10-03-pdf-performance-review.md, 3.1):
 * rendered at the main tier while off screen they were most of a zoom's
 * time and 600 MB of canvas; capped too hard they looked soft the moment a
 * page edge came into view. Three knobs now decide it per preset:
 *
 *  - `maxAdjTier`: the most a neighbour is ever rendered at (when near);
 *  - `neighbourNearMargin`: how close to the viewport — as a fraction of its
 *    height — a neighbour counts as "near" and gets the full tier. A pan that
 *    brings a neighbour this close upgrades it (PdfViewerPanel);
 *  - `neighbourFarTier`: the cap for a neighbour further away than that.
 */
import { isTouchPrimary } from '../device-profile';

export type PdfRenderQuality = 'max' | 'high' | 'medium' | 'low';
export const PDF_RENDER_QUALITY_OPTIONS: PdfRenderQuality[] = ['max', 'high', 'medium', 'low'];

/** The names shown for the stored ids — the board presets' names. */
export const PDF_QUALITY_LABELS: Record<PdfRenderQuality, string> = {
  max: 'Quality',
  high: 'Balanced',
  medium: 'Fast',
  low: 'Fastest',
};

export interface PdfQualityConfig {
  /** Max render tier for the main (current) page */
  maxMainTier: number;
  /** Max render tier for a neighbour page near or in the viewport */
  maxAdjTier: number;
  /** Tier cap for a neighbour page further than `neighbourNearMargin` away */
  neighbourFarTier: number;
  /** Distance, in viewport heights, within which a neighbour counts as near */
  neighbourNearMargin: number;
  /** Delay (ms) before neighbour pages re-render after zoom settles */
  adjSettleMs: number;
  /** Max entries in the page render cache */
  cacheMaxEntries: number;
  /** Max total pixels across all cached page bitmaps */
  cacheMaxPixels: number;
  /** Max canvas dimension (px) — the render resolution ceiling */
  maxCanvasDim: number;
}

const QUALITY_CONFIGS: Record<PdfRenderQuality, PdfQualityConfig> = {
  max:    { maxMainTier: 16, maxAdjTier: 6, neighbourFarTier: 4, neighbourNearMargin: 1,    adjSettleMs: 100, cacheMaxEntries: 24, cacheMaxPixels: 160_000_000, maxCanvasDim: 8192 },
  high:   { maxMainTier: 10, maxAdjTier: 4, neighbourFarTier: 2, neighbourNearMargin: 0.5,  adjSettleMs: 150, cacheMaxEntries: 16, cacheMaxPixels: 100_000_000, maxCanvasDim: 6144  },
  // maxCanvasDim caps the *moving* picture only — the full-page canvas that
  // pans and pinches. Once the view settles, PdfViewerPanel renders the
  // visible area at the exact zoom on top (renderDetail), on every preset, so
  // text is sharp at any zoom however small this is. Before that existed the
  // cap was also the sharpness: Fastest at 2048 px was unreadable past 2×, and
  // Quality at 16384 px held ~700 MB per canvas until Chrome ran out of GPU
  // memory and drew the page black (2026-10-10).
  medium: { maxMainTier: 6,  maxAdjTier: 3, neighbourFarTier: 1.5, neighbourNearMargin: 0.25, adjSettleMs: 200, cacheMaxEntries: 10, cacheMaxPixels: 60_000_000,  maxCanvasDim: 4096  },
  low:    { maxMainTier: 5,  maxAdjTier: 2, neighbourFarTier: 1, neighbourNearMargin: 0,    adjSettleMs: 300, cacheMaxEntries: 6,  cacheMaxPixels: 40_000_000,  maxCanvasDim: 4096  },
};

export const PDF_QUALITY_KEY = 'boardripper-pdf-render-quality';

export function loadPdfQuality(): PdfRenderQuality {
  try {
    const raw = localStorage.getItem(PDF_QUALITY_KEY) as PdfRenderQuality | null;
    if (raw && raw in QUALITY_CONFIGS) return raw;
  } catch { /* ignore */ }
  // A tablet gets 'medium'. 'high' budgets 120 MP of cached page bitmaps plus
  // 72 MP of tiles — roughly 750 MB of ImageBitmap backing store — which is a
  // desktop figure, and the usual brake does not apply: Safari does not
  // implement `navigator.deviceMemory`, so applyDeviceMemoryScaling sees
  // `undefined` and scales nothing. An explicit choice in Settings still wins,
  // because this is only the default for a profile that has never set one.
  return isTouchPrimary() ? 'medium' : 'high';
}

/** Store a choice and tell every open PDF panel. */
export function setPdfQuality(q: PdfRenderQuality): void {
  try { localStorage.setItem(PDF_QUALITY_KEY, q); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent('pdf-quality-changed', { detail: q }));
}

/** Scale cache limits by device memory (navigator.deviceMemory).
 *  Low-RAM devices (≤2GB) get halved pixel budgets to prevent OOM. */
function applyDeviceMemoryScaling(cfg: PdfQualityConfig): PdfQualityConfig {
  const mem = (navigator as { deviceMemory?: number }).deviceMemory;
  // Unknown memory on a touch device means Safari on an iPad, where the tab's
  // real ceiling is far below the machine's RAM and an over-budget cache is
  // killed rather than swapped. Treat it as the 2 GB case.
  if (mem === undefined && isTouchPrimary()) {
    return { ...cfg, cacheMaxEntries: Math.max(4, Math.round(cfg.cacheMaxEntries * 0.5)),
             cacheMaxPixels: Math.round(cfg.cacheMaxPixels * 0.5) };
  }
  if (!mem || mem >= 4) return cfg; // 4GB+ or unknown — use full config
  const scale = mem <= 2 ? 0.5 : 0.75;
  return {
    ...cfg,
    cacheMaxEntries: Math.max(4, Math.round(cfg.cacheMaxEntries * scale)),
    cacheMaxPixels: Math.round(cfg.cacheMaxPixels * scale),
  };
}

export function getPdfQualityConfig(q: PdfRenderQuality): PdfQualityConfig {
  // No probe-clamp here. The preset's `maxCanvasDim` is used as a memory
  // budget for the tile path (where each tile renders into its own 1024px
  // canvas, well under any browser limit). The single full-page canvas
  // path applies the probe-clamp via `clampFullPageScale` at its call
  // sites so Safari's stricter limit doesn't shrink the tile-path budget.
  return applyDeviceMemoryScaling(QUALITY_CONFIGS[q]);
}

/** One sentence per preset, derived from the numbers so the copy cannot drift. */
export function pdfQualityDescription(q: PdfRenderQuality): string {
  const c = QUALITY_CONFIGS[q];
  switch (q) {
    case 'max':    return `Sharpest while moving (page up to ${c.maxCanvasDim} px) and neighbouring pages kept sharp. Most memory. Every preset is sharp once the view stops.`;
    case 'high':   return `Sharp while moving up to about ${Math.round(c.maxCanvasDim / 2000)}× zoom; a neighbouring page sharpens as it comes into view. Sharp at any zoom once the view stops.`;
    case 'medium': return `Lighter while moving; neighbouring pages lighter. Sharp at any zoom once the view stops. For tablets and integrated GPUs.`;
    case 'low':    return `Lightest while moving; least memory and battery. Sharp at any zoom once the view stops.`;
  }
}
