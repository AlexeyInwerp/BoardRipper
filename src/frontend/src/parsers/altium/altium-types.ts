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

export interface AltiumPcbDb {
  board: ABoard6;
  components: AComponent6[];
  pads: APad6[];
  nets: ANet6[];
  classes: AClass6[];
  wideStrings: AWideStringTable;
}
