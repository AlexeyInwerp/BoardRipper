/**
 * Layer visibility and color state for multi-layer boards.
 *
 * Stored per-tab in BoardTab. This module provides the default palette
 * and helper functions for layer state management.
 */

/**
 * Default layer palette — 15 distinct colors forming a gradient-like
 * sequence that remains distinguishable on a dark background.
 * Order: warm → cool → accent, matching typical PCB layer ordering
 * (top copper, inner signals, bottom copper, drill).
 */
export const DEFAULT_LAYER_PALETTE: number[] = [
  0xcc3333, // 0  red        (top copper)
  0x33aa33, // 1  green      (bottom copper)
  0x3388dd, // 2  blue       (inner 1)
  0xddaa22, // 3  gold       (inner 2)
  0xcc55cc, // 4  magenta    (inner 3)
  0x22bbbb, // 5  cyan       (inner 4)
  0xee7733, // 6  orange
  0x77bb44, // 7  lime
  0x8866cc, // 8  purple
  0xdd5588, // 9  rose
  0x44aaaa, // 10 teal
  0xbbbb33, // 11 olive
  0x6699dd, // 12 sky blue
  0xcc8844, // 13 bronze
  0x88ccaa, // 14 sage
];

export interface LayerState {
  visible: boolean;
  color: number;
  name: string;
}

/** Create initial layer states from board layer names.
 *  Only the primary view layer is visible by default. */
export function createLayerStates(layerNames: string[], primarySide?: 'top' | 'bottom'): LayerState[] {
  // Find the index of the primary layer
  const side = primarySide ?? 'top';
  const primaryIdx = side === 'bottom'
    ? layerNames.findIndex(n => { const u = n.toUpperCase(); return u.includes('BOTTOM') || u.includes('BOT'); })
    : layerNames.findIndex(n => n.toUpperCase().includes('TOP'));

  return layerNames.map((name, i) => ({
    visible: primaryIdx >= 0 ? i === primaryIdx : i === 0,
    color: DEFAULT_LAYER_PALETTE[i % DEFAULT_LAYER_PALETTE.length],
    name,
  }));
}

/** Convert a hex number (0xRRGGBB) to CSS hex string (#RRGGBB) */
export function colorToHex(color: number): string {
  return '#' + color.toString(16).padStart(6, '0');
}

/** Convert a CSS hex string (#RRGGBB) to hex number (0xRRGGBB) */
export function hexToColor(hex: string): number {
  return parseInt(hex.replace('#', ''), 16);
}
