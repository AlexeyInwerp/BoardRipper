// src/frontend/src/pdf/glyph-replacer.ts

import type { PageGlyphData } from './glyph-types';
import { itemRect } from './glyph-types';
import { pdfFontSize } from '../store/pdf-store';

/**
 * Replace all text with a monospace font on a canvas that already has the PDF blit.
 * Covers original text with white, then draws replacement text.
 */
export function drawMonospaceReplacement(
  ctx: CanvasRenderingContext2D,
  pageData: PageGlyphData,
  vpT: number[],
  scale: number,
  fontFamily: string,
) {
  ctx.save();

  for (const item of pageData.items) {
    const rect = itemRect(item, vpT, scale);
    const fontSize = pdfFontSize(item.transform);
    const pxSize = fontSize * scale;

    // Cover original text with white
    ctx.fillStyle = '#fff';
    ctx.fillRect(rect.x - 1, rect.y - 1, rect.w + 2, rect.h + 2);

    // Draw replacement text
    ctx.fillStyle = '#000';
    ctx.font = `${pxSize}px "${fontFamily}", monospace`;
    ctx.textBaseline = 'alphabetic';

    const measured = ctx.measureText(item.str);
    const scaleX = rect.w / (measured.width || 1);

    ctx.save();
    ctx.translate(rect.x, rect.y + rect.h);
    ctx.scale(scaleX, 1);
    ctx.fillText(item.str, 0, 0);
    ctx.restore();
  }

  ctx.restore();
}
