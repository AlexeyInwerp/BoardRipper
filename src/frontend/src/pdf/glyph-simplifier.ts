// src/frontend/src/pdf/glyph-simplifier.ts

import type { PageGlyphData } from './glyph-types';
import { itemRect } from './glyph-types';
import { sampleQuadratic, sampleCubic, rdpSimplify } from './bezier-utils';
import type { Point } from './bezier-utils';
import { pdfFontSize } from '../store/pdf-store';

/**
 * Render simplified glyph outlines on a canvas that already has the PDF blit.
 * Covers original text with white, then draws simplified polyline glyphs.
 */
export function drawSimplifiedGlyphs(
  ctx: CanvasRenderingContext2D,
  pageData: PageGlyphData,
  vpT: number[],
  scale: number,
  epsilon: number,
) {
  ctx.save();

  for (const item of pageData.items) {
    if (item.isType3 || !item.glyphs) continue;

    const fontSize = pdfFontSize(item.transform);
    const rect = itemRect(item, vpT, scale);
    const totalAdvance = item.glyphs.reduce((s, g) => s + g.advanceWidth, 0);
    const pxPerUnit = totalAdvance > 0 ? rect.w / totalAdvance : 0;
    const fontScale = (fontSize * scale) / item.unitsPerEm;

    // Cover original text with white
    ctx.fillStyle = '#fff';
    ctx.fillRect(rect.x - 1, rect.y - 1, rect.w + 2, rect.h + 2);

    let cursorX = rect.x;
    const baselineY = rect.y + rect.h;

    for (const glyph of item.glyphs) {
      if (glyph.isNotdef) {
        cursorX += glyph.advanceWidth * pxPerUnit || 8;
        continue;
      }

      const cmds = glyph.path.commands;
      const tx = (x: number) => cursorX + x * fontScale;
      const ty = (y: number) => baselineY - y * fontScale;

      // Build polyline contours from path commands
      const contours: Point[][] = [];
      let current: Point[] = [];

      for (const cmd of cmds) {
        switch (cmd.type) {
          case 'M':
            if (current.length > 0) contours.push(current);
            current = [{ x: tx(cmd.x), y: ty(cmd.y) }];
            break;
          case 'L':
            current.push({ x: tx(cmd.x), y: ty(cmd.y) });
            break;
          case 'Q': {
            const prev = current[current.length - 1] || { x: 0, y: 0 };
            const pts = sampleQuadratic(prev, { x: tx(cmd.x1), y: ty(cmd.y1) }, { x: tx(cmd.x), y: ty(cmd.y) });
            current.push(...pts.slice(1));
            break;
          }
          case 'C': {
            const prev = current[current.length - 1] || { x: 0, y: 0 };
            const pts = sampleCubic(
              prev,
              { x: tx(cmd.x1), y: ty(cmd.y1) },
              { x: tx(cmd.x2), y: ty(cmd.y2) },
              { x: tx(cmd.x), y: ty(cmd.y) },
            );
            current.push(...pts.slice(1));
            break;
          }
          case 'Z':
            if (current.length > 0) {
              contours.push(current);
              current = [];
            }
            break;
        }
      }
      if (current.length > 0) contours.push(current);

      // Simplify each contour and render as filled polyline
      ctx.beginPath();
      for (const contour of contours) {
        const simplified = rdpSimplify(contour, epsilon);
        if (simplified.length < 2) continue;
        ctx.moveTo(simplified[0].x, simplified[0].y);
        for (let i = 1; i < simplified.length; i++) {
          ctx.lineTo(simplified[i].x, simplified[i].y);
        }
        ctx.closePath();
      }
      ctx.fillStyle = '#000';
      ctx.fill('evenodd');

      cursorX += glyph.advanceWidth * pxPerUnit || 8;
    }
  }

  ctx.restore();
}
