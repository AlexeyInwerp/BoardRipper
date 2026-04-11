// src/frontend/src/pdf/glyph-overlay.ts

import type { PageGlyphData } from './glyph-types';
import { COMPLEXITY, itemRect, textItemCorners, toCanvas } from './glyph-types';
import type { PdfTextItem } from '../store/pdf-store';
import { pdfFontSize } from '../store/pdf-store';

/**
 * Draw glyph bounding boxes colored by complexity — verbose mode with full item details.
 * Uses oriented rectangles that properly handle rotated text.
 */
export function drawGlyphBoxes(
  ctx: CanvasRenderingContext2D,
  pageData: PageGlyphData,
  vpT: number[],
  scale: number,
) {
  ctx.save();
  const baseFontPx = Math.max(9, 9 * (scale / 100));
  ctx.textBaseline = 'bottom';

  for (let i = 0; i < pageData.items.length; i++) {
    const item = pageData.items[i];
    const rect = itemRect(item, vpT, scale);
    const corners = textItemCorners(item.transform, item.width, vpT, scale);

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

    // Draw oriented polygon
    ctx.beginPath();
    ctx.moveTo(corners[0][0], corners[0][1]);
    ctx.lineTo(corners[1][0], corners[1][1]);
    ctx.lineTo(corners[2][0], corners[2][1]);
    ctx.lineTo(corners[3][0], corners[3][1]);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = color.replace('0.3', '0.8');
    ctx.lineWidth = 1;
    ctx.stroke();

    // Verbose labels: index, text, font, fontSize, dimensions, transform
    const fontSize = pdfFontSize(item.transform);
    ctx.font = `bold ${baseFontPx}px monospace`;
    ctx.fillStyle = '#ff0';
    // Line 1: item index + quoted text
    const textPreview = item.str.length > 30 ? item.str.slice(0, 30) + '…' : item.str;
    ctx.fillText(`#${i} "${textPreview}"`, rect.x, rect.y - baseFontPx - 2);
    // Line 2: font, fontSize, w×h
    ctx.font = `${baseFontPx}px monospace`;
    ctx.fillStyle = '#fff';
    const fontShort = item.fontName.length > 25 ? item.fontName.slice(0, 25) + '…' : item.fontName;
    const notdefCount = item.glyphs ? item.glyphs.filter(g => g.isNotdef).length : 0;
    const notdefStr = notdefCount > 0 ? ` !${notdefCount}notdef` : '';
    const type3Str = item.isType3 ? ' [Type3]' : '';
    ctx.fillText(
      `${fontShort} fs:${fontSize.toFixed(1)} w:${item.width.toFixed(0)} avg:${Math.round(item.avgVertexCount)}v${notdefStr}${type3Str}`,
      rect.x, rect.y - 2,
    );
  }

  ctx.restore();
}

/**
 * Draw raw pdf.js text items directly — no glyph extraction needed.
 * Shows every item that getTextContent() returned, with full metadata.
 * Draws oriented bounding boxes that properly handle rotated text.
 * Useful for investigating missing/unselectable text.
 */
