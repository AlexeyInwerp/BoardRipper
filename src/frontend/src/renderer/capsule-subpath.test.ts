import { describe, it, expect } from 'vitest';
import { Graphics } from 'pixi.js';
import { drawPadShape, drawPinShape } from './board-scene';

/**
 * A capsule must be its own sub-path (issue: "oblong pins cause net line to be
 * drawn as a weird wedge", PL5TU1B).
 *
 * `arc()` follows Canvas2D semantics: with a current point already set it
 * draws a straight line from that point to the arc's start. Pin capsules share
 * a Graphics with part outlines and net-highlight geometry, all of which end
 * in closePath() and leave a current point behind — so a capsule that opened
 * with a bare arc() joined itself to whatever was drawn before it. On screen:
 * a wedge across the board, or a line to the board corner when the leftover
 * point was the origin.
 *
 * The guard is structural rather than visual: the first instruction a capsule
 * contributes must be a moveTo.
 */
const capsulePin = {
  name: '', number: '1', position: { x: 500, y: 400 }, radius: 4,
  side: 'top' as const, net: 'N', padShape: 'round' as const,
  padWidth: 60, padHeight: 15, padAngleDeg: 0,
};

const capsulePad = {
  bounds: { minX: 470, maxX: 530, minY: 392.5, maxY: 407.5 },
  side: 'top' as const, shape: 'round' as const, width: 60, height: 15, angleDeg: 0,
};

/** Path commands added by `draw`, as action names.
 *
 *  Pixi v8 accumulates path commands on the context's active GraphicsPath and
 *  only pushes to `context.instructions` on fill()/stroke(), so the active
 *  path is what has to be inspected here. */
function addedActions(gfx: Graphics, draw: () => void): string[] {
  const path = () => (gfx.context as unknown as {
    _activePath?: { instructions: Array<{ action: string }> };
  })._activePath?.instructions ?? [];
  const before = path().length;
  draw();
  return path().slice(before).map(i => i.action);
}

describe('capsule sub-path isolation', () => {
  it('drawPinShape opens with moveTo when the path already has a current point', () => {
    const gfx = new Graphics();
    // Stand in for a part outline / net-highlight shape drawn just before.
    gfx.moveTo(0, 0).lineTo(100, 0).lineTo(100, 100).closePath();
    const actions = addedActions(gfx, () => drawPinShape(gfx, capsulePin, 7.5));
    expect(actions[0]).toBe('moveTo');
    expect(actions).toEqual(['moveTo', 'arc', 'arc', 'closePath']);
  });

  it('drawPadShape opens with moveTo too — same latent bug on the pad layer', () => {
    const gfx = new Graphics();
    gfx.moveTo(0, 0).lineTo(100, 0).closePath();
    const actions = addedActions(gfx, () => drawPadShape(gfx, capsulePad));
    expect(actions[0]).toBe('moveTo');
  });

  it('two capsules in a row stay independent', () => {
    const gfx = new Graphics();
    drawPinShape(gfx, capsulePin, 7.5);
    const second = addedActions(gfx, () =>
      drawPinShape(gfx, { ...capsulePin, position: { x: 900, y: 400 } }, 7.5));
    // Without the anchor the second capsule would be joined to the first,
    // which is the wedge between two pins of one net.
    expect(second[0]).toBe('moveTo');
  });

  it('a round (non-oblong) pin still draws as a plain circle', () => {
    const gfx = new Graphics();
    const actions = addedActions(gfx, () =>
      drawPinShape(gfx, { ...capsulePin, padWidth: 20, padHeight: 20 }, 10));
    expect(actions).toEqual(['circle']);
  });
});
