import { test, expect } from '@playwright/test';

/**
 * Regression: some Mentor/CAMCAD GenCAD exports (e.g. ASUS
 * FA506QR_FA506QM_2_0_60NR0600_MB1501.cad) emit ONE `COMPONENT` block per
 * device/net record instead of one per physical part. A single large BGA is
 * re-listed back-to-back hundreds or thousands of times — identical refdes,
 * PLACE, SHAPE and ROTATION/LAYER, with only the (rendering-irrelevant)
 * DEVICE field varying. Because that BGA's SHAPE genuinely carries N pins,
 * naively instantiating it N times yields N² pins, which exhausted the JS
 * heap on load (the real file produced ~9.1M pins → OOM).
 *
 * The parser now collapses consecutive runs of geometrically-identical
 * COMPONENT records to a single instance. This guards the collapse AND proves
 * it does not touch genuine multi-revision files (interleaved repeats).
 */

/** Build a SHAPE with `pinCount` distinct pins on a single row. */
function shapeBlock(name: string, pinCount: number): string {
  const pins: string[] = [];
  for (let i = 1; i <= pinCount; i++) {
    pins.push(`PIN P${i} PAD ${i * 10} 0 TOP 0.000 0`);
  }
  return `SHAPE ${name}\n${pins.join('\n')}\nINSERT SMD`;
}

/** Repeat one identical COMPONENT block `times`, varying only DEVICE. */
function duplicatedComponentBlock(refdes: string, shape: string, times: number): string {
  const blocks: string[] = [];
  for (let i = 0; i < times; i++) {
    blocks.push(
      `COMPONENT ${refdes}\nPLACE 100 100\nLAYER TOP\nROTATION 0.000\n` +
        `SHAPE ${shape} 0 0\nDEVICE ${refdes}_${i}`,
    );
  }
  return blocks.join('\n');
}

test.describe('CAD duplicate-component collapse (Mentor per-device explosion)', () => {
  test('consecutive identical COMPONENT records collapse to one instance', async () => {
    const PIN_COUNT = 40;
    const REPEAT = 500; // 500 × 40 = 20,000 pins without the fix
    const cad =
      `$HEADER\nGENCAD 1.4\nUNITS USER 1000\n$ENDHEADER\n` +
      `$SHAPES\n${shapeBlock('BGA', PIN_COUNT)}\n$ENDSHAPES\n` +
      `$COMPONENTS\n${duplicatedComponentBlock('U1', 'BGA', REPEAT)}\n$ENDCOMPONENTS\n` +
      `$SIGNALS\n$ENDSIGNALS\n`;

    const { parseCAD } = await import('../src/parsers/cad-parser');
    const board = parseCAD(new TextEncoder().encode(cad).buffer as ArrayBuffer);

    // One physical part, not 500.
    expect(board.parts.length).toBe(1);
    // N pins, not N × REPEAT.
    expect(board.parts[0].pins.length).toBe(PIN_COUNT);
    // No spurious revision picker from the repeated refdes.
    expect(board.revisions).toBeUndefined();
  });

  test('multiple distinct degenerate parts each collapse independently', async () => {
    const cad =
      `$HEADER\nGENCAD 1.4\nUNITS USER 1000\n$ENDHEADER\n` +
      `$SHAPES\n${shapeBlock('BGA', 30)}\n${shapeBlock('QFN', 12)}\n$ENDSHAPES\n` +
      `$COMPONENTS\n` +
      `${duplicatedComponentBlock('U1', 'BGA', 200)}\n` +
      `${duplicatedComponentBlock('U2', 'QFN', 100)}\n` +
      `$ENDCOMPONENTS\n$SIGNALS\n$ENDSIGNALS\n`;

    const { parseCAD } = await import('../src/parsers/cad-parser');
    const board = parseCAD(new TextEncoder().encode(cad).buffer as ArrayBuffer);

    expect(board.parts.length).toBe(2);
    const byName = new Map(board.parts.map(p => [p.name, p]));
    expect(byName.get('U1')!.pins.length).toBe(30);
    expect(byName.get('U2')!.pins.length).toBe(12);
    expect(board.revisions).toBeUndefined();
  });

  test('genuine interleaved revisions are preserved (collapse does NOT fire)', async () => {
    // Two complete board snapshots concatenated: [U1 R1] [U1 R1]. The repeated
    // refdes are separated by other refdes (never consecutive), exactly like a
    // real multi-revision GenCAD export — so the collapse must leave them and
    // the revision picker must still appear.
    const cad =
      `$HEADER\nGENCAD 1.4\nUNITS USER 1000\n$ENDHEADER\n` +
      `$SHAPES\n${shapeBlock('UQFN', 8)}\n${shapeBlock('RES', 2)}\n$ENDSHAPES\n` +
      `$COMPONENTS\n` +
      `COMPONENT U1\nPLACE 100 100\nLAYER TOP\nROTATION 0.000\nSHAPE UQFN 0 0\nDEVICE U1\n` +
      `COMPONENT R1\nPLACE 200 200\nLAYER TOP\nROTATION 0.000\nSHAPE RES 0 0\nDEVICE R1\n` +
      `COMPONENT U1\nPLACE 100 100\nLAYER TOP\nROTATION 0.000\nSHAPE UQFN 0 0\nDEVICE U1\n` +
      `COMPONENT R1\nPLACE 200 200\nLAYER TOP\nROTATION 0.000\nSHAPE RES 0 0\nDEVICE R1\n` +
      `$ENDCOMPONENTS\n$SIGNALS\n$ENDSIGNALS\n`;

    const { parseCAD } = await import('../src/parsers/cad-parser');
    const board = parseCAD(new TextEncoder().encode(cad).buffer as ArrayBuffer);

    // Interleaved repeats are real revisions, not redundant duplicates.
    expect(board.revisions?.length).toBe(2);
  });
});
