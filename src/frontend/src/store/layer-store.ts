/**
 * Layer visibility and color state for multi-layer boards.
 *
 * Stored per-tab in BoardTab. This module provides the default palette
 * and helper functions for layer state management.
 */
import { themeStore, type Theme } from './themes';

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

/** A layer's default colour under a theme. A theme with copper colours
 *  (Dark, Landrex, Light, Atari) gives the top and bottom copper its own pair
 *  — blue / amber on the dark schemes, never the red and green the pins use
 *  for power and side — and inner layers keep the palette. */
export function defaultLayerColor(name: string, index: number, theme: Theme = themeStore.activeTheme()): number {
  const u = name.toUpperCase();
  const { copperTop, copperBottom } = theme.board;
  if (copperTop && copperBottom) {
    if (u.includes('BOTTOM') || /\bBOT\b/.test(u) || u.startsWith('B.') || u === 'B_CU') return hexToColor(copperBottom);
    if (u.includes('TOP') || u.startsWith('F.') || u === 'F_CU') return hexToColor(copperTop);
  }
  return DEFAULT_LAYER_PALETTE[index % DEFAULT_LAYER_PALETTE.length];
}

export interface LayerState {
  visible: boolean;
  color: number;
  name: string;
}

/** Create initial layer states from board layer names.
 *  By default only the primary view layer is visible (TVW butterfly
 *  convention — you navigate one layer at a time). For formats that
 *  expose layer names but still rely on the side toggle as the primary
 *  visibility control (Altium, where hasLayers=false), pass
 *  `allVisible: true` so the side toggle alone gates the trace/pour
 *  visibility instead of an additional per-layer mask. */
export function createLayerStates(
  layerNames: string[],
  primarySide?: 'top' | 'bottom',
  allVisible = false,
): LayerState[] {
  // Find the index of the primary layer
  const side = primarySide ?? 'top';
  const primaryIdx = side === 'bottom'
    ? layerNames.findIndex(n => { const u = n.toUpperCase(); return u.includes('BOTTOM') || u.includes('BOT'); })
    : layerNames.findIndex(n => n.toUpperCase().includes('TOP'));

  return layerNames.map((name, i) => ({
    visible: allVisible ? true : (primaryIdx >= 0 ? i === primaryIdx : i === 0),
    color: defaultLayerColor(name, i),
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
