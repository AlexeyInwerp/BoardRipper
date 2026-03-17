import type { FormatDescriptor } from './registry';
import { parseBVR3 } from './bvr3-parser';

const decoder = new TextDecoder('utf-8');

export const BVR3Format: FormatDescriptor = {
  id: 'BVR3',
  name: 'BV Raw Format 3',
  extensions: ['.bvr', '.bv'],
  description: 'Keyword-value boardview export (BVRAW_FORMAT_3). Relative pin coords in mils.',
  docUrl: 'docs/formats/BVR_FORMAT.md',

  detect(header) {
    const text = decoder.decode(header.slice(0, 50));
    return text.includes('BVRAW_FORMAT_3');
  },

  parse(buffer) {
    return parseBVR3(decoder.decode(buffer));
  },
};
