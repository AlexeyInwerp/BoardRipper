/**
 * Contrast gates for the palette schemes (docs/specs/2026-10-11-colour-schemes-review.md).
 *
 * Every scheme that owns the board's colours must keep labels readable on the
 * board and on every part body (≥ 4.5:1) and keep pins, the selection and the
 * selected-part outline visible (≥ 3:1). Bodies are measured as drawn: the
 * part tint at the scheme's fill opacity over the board sheet, and the board
 * sheet is the board fill at the scheme's board-fill opacity over the canvas.
 *
 * BoardRipper Default has no palette and is deliberately left as it is, so it
 * is not gated here.
 */
import { describe, it, expect } from 'vitest';
import { THEMES, paletteOverrides, type PinRole } from './themes';
import { DEFAULTS, DEFAULT_PIN_GROUPS } from './render-settings';
import { contrastRatio, parseHex, rgbToHex } from './color-math';

function mix(a: string, b: string, t: number): string {
  const x = parseHex(a), y = parseHex(b);
  return rgbToHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t });
}

const paletteThemes = Object.values(THEMES).filter(t => t.palette);

describe('palette schemes pass the contrast gates', () => {
  it('there are four of them, and Default is not one', () => {
    expect(paletteThemes.map(t => t.id).sort()).toEqual(['atari', 'dark', 'landrex', 'light']);
    expect(THEMES.default.palette).toBeUndefined();
  });

  for (const t of paletteThemes) {
    const p = t.palette!;
    const board = mix(t.board.canvasBackground, t.board.boardFill, p.boardFillAlpha ?? DEFAULTS.boardFillAlpha);

    it(`${t.label}: labels ≥ 4.5:1 on the board`, () => {
      for (const ink of [t.board.labelText, t.board.labelPart]) expect(contrastRatio(ink, board)).toBeGreaterThanOrEqual(4.5);
    });

    it(`${t.label}: part labels ≥ 4.5:1 on every part body`, () => {
      if (!p.partTints) return;   // outline-only parts: the label sits on the board
      const alpha = p.componentFillAlpha ?? DEFAULTS.componentFillAlpha;
      for (const [type, tint] of Object.entries(p.partTints)) {
        const body = mix(board, tint, alpha);
        expect(contrastRatio(t.board.labelPart, body), `${type} ${tint}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${t.label}: every pin role ≥ 3:1 on the board`, () => {
      for (const [role, c] of Object.entries(p.pins) as [PinRole, string][]) {
        expect(contrastRatio(c, board), `${role} ${c}`).toBeGreaterThanOrEqual(3);
      }
    });

    it(`${t.label}: selection and selected part ≥ 3:1 on the board`, () => {
      expect(contrastRatio(t.board.selection, board)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(t.board.selectedPart!, board)).toBeGreaterThanOrEqual(3);
    });

    it(`${t.label}: net lines ≥ 3:1 on the board, and the two line colours differ`, () => {
      expect(contrastRatio(p.netLine, board), p.netLine).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(p.adjacentNetLine, board), p.adjacentNetLine).toBeGreaterThanOrEqual(3);
      expect(p.netLine).not.toBe(p.adjacentNetLine);
    });

    it(`${t.label}: the underside has its own code, and it is not the power colour`, () => {
      expect(p.pins.signalBottom).not.toBe(p.pins.signalTop);
      expect(p.pins.signalBottom).not.toBe(p.pins.power);
    });
  }
});

describe('paletteOverrides keeps the user\'s rules and only swaps colours', () => {
  it('built-in rules take the role colour; a rule the user added keeps its own', () => {
    const custom = { id: 'mine', keywords: 'VBUS', color: '#123456' };
    const groups = DEFAULT_PIN_GROUPS.map(g => g.id === 'power' ? { ...g, rules: [...g.rules, custom] } : g);
    const ov = paletteOverrides(THEMES.dark.palette!, { ...DEFAULTS, pinGroups: groups });
    const power = ov.pinGroups!.find(g => g.id === 'power')!;
    expect(power.rules.find(r => r.id === 'power-v')!.color).toBe(THEMES.dark.palette!.pins.power);
    expect(power.rules.find(r => r.id === 'power-v')!.keywords).toBe('VCC, 3VA, VDD, VSG, 3VS, 5VS');
    expect(power.rules.find(r => r.id === 'mine')!.color).toBe('#123456');
    expect(ov.defaultPinColorTop).toBe(THEMES.dark.palette!.pins.signalTop);
    expect(ov.defaultPinColorBottom).toBe(THEMES.dark.palette!.pins.signalBottom);
  });

  it('net-line colours come from the palette', () => {
    const ov = paletteOverrides(THEMES.light.palette!, DEFAULTS);
    expect(ov.netLineColor).toBe(0xc26f00);
    expect(ov.adjacentNetLineColor).toBe(0x2f6db5);
  });

  it('outline-only schemes turn part colours off; tinted ones recolour by type id', () => {
    expect(paletteOverrides(THEMES.landrex.palette!, DEFAULTS).showComponentColors).toBe(false);
    const ov = paletteOverrides(THEMES.atari.palette!, DEFAULTS);
    expect(ov.showComponentColors).toBe(true);
    expect(ov.partTypes!.find(t => t.id === 'ic')!.color).toBe(THEMES.atari.palette!.partTints!.ic);
    expect(ov.partTypes!.find(t => t.id === 'ic')!.prefixes).toEqual(DEFAULTS.partTypes.find(t => t.id === 'ic')!.prefixes);
  });
});
