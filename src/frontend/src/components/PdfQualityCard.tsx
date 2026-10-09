/**
 * PDF quality preset — the PDF side of the board's QualityPresetCard, with
 * the same four names (`store/pdf-quality.ts`). Start page, beside the board
 * card; Settings ▸ PDF has the same choice. Kept in step with every other
 * control through the `pdf-quality-changed` event the panels already obey.
 */
import { useEffect, useState } from 'react';
import {
  PDF_QUALITY_LABELS, PDF_RENDER_QUALITY_OPTIONS, getPdfQualityConfig, loadPdfQuality,
  pdfQualityDescription, setPdfQuality, type PdfRenderQuality,
} from '../store/pdf-quality';

/** The stored PDF quality, following changes made anywhere. */
export function usePdfQuality(): PdfRenderQuality {
  const [q, setQ] = useState<PdfRenderQuality>(loadPdfQuality);
  useEffect(() => {
    const on = (e: Event) => setQ((e as CustomEvent<PdfRenderQuality>).detail);
    window.addEventListener('pdf-quality-changed', on);
    return () => window.removeEventListener('pdf-quality-changed', on);
  }, []);
  return q;
}

export function PdfQualityCard() {
  const q = usePdfQuality();
  const cfg = getPdfQualityConfig(q);
  return (
    <div className="ui-scale-full home-quality-card" data-testid="pdf-quality-card">
      <div className="ui-scale-full-label">
        <span>PDF quality</span>
        <span className="ui-scale-full-readout" translate="no"
              title="Sharpest zoom and the cache this preset allows on this device">
          {`${cfg.maxMainTier}× · ${Math.round(cfg.cacheMaxPixels / 1e6)} MP`}
        </span>
      </div>
      <div className="home-quality-buttons" role="radiogroup" aria-label="PDF quality preset">
        {PDF_RENDER_QUALITY_OPTIONS.map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={q === id}
            className={`home-quality-btn${q === id ? ' active' : ''}`}
            data-testid={`pdf-quality-${id}`}
            onClick={() => setPdfQuality(id)}
            title={pdfQualityDescription(id)}
          >
            {PDF_QUALITY_LABELS[id]}
          </button>
        ))}
      </div>
      <div className="ui-scale-full-hint"><span>{pdfQualityDescription(q)}</span></div>
    </div>
  );
}
