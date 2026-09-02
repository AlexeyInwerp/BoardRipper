import type { FormatDescriptor } from './registry';
import { parseEagleBRD } from './eagle-parser';

const decoder = new TextDecoder('utf-8');

/**
 * Autodesk / CadSoft EAGLE board — XML `.brd` (EAGLE 6.0, 2011, and newer).
 *
 * `.brd` is shared with two other registered formats, so detection is purely
 * content-based and the three sniffs are mutually exclusive by construction:
 *
 *   Apple/Mac BRD  — binary magic 23 E2 63 28 (or the "BRD_V1.0" variant)
 *   Allegro BRD    — uint32 LE version magic 0x0012–0x0015xxxx + guard word
 *   EAGLE BRD      — XML: `<?xml`, `<!DOCTYPE eagle` or `<eagle …>` (this file)
 *
 * The first bytes of an EAGLE board decode as ASCII `<?xm`, whose uint32 LE
 * value is 0x6D783F3C — outside every Allegro family window — so no ordering
 * subtlety is required between them. Registration order in `index.ts` still
 * keeps Allegro ahead of EAGLE so that the *extension* fallback (used only
 * when no `detect()` matched) resolves `.brd` to Allegro exactly as before.
 *
 * Pre-6.0 EAGLE wrote a proprietary binary `.brd`; it does not match this
 * sniff and `parseEagleBRD` rejects it with a "re-save from EAGLE 6+" message
 * if it is routed here by the extension fallback.
 */
export const EagleBRDFormat: FormatDescriptor = {
  id: 'EAGLE_BRD',
  name: 'EAGLE Board (XML)',
  extensions: ['.brd'],
  description: 'Autodesk/CadSoft EAGLE 6.0+ XML board — elements reference library packages; pins are resolved through the placement transform.',
  docUrl: 'docs/formats/EAGLE_BRD_FORMAT.md',
  // EAGLE's Y axis points up, like GenCAD/Mentor.
  flipY: true,
  hasTraces: true,
  hasSilkscreen: true,
  hasPads: true,

  detect(header: Uint8Array): boolean {
    // A leading UTF-8 BOM or a stray XML declaration keeps `<eagle` off byte 0,
    // so scan the window rather than anchoring at the start.
    const text = decoder.decode(header);
    if (!/<\s*(\?xml|!DOCTYPE\s+eagle|eagle[\s>])/i.test(text)) return false;
    // `<?xml` alone is not enough — any XML could carry a .brd extension.
    return /eagle/i.test(text);
  },

  parse(buffer: ArrayBuffer) {
    return parseEagleBRD(buffer);
  },
};
