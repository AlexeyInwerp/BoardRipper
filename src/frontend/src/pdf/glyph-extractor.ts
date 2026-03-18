// src/frontend/src/pdf/glyph-extractor.ts

import opentype from 'opentype.js';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/types/src/pdf';
import type { FontCacheEntry, GlyphPathData, TextItemGlyphData, PageGlyphData } from './glyph-types';
import type { PdfTextItem } from '../store/pdf-store';

/** Module-level font cache: "docFingerprint:fontName" → parsed Font */
const fontCache = new Map<string, FontCacheEntry>();

/** Clear cache entries for a specific document (by fingerprint). */
export function clearFontCache(docFingerprint?: string) {
  if (!docFingerprint) {
    fontCache.clear();
    return;
  }
  const prefix = docFingerprint + ':';
  for (const key of fontCache.keys()) {
    if (key.startsWith(prefix)) fontCache.delete(key);
  }
}

function cacheKey(docFingerprint: string, fontName: string) {
  return docFingerprint + ':' + fontName;
}

/** Yield to browser to avoid blocking the main thread. */
function yieldToMain(): Promise<void> {
  return new Promise(r => setTimeout(r, 0));
}

/**
 * Extract and parse fonts from a pdf.js page's commonObjs.
 * Requires the document to have been loaded with fontExtraProperties: true.
 */
async function parseFontsFromPage(
  page: PDFPageProxy,
  docFingerprint: string,
): Promise<void> {
  const ops = await page.getOperatorList();
  const fontNames = new Set<string>();
  const OPS = (await import('pdfjs-dist')).OPS;

  for (let i = 0; i < ops.fnArray.length; i++) {
    if (ops.fnArray[i] === OPS.setFont) {
      fontNames.add(ops.argsArray[i][0] as string);
    }
  }

  for (const name of fontNames) {
    const ck = cacheKey(docFingerprint, name);
    if (fontCache.has(ck)) continue;

    try {
      // After getOperatorList(), fonts should be resolved — use synchronous get
      let fontObj: any;
      try {
        fontObj = page.commonObjs.get(name);
      } catch {
        console.warn(`[glyph-extractor] Font ${name} not available in commonObjs, skipping`);
        continue;
      }

      if (!fontObj) continue;

      if (fontObj.isType3Font) {
        fontCache.set(ck, {
          font: null as any,
          fontName: name,
          isType3: true,
          glyphCount: 0,
          unitsPerEm: 1000,
        });
        continue;
      }

      const data = fontObj.data;
      if (!data || data.length === 0) {
        console.warn(`[glyph-extractor] Font ${name} has no data. Was fontExtraProperties enabled?`);
        continue;
      }

      // Parse font buffer with opentype.js
      const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      const font = opentype.parse(buffer);

      fontCache.set(ck, {
        font,
        fontName: name,
        isType3: false,
        glyphCount: font.glyphs.length,
        unitsPerEm: font.unitsPerEm,
      });

      // Yield between font parses to avoid blocking the main thread
      await yieldToMain();
    } catch (err) {
      console.warn(`[glyph-extractor] Failed to parse font ${name}:`, err);
    }
  }
}

/** Extract glyph path data for each character in a text item. */
function extractGlyphsForItem(
  item: PdfTextItem,
  cache: FontCacheEntry,
): GlyphPathData[] | null {
  if (cache.isType3 || !cache.font) return null;

  const glyphs: GlyphPathData[] = [];
  const font = cache.font;

  for (const char of item.str) {
    const glyphIndex = font.charToGlyphIndex(char);
    const glyph = font.glyphs.get(glyphIndex);
    const isNotdef = glyphIndex === 0;

    if (!glyph) {
      glyphs.push({
        path: new opentype.Path(),
        commandCount: 0,
        vertexCount: 0,
        advanceWidth: 0,
        glyphIndex: 0,
        isNotdef: true,
      });
      continue;
    }

    const path = glyph.getPath(0, 0, font.unitsPerEm);
    let vertexCount = 0;
    for (const cmd of path.commands) {
      if (cmd.type === 'M' || cmd.type === 'L') vertexCount += 1;
      else if (cmd.type === 'Q') vertexCount += 2;
      else if (cmd.type === 'C') vertexCount += 3;
    }

    glyphs.push({
      path,
      commandCount: path.commands.length,
      vertexCount,
      advanceWidth: glyph.advanceWidth ?? 0,
      glyphIndex,
      isNotdef,
    });
  }

  return glyphs;
}

/**
 * Build PageGlyphData for a given page.
 * Call this when debug mode is activated.
 */
export async function extractPageGlyphs(
  page: PDFPageProxy,
  doc: PDFDocumentProxy,
  textItems: PdfTextItem[],
  pageIndex: number,
): Promise<PageGlyphData> {
  const result: PageGlyphData = {
    pageIndex,
    items: [],
    fontNames: [],
    status: 'loading',
  };

  const docFingerprint = doc.fingerprints[0] ?? 'unknown';

  try {
    await parseFontsFromPage(page, docFingerprint);

    const fontNamesSet = new Set<string>();

    for (const item of textItems) {
      const fontName = item.fontName;
      fontNamesSet.add(fontName);
      const ck = cacheKey(docFingerprint, fontName);
      const cache = fontCache.get(ck);

      if (!cache) {
        result.items.push({
          str: item.str,
          fontName,
          transform: item.transform,
          width: item.width,
          glyphs: null,
          isType3: false,
          avgVertexCount: 0,
          unitsPerEm: 1000,
        });
        continue;
      }

      const glyphs = extractGlyphsForItem(item, cache);
      const avgVerts = glyphs
        ? glyphs.reduce((s, g) => s + g.vertexCount, 0) / Math.max(glyphs.length, 1)
        : 0;

      result.items.push({
        str: item.str,
        fontName,
        transform: item.transform,
        width: item.width,
        glyphs,
        isType3: cache.isType3,
        avgVertexCount: avgVerts,
        unitsPerEm: cache.unitsPerEm,
      });
    }

    result.fontNames = [...fontNamesSet];
    result.status = 'ready';
  } catch (err) {
    result.status = 'error';
    result.error = String(err);
    console.error('[glyph-extractor] extractPageGlyphs failed:', err);
  }

  return result;
}
