/**
 * Altium layer mapping.
 *
 * The full enum is large (82 values). Phase 1 only needs the side-determining
 * layers; the rest are placeholders that P2 will fill in.
 *
 * KiCad references:
 *   - altium_parser_pcb.h: enum ALTIUM_LAYER
 *   - altium_pcb.cpp: GetKicadLayer()
 */

export const ALTIUM_LAYER = {
  UNKNOWN: 0,
  TOP: 1,
  MID_LAYER_1: 2,
  MID_LAYER_2: 3,
  MID_LAYER_3: 4,
  MID_LAYER_4: 5,
  MID_LAYER_5: 6,
  MID_LAYER_6: 7,
  MID_LAYER_7: 8,
  MID_LAYER_8: 9,
  MID_LAYER_9: 10,
  MID_LAYER_10: 11,
  MID_LAYER_11: 12,
  MID_LAYER_12: 13,
  MID_LAYER_13: 14,
  MID_LAYER_14: 15,
  MID_LAYER_15: 16,
  MID_LAYER_16: 17,
  MID_LAYER_17: 18,
  MID_LAYER_18: 19,
  MID_LAYER_19: 20,
  MID_LAYER_20: 21,
  MID_LAYER_21: 22,
  MID_LAYER_22: 23,
  MID_LAYER_23: 24,
  MID_LAYER_24: 25,
  MID_LAYER_25: 26,
  MID_LAYER_26: 27,
  MID_LAYER_27: 28,
  MID_LAYER_28: 29,
  MID_LAYER_29: 30,
  MID_LAYER_30: 31,
  BOTTOM: 32,
  TOP_OVERLAY: 33,
  BOTTOM_OVERLAY: 34,
  TOP_PASTE: 35,
  BOTTOM_PASTE: 36,
  TOP_SOLDER: 37,
  BOTTOM_SOLDER: 38,
  MULTI_LAYER: 74,
} as const;

export type AltiumLayer = typeof ALTIUM_LAYER[keyof typeof ALTIUM_LAYER];

export function altiumLayerSide(layer: number): 'top' | 'bottom' | 'both' {
  switch (layer) {
    case ALTIUM_LAYER.BOTTOM:
    case ALTIUM_LAYER.BOTTOM_OVERLAY:
    case ALTIUM_LAYER.BOTTOM_PASTE:
    case ALTIUM_LAYER.BOTTOM_SOLDER:
      return 'bottom';
    case ALTIUM_LAYER.MULTI_LAYER:
      return 'both';
    default:
      return 'top';
  }
}

const NAME_TO_LAYER: ReadonlyMap<string, number> = (() => {
  const m = new Map<string, number>();
  m.set('TOP', ALTIUM_LAYER.TOP);
  m.set('BOTTOM', ALTIUM_LAYER.BOTTOM);
  m.set('MULTILAYER', ALTIUM_LAYER.MULTI_LAYER);
  m.set('TOPOVERLAY', ALTIUM_LAYER.TOP_OVERLAY);
  m.set('BOTTOMOVERLAY', ALTIUM_LAYER.BOTTOM_OVERLAY);
  m.set('TOPPASTE', ALTIUM_LAYER.TOP_PASTE);
  m.set('BOTTOMPASTE', ALTIUM_LAYER.BOTTOM_PASTE);
  m.set('TOPSOLDER', ALTIUM_LAYER.TOP_SOLDER);
  m.set('BOTTOMSOLDER', ALTIUM_LAYER.BOTTOM_SOLDER);
  for (let i = 1; i <= 30; i++) {
    m.set(`MID${i}`, ALTIUM_LAYER.MID_LAYER_1 + (i - 1));
    m.set(`MIDLAYER${i}`, ALTIUM_LAYER.MID_LAYER_1 + (i - 1));
  }
  return m;
})();

export function parseAltiumLayerName(name: string): number {
  const key = name.toUpperCase().replace(/[_ ]/g, '');
  return NAME_TO_LAYER.get(key) ?? ALTIUM_LAYER.UNKNOWN;
}
