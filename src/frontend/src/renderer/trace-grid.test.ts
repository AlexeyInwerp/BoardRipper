import { describe, it, expect } from 'vitest';
import { buildTraceGrid, queryTraceGrid } from './trace-grid';

const seg = (x1: number, y1: number, x2: number, y2: number, width = 2) =>
  ({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, width });

describe('trace-grid', () => {
  it('returns candidates only near the segment', () => {
    const traces = [seg(0, 0, 100, 0), seg(0, 500, 100, 500)];
    const grid = buildTraceGrid(traces, 50);
    expect(queryTraceGrid(grid, 50, 2, 5)).toContain(0);
    expect(queryTraceGrid(grid, 50, 2, 5)).not.toContain(1);
    expect(queryTraceGrid(grid, 50, 498, 5)).toContain(1);
  });

  it('covers cells along a diagonal segment, not just endpoints', () => {
    const grid = buildTraceGrid([seg(0, 0, 400, 400)], 50);
    expect(queryTraceGrid(grid, 200, 205, 10)).toContain(0);
  });

  it('widens the query by tolerance + max half-width', () => {
    const grid = buildTraceGrid([seg(0, 100, 300, 100, 40)], 50);
    // point 30 units above the centerline: reachable because halfW(20)+tol(15)=35
    expect(queryTraceGrid(grid, 150, 70, 15)).toContain(0);
  });

  it('handles empty input', () => {
    const grid = buildTraceGrid([], 50);
    expect(queryTraceGrid(grid, 0, 0, 5)).toEqual([]);
  });
});
