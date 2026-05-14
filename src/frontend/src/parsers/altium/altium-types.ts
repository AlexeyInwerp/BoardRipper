/**
 * Altium PCB intermediate types — P1 subset.
 *
 * Field shapes mirror KiCad's altium_parser_pcb.h. Coordinates kept in raw
 * Altium units (1/10000 mil); the assembler converts via altium-units.ts.
 */

import type { AltiumLayer } from './altium-layers';

export interface ABoard6 {
  name: string;
  originX: number;
  originY: number;
  layerNames: string[];
  formatVersion: string;
}

export interface AComponent6 {
  designator: string;
  pattern: string;
  componentName: string;
  description: string;
  layer: AltiumLayer | number;
  x: number;
  y: number;
  rotation: number;
  locked: boolean;
}

export interface APad6 {
  name: string;
  componentIndex: number;
  netIndex: number;
  layer: number;
  x: number;
  y: number;
  xsize: number;
  ysize: number;
  topShape: number;
  holeSize: number;
  rotation: number;
  isThroughHole: boolean;
}

export interface ANet6 {
  name: string;
}

export interface AClass6 {
  name: string;
  kind: 'NET' | 'COMPONENT' | 'PAD' | 'OTHER';
  memberNames: string[];
}

export interface AWideStringTable {
  byIndex(idx: number): string;
}

export interface ATrack6 {
  layer: number;
  netIndex: number;
  componentIndex: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  width: number;
}

export interface AVia6 {
  netIndex: number;
  x: number;
  y: number;
  diameter: number;
  holeSize: number;
  layerStart: number;
  layerEnd: number;
}

export interface AArc6 {
  layer: number;
  netIndex: number;
  componentIndex: number;
  centerX: number;
  centerY: number;
  radius: number;
  /** degrees */
  startAngle: number;
  /** degrees */
  endAngle: number;
  width: number;
}

export interface AFill6 {
  layer: number;
  netIndex: number;
  componentIndex: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** degrees */
  rotation: number;
}

export interface ARegion6 {
  layer: number;
  netIndex: number;
  componentIndex: number;
  /** Outer polygon vertices in raw Altium units (Y in Altium orientation). */
  vertices: { x: number; y: number }[];
  /** Optional inner cutout polygons. */
  holes: { x: number; y: number }[][];
  /** From the property bag: 0=COPPER, 1=POLYGON_CUTOUT, 4=CAVITY_DEFINITION, 5=BOARD_CUTOUT. */
  kind: number;
  /** From the property bag: true if vertices use the extended encoding (with per-vertex arc data). */
  isShapeBased: boolean;
}

export interface AltiumPcbDb {
  board: ABoard6;
  components: AComponent6[];
  pads: APad6[];
  tracks: ATrack6[];
  vias: AVia6[];
  arcs: AArc6[];
  fills: AFill6[];
  regions: ARegion6[];
  nets: ANet6[];
  classes: AClass6[];
  wideStrings: AWideStringTable;
}
