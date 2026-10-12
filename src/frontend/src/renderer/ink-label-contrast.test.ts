import { describe, it, expect } from 'vitest';
import { THEMES, hexToInt } from '../store/themes';
import { inkOn, contrastOf, haloFor } from './label-model';

// A light scheme's 'ink' selection styles fill every lit pin with the scheme's
// ink; board-scene gives each pin label an `inkColor` chosen against that ink
// (same expressions as there). It must read on the ink: WCAG ≥ 4.5.
describe('labels on ink-filled pins', () => {
  for (const t of Object.values(THEMES)) {
    if (!t.board.highlighter) continue;
    const ink = hexToInt(t.board.selectedPart ?? t.board.labelPart);
    for (const slot of ['labelText', 'labelNet'] as const) {
      it(`${t.id}: ${slot} on the ink reads`, () => {
        const c = inkOn(ink, hexToInt(t.board[slot]));
        expect(c).not.toBe(ink);
        expect(contrastOf(c, ink)).toBeGreaterThanOrEqual(4.5);
        // The halo the overlay draws under it is the opposite pole.
        expect(contrastOf(c, haloFor(c))).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});
