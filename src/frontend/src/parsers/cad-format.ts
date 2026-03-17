import type { FormatDescriptor } from './registry';
import { parseCAD } from './cad-parser';

const decoder = new TextDecoder('utf-8');

export const CADFormat: FormatDescriptor = {
  id: 'CAD',
  name: 'GenCAD (PCB Interchange)',
  extensions: ['.cad'],
  description: 'GenCAD 1.4 text-based PCB interchange format. Sections: $SHAPES, $COMPONENTS, $SIGNALS.',
  flipY: true,

  detect(header) {
    const text = decoder.decode(header).trimStart();
    return text.startsWith('$HEADER') && text.includes('GENCAD');
  },

  parse(buffer) {
    return parseCAD(buffer);
  },
};