export function drawTextItems(
  ctx: CanvasRenderingContext2D,
  items: PdfTextItem[],
  vpT: number[],
  scale: number,
) {
  ctx.save();
  const baseFontPx = Math.max(9, 9 * (scale / 100));
  ctx.textBaseline = 'bottom';

  let rotatedCount = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const fontSize = pdfFontSize(item.transform);
    const t = item.transform;

    // Get the 4 oriented corners and AABB
    const corners = textItemCorners(t, item.width, vpT, scale);
    const rect = itemRect(item, vpT, scale);

    // Detect rotation: if transform[1] or transform[2] are non-negligible
    const isRotated = Math.abs(t[1]) > 0.01 || Math.abs(t[2]) > 0.01;
    if (isRotated) rotatedCount++;

    // Color by item state
    const hasContent = item.str.trim().length > 0;
    const hasWidth = item.width > 0;
    let boxColor: string;
    if (!hasContent) {
      boxColor = 'rgba(255, 0, 0, 0.4)';       // red: empty string
    } else if (!hasWidth) {
      boxColor = 'rgba(255, 0, 255, 0.4)';      // magenta: has text but zero width
    } else if (fontSize < 1) {
      boxColor = 'rgba(255, 128, 0, 0.4)';      // orange: near-zero font size
    } else if (isRotated) {
      boxColor = 'rgba(0, 255, 200, 0.25)';     // cyan: rotated text
    } else {
      boxColor = 'rgba(0, 150, 255, 0.25)';     // blue: normal
    }

    // Draw oriented polygon (the actual text bounds)
    ctx.beginPath();
    ctx.moveTo(corners[0][0], corners[0][1]);
    ctx.lineTo(corners[1][0], corners[1][1]);
    ctx.lineTo(corners[2][0], corners[2][1]);
    ctx.lineTo(corners[3][0], corners[3][1]);
    ctx.closePath();
    ctx.fillStyle = boxColor;
    ctx.fill();
    ctx.strokeStyle = boxColor.replace(/[\d.]+\)$/, '0.8)');
    ctx.lineWidth = 1;
    ctx.stroke();

    // GREEN DOT at raw baseline position (e, f) — the exact pdf.js-reported origin
    // If this dot doesn't land on the rendered text baseline, pdf.js extraction is off
    const baseline = toCanvas(t[4], t[5], vpT, scale);
    ctx.fillStyle = '#0f0';
    ctx.beginPath();
    ctx.arc(baseline[0], baseline[1], 3, 0, Math.PI * 2);
    ctx.fill();

    // Yellow cross-hair at bottom-left corner of bounding box
    const origin = corners[0];
    ctx.strokeStyle = 'rgba(255, 255, 0, 0.6)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(origin[0] - 4, origin[1]);
    ctx.lineTo(origin[0] + 4, origin[1]);
    ctx.moveTo(origin[0], origin[1] - 4);
    ctx.lineTo(origin[0], origin[1] + 4);
    ctx.stroke();

    // Labels — positioned above the AABB
    const textPreview = item.str.length > 25 ? item.str.slice(0, 25) + '…' : item.str;
    const rotTag = isRotated ? ' [ROT]' : '';
    // Line 1 (above box): index + text
    ctx.font = `bold ${baseFontPx}px monospace`;
    ctx.fillStyle = '#ff0';
    ctx.fillText(`#${i} "${textPreview}"${rotTag}`, rect.x, rect.y - baseFontPx * 2 - 2);
    // Line 2: font name
    ctx.font = `${baseFontPx}px monospace`;
    ctx.fillStyle = '#ccc';
    const fontShort = item.fontName.length > 30 ? item.fontName.slice(0, 30) + '…' : item.fontName;
    ctx.fillText(`${fontShort}`, rect.x, rect.y - baseFontPx - 1);
    // Line 3: metrics
    ctx.fillStyle = '#aef';
    ctx.fillText(
      `fs:${fontSize.toFixed(1)} w:${item.width.toFixed(1)} h:${item.height.toFixed(1)} tx:[${t[0].toFixed(2)},${t[1].toFixed(2)},${t[2].toFixed(2)},${t[3].toFixed(2)},${t[4].toFixed(0)},${t[5].toFixed(0)}]`,
      rect.x, rect.y - 1,
    );
  }

  // Summary bar at top
  ctx.font = `bold ${baseFontPx + 2}px monospace`;
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(4, 4, 600, baseFontPx + 8);
  ctx.fillStyle = '#0f0';
  const empty = items.filter(it => !it.str.trim()).length;
  const zeroW = items.filter(it => it.str.trim() && it.width === 0).length;
  ctx.fillText(
    `Text Items: ${items.length} total | ${empty} empty | ${zeroW} zero-width | ${rotatedCount} rotated`,
    8, baseFontPx + 8,
  );

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
