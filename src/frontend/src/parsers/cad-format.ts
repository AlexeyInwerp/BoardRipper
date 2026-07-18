import type { FormatDescriptor } from './registry';
import { parseCAD } from './cad-parser';

const decoder = new TextDecoder('utf-8');

export const CADFormat: FormatDescriptor = {
  id: 'CAD',
  name: 'GenCAD (PCB Interchange)',
  extensions: ['.cad'],
  description: 'GenCAD 1.4 text-based PCB interchange format. Sections: $SHAPES, $COMPONENTS, $SIGNALS.',
  docUrl: 'docs/formats/CAD_FORMAT.md',
  flipY: true,

  detect(header) {
    // Some converter-produced GenCAD files (Honhan/GOCCANH "TO CAD" exports)
    // prefix the file with NUL bytes, which trimStart() does not remove.
    const text = decoder.decode(header).replace(/^[\s\0]+/, '');
    return text.startsWith('$HEADER') && text.includes('GENCAD');
  },

  parse(buffer) {
    return parseCAD(buffer);
  },
};
