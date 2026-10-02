import { describe, it, expect } from 'vitest';
import { PanActivity } from './pan-activity';

/** Drive a gesture of `frames` frames, 16 ms apart, starting at `t`. */
function gesture(a: PanActivity, t: number, frames = 10): { end: number; shown: boolean } {
  let shown = false;
  for (let i = 0; i < frames; i++) shown = a.move(t + i * 16);
  return { end: t + (frames - 1) * 16, shown };
}

describe('PanActivity', () => {
  it('stays hidden for one or two gestures', () => {
    const a = new PanActivity();
    let g = gesture(a, 0);
    expect(g.shown).toBe(false);
    g = gesture(a, g.end + 400);
    expect(g.shown).toBe(false);
  });

  it('shows on the third chained gesture and hides after panning stops', () => {
    const a = new PanActivity();
    let g = gesture(a, 0);
    g = gesture(a, g.end + 400);
    g = gesture(a, g.end + 400);
    expect(g.shown).toBe(true);
    expect(a.visible(g.end + 500)).toBe(true);
    expect(a.visible(g.end + 1000)).toBe(false);
  });

  it('does not chain gestures separated by a long pause', () => {
    const a = new PanActivity();
    let g = gesture(a, 0);
    g = gesture(a, g.end + 400);
    g = gesture(a, g.end + 3000);
    expect(g.shown).toBe(false);
  });

  it('one long continuous drag is one gesture', () => {
    const a = new PanActivity();
    expect(gesture(a, 0, 200).shown).toBe(false);
  });

  it('starts counting afresh after hiding', () => {
    const a = new PanActivity();
    let g = gesture(a, 0);
    g = gesture(a, g.end + 400);
    g = gesture(a, g.end + 400);
    expect(a.visible(g.end + 2000)).toBe(false);
    g = gesture(a, g.end + 2100);
    expect(g.shown).toBe(false);
  });
});
