/**
 * Static fake BoardData used by SettingsMockup.
 * Uses buildNets() so the net map is always consistent with the pin list.
 */
import type { BoardData, Part, Pin } from '../parsers';
import { buildNets } from '../parsers';

const U1_PINS: Pin[] = [
  { name: '1',  number: '1',  position: { x: 52, y: 48 }, radius: 5, side: 'top', net: 'VCC3V3' },
  { name: '2',  number: '2',  position: { x: 67, y: 48 }, radius: 5, side: 'top', net: 'GND'    },
  { name: '3',  number: '3',  position: { x: 82, y: 48 }, radius: 5, side: 'top', net: 'SDA'    },
  { name: '4',  number: '4',  position: { x: 52, y: 63 }, radius: 5, side: 'top', net: 'VCC3V3' },
  { name: '5',  number: '5',  position: { x: 67, y: 63 }, radius: 5, side: 'top', net: 'GND'    },
  { name: '6',  number: '6',  position: { x: 82, y: 63 }, radius: 5, side: 'top', net: 'GPIO0'  },
  { name: '7',  number: '7',  position: { x: 52, y: 78 }, radius: 5, side: 'top', net: 'RESET_N'},
  { name: '8',  number: '8',  position: { x: 67, y: 78 }, radius: 5, side: 'top', net: 'GND'    },
  { name: '9',  number: '9',  position: { x: 82, y: 78 }, radius: 5, side: 'top', net: 'MOSI'   },
  { name: '10', number: '10', position: { x: 52, y: 93 }, radius: 5, side: 'top', net: 'VCC3V3' },
  { name: '11', number: '11', position: { x: 67, y: 93 }, radius: 5, side: 'top', net: 'GND'    },
  { name: '12', number: '12', position: { x: 82, y: 93 }, radius: 5, side: 'top', net: 'CLK'    },
];

const R1_PINS: Pin[] = [
  { name: '1', number: '1', position: { x: 150, y: 55 }, radius: 4, side: 'top', net: 'VCC3V3'  },
  { name: '2', number: '2', position: { x: 186, y: 55 }, radius: 4, side: 'top', net: 'RESET_N' },
];

const C1_PINS: Pin[] = [
  { name: '1', number: '1', position: { x: 158, y: 95  }, radius: 4, side: 'top', net: 'VCC3V3' },
  { name: '2', number: '2', position: { x: 158, y: 130 }, radius: 4, side: 'top', net: 'GND'    },
];

const PARTS: Part[] = [
  {
    name: 'U1', side: 'top', type: 'smd',
    origin: { x: 67, y: 68 },
    pins:   U1_PINS,
    bounds: { minX: 44, minY: 40, maxX: 90, maxY: 101 },
  },
  {
    name: 'R1', side: 'top', type: 'smd',
    origin: { x: 168, y: 55 },
    pins:   R1_PINS,
    bounds: { minX: 140, minY: 46, maxX: 196, maxY: 64 },
  },
  {
    name: 'C1', side: 'top', type: 'smd',
    origin: { x: 158, y: 112 },
    pins:   C1_PINS,
    bounds: { minX: 149, minY: 85, maxX: 167, maxY: 140 },
  },
];

export const MOCK_BOARD: BoardData = {
  format:  'BVR3',
  outline: [
    { x: 0,   y: 0   },
    { x: 300, y: 0   },
    { x: 300, y: 180 },
    { x: 0,   y: 180 },
  ],
  parts:  PARTS,
  nails:  [],
  nets:   buildNets(PARTS),
  bounds: { minX: 0, minY: 0, maxX: 300, maxY: 180 },
};
