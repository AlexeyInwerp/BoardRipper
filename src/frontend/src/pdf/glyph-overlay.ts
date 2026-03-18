// src/frontend/src/pdf/glyph-overlay.ts

import type { PageGlyphData } from './glyph-types';
import { COMPLEXITY, itemRect } from './glyph-types';
import { pdfFontSize } from '../store/pdf-store';

/**
 * Draw glyph bounding boxes colored by complexity.
 */
export function drawGlyphBoxes(
  ctx: CanvasRenderingContext2D,
  pageData: PageGlyphData,
  vpT: number[],
  scale: number,
) {
  ctx.save();
  ctx.font = `${Math.max(10, 10 * (scale / 100))}px monospace`;
  ctx.textBaseline = 'bottom';

  for (const item of pageData.items) {
    const rect = itemRect(item, vpT, scale);

    let color: string;
    if (item.isType3) {
      color = COMPLEXITY.TYPE3_COLOR;
    } else if (item.glyphs === null) {
      color = COMPLEXITY.TYPE3_COLOR;
    } else if (item.avgVertexCount > COMPLEXITY.HIGH_THRESHOLD) {
      color = COMPLEXITY.HIGH_COLOR;
    } else if (item.avgVertexCount > COMPLEXITY.LOW_THRESHOLD) {
      color = COMPLEXITY.MED_COLOR;
    } else {
      color = COMPLEXITY.LOW_COLOR;
    }

    ctx.fillStyle = color;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

    ctx.strokeStyle = color.replace('0.3', '0.8');
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);

    const label = item.isType3
      ? `Type3: ${item.fontName}`
      : `${item.fontName.substring(0, 20)} avg:${Math.round(item.avgVertexCount)}v`;
    ctx.fillStyle = '#fff';
    ctx.fillText(label, rect.x, rect.y - 2);
  }

  ctx.restore();
}

/**
 * Draw actual glyph outlines with control point markers.
 */
export function drawGlyphOutlines(
  ctx: CanvasRenderingContext2D,
  pageData: PageGlyphData,
  vpT: number[],
  scale: number,
) {
  ctx.save();

  for (const item of pageData.items) {
    if (item.isType3 || !item.glyphs) {
      const rect = itemRect(item, vpT, scale);
      if (item.isType3) {
        ctx.fillStyle = COMPLEXITY.TYPE3_COLOR;
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
        ctx.fillStyle = '#aaa';
        ctx.font = '10px monospace';
        ctx.fillText('Type3', rect.x + 2, rect.y + rect.h - 2);
      }
      continue;
    }

    const fontSize = pdfFontSize(item.transform);
    const rect = itemRect(item, vpT, scale);
    const totalAdvance = item.glyphs.reduce((s, g) => s + g.advanceWidth, 0);
    const pxPerUnit = totalAdvance > 0 ? rect.w / totalAdvance : 0;
    const fontScale = (fontSize * scale) / item.unitsPerEm;

    let cursorX = rect.x;

    for (const glyph of item.glyphs) {
      if (glyph.isNotdef) {
        ctx.setLineDash([2, 2]);
        ctx.strokeStyle = COMPLEXITY.NOTDEF_COLOR;
        const gw = glyph.advanceWidth * pxPerUnit;
        ctx.strokeRect(cursorX, rect.y, gw || 8, rect.h);
        ctx.setLineDash([]);
        cursorX += gw || 8;
        continue;
      }

      const cmds = glyph.path.commands;
      const gw = glyph.advanceWidth * pxPerUnit;
      const baselineY = rect.y + rect.h;

      ctx.beginPath();
      const onCurvePoints: { x: number; y: number }[] = [];
      const offCurvePoints: { x: number; y: number; anchorX: number; anchorY: number }[] = [];

      for (const cmd of cmds) {
        const tx = (x: number) => cursorX + x * fontScale;
        const ty = (y: number) => baselineY - y * fontScale;

        switch (cmd.type) {
          case 'M':
            ctx.moveTo(tx(cmd.x), ty(cmd.y));
            onCurvePoints.push({ x: tx(cmd.x), y: ty(cmd.y) });
            break;
          case 'L':
            ctx.lineTo(tx(cmd.x), ty(cmd.y));
            onCurvePoints.push({ x: tx(cmd.x), y: ty(cmd.y) });
            break;
          case 'Q':
            ctx.quadraticCurveTo(tx(cmd.x1), ty(cmd.y1), tx(cmd.x), ty(cmd.y));
            offCurvePoints.push({ x: tx(cmd.x1), y: ty(cmd.y1), anchorX: tx(cmd.x), anchorY: ty(cmd.y) });
            onCurvePoints.push({ x: tx(cmd.x), y: ty(cmd.y) });
            break;
          case 'C':
            ctx.bezierCurveTo(tx(cmd.x1), ty(cmd.y1), tx(cmd.x2), ty(cmd.y2), tx(cmd.x), ty(cmd.y));
            offCurvePoints.push(
              { x: tx(cmd.x1), y: ty(cmd.y1), anchorX: tx(cmd.x), anchorY: ty(cmd.y) },
              { x: tx(cmd.x2), y: ty(cmd.y2), anchorX: tx(cmd.x), anchorY: ty(cmd.y) },
            );
            onCurvePoints.push({ x: tx(cmd.x), y: ty(cmd.y) });
            break;
          case 'Z':
            ctx.closePath();
            break;
        }
      }

      const hasQuad = cmds.some((c: any) => c.type === 'Q');
      const hasCubic = cmds.some((c: any) => c.type === 'C');
      ctx.strokeStyle = hasCubic ? 'rgba(255, 160, 0, 0.8)' : hasQuad ? 'rgba(80, 160, 255, 0.8)' : 'rgba(200, 200, 200, 0.6)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // On-curve points (filled green)
      ctx.fillStyle = '#0f0';
      for (const p of onCurvePoints) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
        ctx.fill();
      }

      // Off-curve control points (hollow red) with lines to anchor
      ctx.strokeStyle = 'rgba(255, 100, 100, 0.5)';
      ctx.setLineDash([1, 1]);
      for (const p of offCurvePoints) {
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.anchorX, p.anchorY);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // Vertex count label
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.font = '8px monospace';
      ctx.fillText(`${glyph.vertexCount}`, cursorX, rect.y - 1);

      cursorX += gw || 8;
    }
  }

  ctx.restore();
}
