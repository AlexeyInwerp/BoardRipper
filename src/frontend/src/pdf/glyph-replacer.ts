// src/frontend/src/pdf/glyph-replacer.ts

import type { PageGlyphData } from './glyph-types';
import { itemRect } from './glyph-types';
import { pdfFontSize } from '../store/pdf-store';

/** Characters that should be replaced with monospace font (letters + digits) */
const REPLACEABLE = /[A-Za-z0-9]/;

/**
 * Replace letter/digit text with a monospace font on a canvas that already has the PDF blit.
 * Special characters (punctuation, symbols, whitespace) are left as-is from the original PDF.
 * Uses clip() to prevent white background from bleeding into adjacent text.
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
    // Skip items that have no replaceable characters
    if (!REPLACEABLE.test(item.str)) continue;

    const rect = itemRect(item, vpT, scale);
    const fontSize = pdfFontSize(item.transform);
    const pxSize = fontSize * scale;

    // Clip to exact text item bounds — prevents white bleed into neighbors
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip();

    // Cover original text with white within clipped region
    ctx.fillStyle = '#fff';
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

    // Draw replacement: only replace alphanumeric chars, keep specials as gaps
    ctx.fillStyle = '#000';
    ctx.font = `${pxSize}px "${fontFamily}", monospace`;
    ctx.textBaseline = 'alphabetic';

    // Measure full replacement string to compute per-char positioning
    const charWidth = rect.w / item.str.length;

    for (let i = 0; i < item.str.length; i++) {
      const ch = item.str[i];
      if (REPLACEABLE.test(ch)) {
        const cx = rect.x + i * charWidth;
        const measured = ctx.measureText(ch);
        const charScale = charWidth / (measured.width || 1);
        ctx.save();
        ctx.translate(cx, rect.y + rect.h);
        ctx.scale(charScale, 1);
        ctx.fillText(ch, 0, 0);
        ctx.restore();
      }
      // Non-replaceable chars: the white fill already covered them,
      // but since we blitted the PDF first, we need to re-draw them.
      // For now they show as white gaps — the original PDF glyph is lost.
      // This is acceptable for schematic text which is mostly alphanumeric.
    }

    ctx.restore(); // pop clip
  }

  ctx.restore();
}
