/**
 * GenCAD (.cad) Parser
 *
 * GenCAD is a plain-text PCB interchange format. This parser handles the
 * subset needed for boardview rendering:
 *
 *   $HEADER    — version, units, origin
 *   $SHAPES    — footprint definitions with pin positions
 *   $COMPONENTS — component placements (name, position, layer, rotation, shape)
 *   $DEVICES   — part descriptions (BOM info)
 *   $SIGNALS   — net connectivity (signal → component.pin nodes)
 *
 * Coordinates: GenCAD uses "UNITS USER <n>" where n is a divisor.
 * UNITS USER 1000 means raw coords are in mils × 1 (divisor applied at parse).
 *
 * Reference: GenCAD 1.4 specification, OpenBoardView GenCADFile.cpp
 */

import type { BoardData, Part, Pin, Nail, Point } from './types';
import { computeBBox, buildNets, computePartGeometry, generateSyntheticOutline } from './types';

const decoder = new TextDecoder('utf-8');

// ---------------------------------------------------------------------------
// Section extraction
// ---------------------------------------------------------------------------

/** Extract lines between $NAME and $ENDNAME (exclusive of both markers). */
function extractSection(lines: string[], name: string): string[] {
  const start = `$${name}`;
  const end   = `$END${name}`;
  const result: string[] = [];
  let inside = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === start) { inside = true; continue; }
    if (trimmed === end) break;
    if (inside) result.push(line);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Shape parsing (pin templates)
// ---------------------------------------------------------------------------

interface ShapePin {
  name: string;
  x: number;
  y: number;
  side: 'top' | 'bottom';
}

interface Shape {
  name: string;
  pins: ShapePin[];
  insertType: 'smd' | 'throughhole';
}

function parseShapes(lines: string[]): Map<string, Shape> {
  const shapes = new Map<string, Shape>();
  let current: Shape | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('SHAPE ')) {
      // SHAPE <name>
      const name = line.substring(6).trim();
      current = { name, pins: [], insertType: 'smd' };
      shapes.set(name, current);
    } else if (line.startsWith('PIN ') && current) {
      // PIN <name> <padstack> <x> <y> <side> <rot> <mirror>
      const parts = line.split(/\s+/);
      if (parts.length >= 6) {
        const pinName = parts[1];
        const x = parseFloat(parts[3]);
        const y = parseFloat(parts[4]);
        const sideStr = (parts[5] ?? '').toUpperCase();
        const side: 'top' | 'bottom' = sideStr === 'BOTTOM' ? 'bottom' : 'top';
        if (!isNaN(x) && !isNaN(y)) {
          current.pins.push({ name: pinName, x, y, side });
        }
      }
    } else if (line.startsWith('INSERT ') && current) {
      const insert = line.substring(7).trim().toUpperCase();
      current.insertType = insert === 'TH' || insert === 'THROUGHHOLE' ? 'throughhole' : 'smd';
    }
  }

  return shapes;
}

// ---------------------------------------------------------------------------
// Component parsing
// ---------------------------------------------------------------------------

interface Component {
  name: string;
  placeX: number;
  placeY: number;
  layer: 'top' | 'bottom';
  rotation: number;
  shapeName: string;
  deviceName: string;
}

function parseComponents(lines: string[]): Component[] {
  const components: Component[] = [];
  let current: Partial<Component> | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('COMPONENT ')) {
      if (current?.name) components.push(current as Component);
      current = {
        name: line.substring(10).trim(),
        placeX: 0, placeY: 0,
        layer: 'top', rotation: 0,
        shapeName: '', deviceName: '',
      };
    } else if (current) {
      if (line.startsWith('PLACE ')) {
        const parts = line.split(/\s+/);
        current.placeX = parseFloat(parts[1] ?? '0');
        current.placeY = parseFloat(parts[2] ?? '0');
      } else if (line.startsWith('LAYER ')) {
        current.layer = line.substring(6).trim().toUpperCase() === 'BOTTOM' ? 'bottom' : 'top';
      } else if (line.startsWith('ROTATION ')) {
        current.rotation = parseFloat(line.substring(9).trim()) || 0;
      } else if (line.startsWith('SHAPE ')) {
        // SHAPE <name> <mirrorX> <mirrorY>
        current.shapeName = line.split(/\s+/)[1] ?? '';
      } else if (line.startsWith('DEVICE ')) {
        current.deviceName = line.substring(7).trim();
      }
    }
  }
  if (current?.name) components.push(current as Component);

  return components;
}

// ---------------------------------------------------------------------------
// Signal (net) parsing
// ---------------------------------------------------------------------------

/** Returns map of "component.pin" → net name */
function parseSignals(lines: string[]): Map<string, string> {
  const pinNetMap = new Map<string, string>();
  let currentSignal = '';

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('SIGNAL ')) {
      currentSignal = line.substring(7).trim();
    } else if (line.startsWith('NODE ') && currentSignal) {
      // NODE <component> <pin>
      const parts = line.split(/\s+/);
      if (parts.length >= 3) {
        const key = `${parts[1]}.${parts[2]}`;
        pinNetMap.set(key, currentSignal);
      }
    }
  }

  return pinNetMap;
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

export function parseCAD(buffer: ArrayBuffer): BoardData {
  const text = decoder.decode(buffer);
  const lines = text.split(/\r?\n/);

  // Parse sections
  // Note: UNITS USER 1000 means "1000 units per inch" = coordinates are in mils.
  // Our internal coordinate system is mils, so no conversion needed.
  const shapes     = parseShapes(extractSection(lines, 'SHAPES'));
  const components = parseComponents(extractSection(lines, 'COMPONENTS'));
  const pinNetMap  = parseSignals(extractSection(lines, 'SIGNALS'));

  // Assemble parts
  const parts: Part[] = [];

  for (const comp of components) {
    const shape = shapes.get(comp.shapeName);
    if (!shape) continue;

    const pins: Pin[] = [];
    for (const sp of shape.pins) {
      // Apply component placement offset + rotation
      let px = sp.x, py = sp.y;
      if (comp.rotation !== 0) {
        const rad = (comp.rotation * Math.PI) / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const rx = px * cos - py * sin;
        const ry = px * sin + py * cos;
        px = rx; py = ry;
      }
      px += comp.placeX;
      py += comp.placeY;

      // Look up net
      const netKey = `${comp.name}.${sp.name}`;
      const net = pinNetMap.get(netKey) ?? '';

      const side = comp.layer === 'bottom' ? 'bottom' : sp.side;

      pins.push({
        name:     sp.name,
        number:   sp.name,
        position: { x: px, y: py },
        radius:   6,
        side,
        net,
      });
    }

    const { origin, bounds } = computePartGeometry(pins);

    parts.push({
      name:   comp.name,
      side:   comp.layer,
      type:   shape.insertType,
      origin,
      pins,
      bounds,
    });
  }

  // No nails in GenCAD (test points would need $TESTPINS section)
  const nails: Nail[] = [];

  if (parts.length === 0) {
    throw new Error('CAD file parsed but contains no parts — file may be corrupt or empty');
  }

  // Board outline — GenCAD $BOARD section can define it, but often empty.
  // Generate from pin bounds like FZ.
  const allPoints: Point[] = parts.flatMap(p => p.pins.map(pin => pin.position));
  const outline = generateSyntheticOutline(allPoints);

  const bounds = computeBBox([...outline, ...allPoints]);
  const nets = buildNets(parts);

  return { format: 'CAD', outline, parts, nails, nets, bounds };
}
