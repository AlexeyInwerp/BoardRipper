import type { FormatDescriptor } from './registry';
import { parseBVR1 } from './bvr1-parser';

const decoder = new TextDecoder('utf-8');

export const BVR1Format: FormatDescriptor = {
  id: 'BVR1',
  name: 'BV Raw Format 1',
  extensions: ['.bvr', '.bv'],
  description: 'Tab-delimited boardview export (BVRAW_FORMAT_1). Coords ×1000 → mils.',
  docUrl: 'docs/formats/BVR_FORMAT.md',

  detect(header) {
    const text = decoder.decode(header.slice(0, 50));
    return text.includes('BVRAW_FORMAT_1');
  },

  parse(buffer) {
    return parseBVR1(decoder.decode(buffer));
  },
};
