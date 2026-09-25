import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mixHex, alphaHex, derivedUiTokens, pillVars, netWireVars } from './color-math';

describe('mixHex / alphaHex reproduce color-mix(in srgb, …)', () => {
  it('mixes per channel, first colour weighted by p', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixHex('#4a9eff', '#ffffff', 0.78)).toBe('#72b3ff'); // --accent-hover, default accent
    expect(mixHex('#ff0000', '#0000ff', 1)).toBe('#ff0000');
    expect(mixHex('#ff0000', '#0000ff', 0)).toBe('#0000ff');
  });
  it('alpha keeps the colour and sets the alpha', () => {
    expect(alphaHex('#4a9eff', 0.12)).toBe('rgba(74, 158, 255, 0.12)');
  });
});

describe('derivedUiTokens', () => {
  const DEFAULT = {
    bgPrimary: '#08080c', bgSecondary: '#0f0f18', bgTertiary: '#0c1424', border: '#1a1a28',
    textPrimary: '#e0e0e0', textSecondary: '#a0a0b0', accent: '#4a9eff',
  };
  const css = readFileSync(resolve(__dirname, '../index.css'), 'utf8');

  it('matches the :root first-paint fallbacks in index.css for the default palette', () => {
    const tokens = derivedUiTokens(DEFAULT);
    for (const [name, value] of Object.entries(tokens)) {
      const m = new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm').exec(css);
      expect(m, `${name} has no :root fallback in index.css`).not.toBeNull();
      expect(m![1].trim(), name).toBe(value);
    }
  });

  it('every token index.css reads is one derivedUiTokens produces (or a per-element one)', () => {
    const produced = new Set([
      ...Object.keys(derivedUiTokens(DEFAULT)),
      ...Object.keys(pillVars('#00d4ff', DEFAULT)),
      ...Object.keys(netWireVars('#00d4ff')),
    ]);
    const derivedNames = /var\(\s*(--(?:accent-(?:a|bg2-|bg3-|border-)\d+|accent-hover|scrim(?:-strong)?|tooltip-bg|surface-(?:hover|active)|chip-bg|highlight-(?:net|pin)|chrome-[\w-]+|danger-a\d+|text2-a\d+|border-a\d+|pill-(?:bg-|bg2-|border-|a)\d+|nw-(?:trace|rail|rowsel|bus|bus-edge|probe|rowhover|echo)))\b/g;
    const missing = new Set<string>();
    for (const m of css.matchAll(derivedNames)) if (!produced.has(m[1])) missing.add(m[1]);
    expect([...missing]).toEqual([]);
  });

  it('index.css contains no color-mix() — the floor is Safari 15.4, which has none', () => {
    expect(css.includes('color-mix(in')).toBe(false);
  });
});
