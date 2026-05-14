/**
 * Altium PCB → BoardData assembler.
 *
 * Phase 1: parts + pins + nets + outline (synthetic from part-bounds union).
 * Unit conversion happens here — decoders deal in raw Altium units; the
 * assembler converts to mils via altium-units.ts at the boundary.
 */

import type { BoardData, Part, Pin, Point, Net, Pad } from '../types';
import { buildNets, computeBBox, generateSyntheticOutline } from '../types';
import type { AltiumPcbDb, AComponent6, APad6 } from './altium-types';
import { altiumToMils, altiumYToMils, altiumAngleToDegrees } from './altium-units';
import { altiumLayerSide } from './altium-layers';

function partSide(c: AComponent6): 'top' | 'bottom' {
  const side = altiumLayerSide(c.layer);
  return side === 'bottom' ? 'bottom' : 'top';
}

function pinSide(p: APad6): 'top' | 'bottom' {
  const side = altiumLayerSide(p.layer);
  if (side === 'both') return 'top';
  return side;
}

function pinNet(p: APad6, netNames: string[]): string {
  if (p.netIndex < 0 || p.netIndex >= netNames.length) return '';
  return netNames[p.netIndex];
}

export function assembleBoardData(db: AltiumPcbDb): BoardData {
  const netNames = db.nets.map(n => n.name);

  const padsByComp = new Map<number, APad6[]>();
  for (const pad of db.pads) {
    const arr = padsByComp.get(pad.componentIndex) ?? [];
    arr.push(pad);
    padsByComp.set(pad.componentIndex, arr);
  }

  const parts: Part[] = [];
  for (let ci = 0; ci < db.components.length; ci++) {
    const comp = db.components[ci];
    const compRot = altiumAngleToDegrees(comp.rotation);
    const side = partSide(comp);

    const pins: Pin[] = (padsByComp.get(ci) ?? []).map(pad => {
      const xMils = altiumToMils(pad.x);
      const yMils = altiumYToMils(pad.y);
      const w = altiumToMils(pad.xsize);
      const h = altiumToMils(pad.ysize);
      return {
        name: pad.name,
        number: pad.name,
        position: { x: xMils, y: yMils },
        radius: Math.max(2, Math.min(w, h) / 2),
        side: pinSide(pad),
        net: pinNet(pad, netNames),
        padBounds: {
          minX: xMils - w / 2,
          minY: yMils - h / 2,
          maxX: xMils + w / 2,
          maxY: yMils + h / 2,
        },
        padShape: pad.topShape === 1 ? 'round' : 'rect',
        padWidth: w,
        padHeight: h,
        padAngleDeg: altiumAngleToDegrees(pad.rotation),
      };
    });

    const origin: Point = {
      x: altiumToMils(comp.x),
      y: altiumYToMils(comp.y),
    };
    const bounds = pins.length > 0
      ? computeBBox(pins.map(p => p.position))
      : { minX: origin.x - 50, minY: origin.y - 50, maxX: origin.x + 50, maxY: origin.y + 50 };

    parts.push({
      name: comp.designator || `_unnamed_${ci}`,
      side,
      type: 'smd',
      origin,
      pins,
      bounds,
      meta: {
        package: comp.pattern,
        partType: comp.componentName,
        angleDeg: compRot,
      },
    });
  }

  // Through-hole detection: any pad on MULTI_LAYER makes the parent component throughhole.
  for (let i = 0; i < parts.length; i++) {
    const pads = padsByComp.get(i) ?? [];
    if (pads.some(pad => pad.isThroughHole)) parts[i].type = 'throughhole';
  }

  const allPoints: Point[] = [];
  for (const p of parts) for (const pin of p.pins) allPoints.push(pin.position);
  const bounds = allPoints.length > 0
    ? computeBBox(allPoints)
    : { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
  const outline = generateSyntheticOutline(allPoints, 50);

  const nets: Map<string, Net> = buildNets(parts);

  const pads: Pad[] = buildPads(db.pads, netNames);

  return {
    format: 'ALTIUM_PCB',
    formatVersion: db.board.formatVersion || undefined,
    outline,
    parts,
    nails: [],
    nets,
    bounds,
    pads,
  };
}

function padSide(p: APad6): 'top' | 'bottom' | 'both' {
  return altiumLayerSide(p.layer);
}

function padShape(topShape: number): 'round' | 'rect' | 'roundrect' {
  switch (topShape) {
    case 1: return 'round';
    case 9: return 'roundrect';
    default: return 'rect';
  }
}

function buildPads(decoded: APad6[], netNames: string[]): Pad[] {
  const out: Pad[] = [];
  for (const pad of decoded) {
    const xMils = altiumToMils(pad.x);
    const yMils = altiumYToMils(pad.y);
    const w = altiumToMils(pad.xsize);
    const h = altiumToMils(pad.ysize);
    // Skip the zero-size sentinel pads that signal "shape in subrecord 6"
    // (currently unparsed — see ALTIUM_PCB_FORMAT.md). They'd render as
    // single pixels and clutter the pads layer.
    if (w <= 0 || h <= 0) continue;
    const side = padSide(pad);
    const net = pad.netIndex >= 0 && pad.netIndex < netNames.length
      ? netNames[pad.netIndex]
      : undefined;
    out.push({
      bounds: {
        minX: xMils - w / 2,
        minY: yMils - h / 2,
        maxX: xMils + w / 2,
        maxY: yMils + h / 2,
      },
      side,
      net,
      drill: pad.isThroughHole && pad.holeSize > 0 ? altiumToMils(pad.holeSize) : undefined,
      attached: pad.componentIndex >= 0,
      shape: padShape(pad.topShape),
      width: w,
      height: h,
      angleDeg: altiumAngleToDegrees(pad.rotation),
    });
  }
  return out;
}
