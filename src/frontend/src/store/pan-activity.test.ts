import { describe, it, expect } from 'vitest';
import { PanActivity } from './pan-activity';

const W = 1000, H = 800;

/** Pan by (dx, dy) screen px in 10 frames, 16 ms apart, starting at `t`. */
function pan(a: PanActivity, t: number, dx: number, dy: number, zoom = 4): { end: number; shown: boolean } {
  let shown = false;
  for (let i = 0; i < 10; i++) shown = a.move(t + i * 16, { dx: dx / 10, dy: dy / 10, width: W, height: H, zoom });
  return { end: t + 144, shown };
}

describe('PanActivity', () => {
  it('stays hidden for a short pan', () => {
    expect(pan(new PanActivity(), 0, 100, 0).shown).toBe(false);   // 10 % of the width
  });

  it('shows once the travel passes 12 % of the screen in either axis', () => {
    expect(pan(new PanActivity(), 0, 130, 0).shown).toBe(true);
    expect(pan(new PanActivity(), 0, 0, -100).shown).toBe(true);   // 12.5 % of the height
  });

  it('adds up the pans of one chain', () => {
    const a = new PanActivity();
    let g = pan(a, 0, 70, 0);
    expect(g.shown).toBe(false);
    g = pan(a, g.end + 400, 70, 0);
    expect(g.shown).toBe(true);
  });

  it('counts net travel, so wiggling in place does not show it', () => {
    const a = new PanActivity();
    let g = { end: 0, shown: false };
    for (let i = 0; i < 6; i++) g = pan(a, g.end + 200, i % 2 ? -100 : 100, 0);
    expect(g.shown).toBe(false);
  });

  it('a long pause starts a new chain', () => {
    const a = new PanActivity();
    const g = pan(a, 0, 70, 0);
    expect(pan(a, g.end + 3000, 70, 0).shown).toBe(false);
  });

  it('never shows below 2× the fit view', () => {
    expect(pan(new PanActivity(), 0, 600, 0, 1.9).shown).toBe(false);
    expect(pan(new PanActivity(), 0, 600, 0, 2).shown).toBe(true);
  });

  it('hides after panning stops and starts afresh', () => {
    const a = new PanActivity();
    const g = pan(a, 0, 200, 0);
    expect(a.visible(g.end + 500)).toBe(true);
    expect(a.visible(g.end + 1000)).toBe(false);
    expect(pan(a, g.end + 1100, 50, 0).shown).toBe(false);
  });
});
