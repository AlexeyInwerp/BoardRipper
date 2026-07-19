/** Spatial hash for trace segments — parallels the part hitGrid
 *  (BoardRenderer.buildHitGrid) so hover misses stop scanning every trace
 *  (audit finding A2). Pure module: unit-tested in trace-grid.test.ts. */

export interface SegmentLike {
  start: { x: number; y: number };
  end: { x: number; y: number };
  width?: number;
}

export interface TraceGrid {
  cells: Map<string, number[]>;
  cellSize: number;
  /** Largest half-width across all segments — added to the query radius so a
   *  point inside a fat trace whose centerline is in a neighbouring cell is
   *  still found. */
  maxHalfWidth: number;
}

export function buildTraceGrid(traces: readonly SegmentLike[], cellSize: number): TraceGrid {
  const cells = new Map<string, number[]>();
  let maxHalfWidth = 0;
  for (let i = 0; i < traces.length; i++) {
    const t = traces[i];
    const halfW = (t.width || 1) / 2;
    if (halfW > maxHalfWidth) maxHalfWidth = halfW;
    const minX = Math.min(t.start.x, t.end.x) - halfW;
    const maxX = Math.max(t.start.x, t.end.x) + halfW;
    const minY = Math.min(t.start.y, t.end.y) - halfW;
    const maxY = Math.max(t.start.y, t.end.y) + halfW;
    const x0 = Math.floor(minX / cellSize), x1 = Math.floor(maxX / cellSize);
    const y0 = Math.floor(minY / cellSize), y1 = Math.floor(maxY / cellSize);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const key = `${gx},${gy}`;
        let cell = cells.get(key);
        if (!cell) { cell = []; cells.set(key, cell); }
        cell.push(i);
      }
    }
  }
  return { cells, cellSize, maxHalfWidth };
}

/** Candidate segment indices within `tol` of (x, y). Deduplicated. */
export function queryTraceGrid(grid: TraceGrid, x: number, y: number, tol: number): number[] {
  const reach = tol + grid.maxHalfWidth;
  const x0 = Math.floor((x - reach) / grid.cellSize), x1 = Math.floor((x + reach) / grid.cellSize);
  const y0 = Math.floor((y - reach) / grid.cellSize), y1 = Math.floor((y + reach) / grid.cellSize);
  const seen = new Set<number>();
  for (let gx = x0; gx <= x1; gx++) {
    for (let gy = y0; gy <= y1; gy++) {
      const cell = grid.cells.get(`${gx},${gy}`);
      if (cell) for (const i of cell) seen.add(i);
    }
  }
  return Array.from(seen);
}
