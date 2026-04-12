/**
 * TileManager — grid-based viewport rendering for PDF pages.
 *
 * Divides a page into fixed-size tiles (default 1024×1024 pixels).
 * Only tiles intersecting the visible viewport are rendered.
 * Cached tiles are reused on pan (zero re-render cost).
 * Zoom changes invalidate tiles and re-render at the new scale.
 */

import { log } from '../store/log-store';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TileCoord {
  col: number;
  row: number;
}

export interface CachedTile {
  bitmap: ImageBitmap;
  col: number;
  row: number;
  scale: number; // the quantised render scale this tile was rendered at
}

export interface TileRenderRequest {
  col: number;
  row: number;
  /** Source rect in PDF coordinate space (unscaled) */
  srcX: number;
  srcY: number;
  srcW: number;
  srcH: number;
  /** Pixel dimensions of this tile (may be smaller at page edges) */
  pixelW: number;
  pixelH: number;
}

export interface TileGridInfo {
  cols: number;
  rows: number;
  /** The render scale used (baseScale × tier, after clamping) */
  renderScale: number;
  /** Page pixel dimensions at this scale */
  pagePixelW: number;
  pagePixelH: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TILE_SIZE = 1024;

// ---------------------------------------------------------------------------
// Tile Cache (LRU, keyed by file:page:col:row:scale)
// ---------------------------------------------------------------------------

let _tileCacheMaxPixels = 80_000_000;
let _tileCacheTotalPixels = 0;
const _tileCache = new Map<string, CachedTile>();

export function setTileCacheLimit(maxPixels: number): void {
  _tileCacheMaxPixels = maxPixels;
}

function tileCacheKey(file: string, page: number, col: number, row: number, scale: number): string {
  return `${file}:${page}:${col}:${row}:${scale}`;
}

export function getTileCached(file: string, page: number, col: number, row: number, scale: number): CachedTile | undefined {
  const key = tileCacheKey(file, page, col, row, scale);
  const entry = _tileCache.get(key);
  if (entry) {
    // LRU: move to end
    _tileCache.delete(key);
    _tileCache.set(key, entry);
  }
  return entry;
}

/** Find the best (highest-scale) cached tile for a given grid position.
 *  Returns undefined if no tile is cached at any scale for this position. */
export function getBestTileCached(
  file: string, page: number, col: number, row: number,
): CachedTile | undefined {
  let best: CachedTile | undefined;
  for (const [, entry] of _tileCache) {
    if (entry.col === col && entry.row === row) {
      if (!best || entry.scale > best.scale) best = entry;
    }
  }
  if (best) {
    const key = tileCacheKey(file, page, best.col, best.row, best.scale);
    if (_tileCache.has(key)) {
      _tileCache.delete(key);
      _tileCache.set(key, best);
    }
  }
  return best;
}

export function putTileCached(file: string, page: number, tile: CachedTile): void {
  const key = tileCacheKey(file, page, tile.col, tile.row, tile.scale);
  const pixels = tile.bitmap.width * tile.bitmap.height;

  // Evict oldest until we have room
  while (_tileCache.size > 0 && _tileCacheTotalPixels + pixels > _tileCacheMaxPixels) {
    const oldest = _tileCache.keys().next().value!;
    const old = _tileCache.get(oldest)!;
    _tileCacheTotalPixels -= old.bitmap.width * old.bitmap.height;
    old.bitmap.close();
    _tileCache.delete(oldest);
  }

  // Replace existing entry for same key
  const existing = _tileCache.get(key);
  if (existing) {
    _tileCacheTotalPixels -= existing.bitmap.width * existing.bitmap.height;
    existing.bitmap.close();
  }

  _tileCacheTotalPixels += pixels;
  _tileCache.set(key, tile);
}

export function invalidateTileCache(file?: string): void {
  if (!file) {
    for (const e of _tileCache.values()) e.bitmap.close();
    _tileCache.clear();
    _tileCacheTotalPixels = 0;
    return;
  }
  for (const [k, v] of _tileCache) {
    if (k.startsWith(file + ':')) {
      _tileCacheTotalPixels -= v.bitmap.width * v.bitmap.height;
      v.bitmap.close();
      _tileCache.delete(k);
    }
  }
}

// ---------------------------------------------------------------------------
// Grid computation
// ---------------------------------------------------------------------------

/** Compute the tile grid dimensions for a page at a given render scale. */
export function computeTileGrid(
  pageUnscaledW: number, pageUnscaledH: number, renderScale: number,
): TileGridInfo {
  const pagePixelW = Math.ceil(pageUnscaledW * renderScale);
  const pagePixelH = Math.ceil(pageUnscaledH * renderScale);
  return {
    cols: Math.ceil(pagePixelW / TILE_SIZE),
    rows: Math.ceil(pagePixelH / TILE_SIZE),
    renderScale,
    pagePixelW,
    pagePixelH,
  };
}

/** Compute which tiles intersect a viewport rect (in page-pixel space). */
export function visibleTiles(
  viewportX: number, viewportY: number, viewportW: number, viewportH: number,
  grid: TileGridInfo,
): TileCoord[] {
  const colStart = Math.max(0, Math.floor(viewportX / TILE_SIZE));
  const colEnd = Math.min(grid.cols - 1, Math.floor((viewportX + viewportW) / TILE_SIZE));
  const rowStart = Math.max(0, Math.floor(viewportY / TILE_SIZE));
  const rowEnd = Math.min(grid.rows - 1, Math.floor((viewportY + viewportH) / TILE_SIZE));

  const tiles: TileCoord[] = [];
  for (let row = rowStart; row <= rowEnd; row++) {
    for (let col = colStart; col <= colEnd; col++) {
      tiles.push({ col, row });
    }
  }

  // Sort center-out: tiles closer to viewport center render first
  const centerCol = (colStart + colEnd) / 2;
  const centerRow = (rowStart + rowEnd) / 2;
  tiles.sort((a, b) => {
    const da = Math.abs(a.col - centerCol) + Math.abs(a.row - centerRow);
    const db = Math.abs(b.col - centerCol) + Math.abs(b.row - centerRow);
    return da - db;
  });

  return tiles;
}

/** Build a render request for a specific tile. */
export function tileRenderRequest(
  col: number, row: number, grid: TileGridInfo,
): TileRenderRequest {
  const pixelX = col * TILE_SIZE;
  const pixelY = row * TILE_SIZE;
  // Tile may be smaller at page edges
  const pixelW = Math.min(TILE_SIZE, grid.pagePixelW - pixelX);
  const pixelH = Math.min(TILE_SIZE, grid.pagePixelH - pixelY);
  // Source rect in PDF coordinate space (unscaled)
  const srcX = pixelX / grid.renderScale;
  const srcY = pixelY / grid.renderScale;
  const srcW = pixelW / grid.renderScale;
  const srcH = pixelH / grid.renderScale;

  return { col, row, srcX, srcY, srcW, srcH, pixelW, pixelH };
}

/** Compute viewport rect in page-pixel space from pan/zoom refs. */
export function viewportToPagePixels(
  panX: number, panY: number, zoom: number,
  containerW: number, containerH: number,
  baseScale: number, renderScale: number,
): { x: number; y: number; w: number; h: number } {
  // The wrapper has transform: translate(panX, panY) scale(zoom).
  // A point at container coords (cx, cy) maps to wrapper coords:
  //   wx = (cx - panX) / zoom
  //   wy = (cy - panY) / zoom
  // Wrapper coords map to page-pixel coords:
  //   px = wx * (renderScale / baseScale)  [because cssW = containerW, rendered at renderScale]
  //   Simplification: since cssW maps to pagePixelW, ratio = renderScale
  //   but cssW = containerW = pageUnscaledW * baseScale
  //   and pagePixelW = pageUnscaledW * renderScale
  //   so px = wx * (renderScale / baseScale) — but wx is already in CSS pixels (containerW space)
  //   Actually: wrapper child canvas has cssW = containerW. Its pixel content is pagePixelW.
  //   The ratio is pagePixelW / containerW = renderScale / baseScale.
  //   But we need viewport in PAGE-PIXEL space, not CSS space.

  const cssToPixel = renderScale / baseScale; // converts CSS px → page render pixels

  const x = (-panX / zoom) * cssToPixel;
  const y = (-panY / zoom) * cssToPixel;
  const w = (containerW / zoom) * cssToPixel;
  const h = (containerH / zoom) * cssToPixel;

  return { x, y, w, h };
}

/** Log tile stats for debugging */
export function logTileStats(): void {
  log.perf.log(`tile-cache: ${_tileCache.size} entries, ${Math.round(_tileCacheTotalPixels / 1_000_000)}MP / ${Math.round(_tileCacheMaxPixels / 1_000_000)}MP`);
}
