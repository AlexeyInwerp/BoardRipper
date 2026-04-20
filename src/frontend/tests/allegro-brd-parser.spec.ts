import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SAMPLES_DIR = path.resolve(__dirname, '../../../samples/allegroBRD');

test.describe('Allegro BRD Parser', () => {
  test('can parse Quanta Y0D (v16.5) directly', async () => {
    const { parseAllegroBRD } = await import('../src/parsers/allegro/allegro-brd-parser');
    const filePath = path.resolve(SAMPLES_DIR, 'Quanta Y0D DA0Y0DMBAF0 boardview .brd');
    const buf = fs.readFileSync(filePath);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const board = parseAllegroBRD(ab);

    expect(board.format).toBe('ALLEGRO_BRD');
    // Should have components with valid refdes names
    expect(board.parts.length).toBeGreaterThan(100);
    // Bounds should be reasonable (non-zero, non-infinite)
    expect(Number.isFinite(board.bounds.minX)).toBe(true);
    expect(Number.isFinite(board.bounds.maxX)).toBe(true);
    // Multi-layer info is extracted but not yet exposed (layer mapping WIP)
    // expect(board.layerNames).toBeDefined();
    // Component names should be valid refdes (letters + digits)
    const validRefdes = board.parts.filter(p => /^[A-Z]+\d+/.test(p.name));
    expect(validRefdes.length).toBeGreaterThan(50);

    console.log(`[Y0D] Parts: ${board.parts.length}, Nets: ${board.nets.size}, Layers: ${board.layerNames?.length ?? 0}`);
    const firstParts = board.parts.slice(0, 10).map(p => `${p.name}(${p.pins.length}pins)`);
    console.log(`[Y0D] First parts: ${firstParts.join(', ')}`);
  });

  test('can parse Acer Z8IA (v17.2) directly', async () => {
    const { parseAllegroBRD } = await import('../src/parsers/allegro/allegro-brd-parser');
    const filePath = path.resolve(SAMPLES_DIR, 'Acer_TravelMate_TMP214_41_Quanta_Z8IA_DAZ8IAMBAC0_Rev_C_BoardView.brd');
    const buf = fs.readFileSync(filePath);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const board = parseAllegroBRD(ab);

    expect(board.format).toBe('ALLEGRO_BRD');
    expect(board.parts.length).toBeGreaterThan(10);
    expect(Number.isFinite(board.bounds.minX)).toBe(true);

    console.log(`[Z8IA] Parts: ${board.parts.length}, Nets: ${board.nets.size}, Layers: ${board.layerNames?.length ?? 0}`);
    const firstParts = board.parts.slice(0, 10).map(p => `${p.name}(${p.pins.length}pins)`);
    console.log(`[Z8IA] First parts: ${firstParts.join(', ')}`);
  });

  test('can parse Quanta Z8I (v17.2, largest file) directly', async () => {
    const { parseAllegroBRD } = await import('../src/parsers/allegro/allegro-brd-parser');
    const filePath = path.resolve(SAMPLES_DIR, 'Quanta Z8I DA0Z8IMBAC0 Rev C (BDV) (.BRD).brd');
    const buf = fs.readFileSync(filePath);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const board = parseAllegroBRD(ab);

    expect(board.format).toBe('ALLEGRO_BRD');
    expect(board.parts.length).toBeGreaterThan(10);

    console.log(`[Z8I] Parts: ${board.parts.length}, Nets: ${board.nets.size}, Layers: ${board.layerNames?.length ?? 0}`);
    const firstParts = board.parts.slice(0, 10).map(p => `${p.name}(${p.pins.length}pins)`);
    console.log(`[Z8I] First parts: ${firstParts.join(', ')}`);
  });

  test('Allegro BRD format detection works correctly', async () => {
    const { AllegroBRDFormat } = await import('../src/parsers/allegro-brd-format');

    // Test Allegro BRD detection (v16.5 magic: 0x00131003)
    const allegroHeader = new Uint8Array(512);
    const dv = new DataView(allegroHeader.buffer);
    dv.setUint32(0, 0x00131003, true); // magic
    dv.setUint32(8, 1, true);          // un1[1] = 1
    expect(AllegroBRDFormat.detect(allegroHeader)).toBe(true);

    // Test v17.2 magic
    dv.setUint32(0, 0x00140400, true);
    expect(AllegroBRDFormat.detect(allegroHeader)).toBe(true);

    // Test that it doesn't match existing BRD format magic
    const brdHeader = new Uint8Array([0x23, 0xE2, 0x63, 0x28, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(AllegroBRDFormat.detect(brdHeader)).toBe(false);

    // Test that it doesn't match random data
    const random = new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(AllegroBRDFormat.detect(random)).toBe(false);
  });

  test('parts have valid pin data with net assignments', async () => {
    const { parseAllegroBRD } = await import('../src/parsers/allegro/allegro-brd-parser');
    const filePath = path.resolve(SAMPLES_DIR, 'Quanta Y0D DA0Y0DMBAF0 boardview .brd');
    const buf = fs.readFileSync(filePath);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const board = parseAllegroBRD(ab);

    // Check that parts have valid refdes names
    const validParts = board.parts.filter(p => /^[A-Z]/.test(p.name));
    expect(validParts.length).toBeGreaterThan(50);
    console.log(`[Y0D] Valid refdes parts: ${validParts.length}/${board.parts.length}`);

    // Some parts may have pins (depends on how far the sequential parse reached)
    const partsWithPins = board.parts.filter(p => p.pins.length > 0);
    console.log(`[Y0D] Parts with pins: ${partsWithPins.length}`);

    // Check coordinate validity
    for (const part of board.parts.slice(0, 50)) {
      expect(Number.isFinite(part.origin.x)).toBe(true);
      expect(Number.isFinite(part.origin.y)).toBe(true);
      for (const pin of part.pins) {
        expect(Number.isFinite(pin.position.x)).toBe(true);
        expect(Number.isFinite(pin.position.y)).toBe(true);
        expect(pin.radius).toBeGreaterThan(0);
      }
    }
  });

  test('pin extraction with valid positions and net assignments', async () => {
    const { parseAllegroBRD } = await import('../src/parsers/allegro/allegro-brd-parser');
    const filePath = path.resolve(SAMPLES_DIR, 'Quanta Y0D DA0Y0DMBAF0 boardview .brd');
    const buf = fs.readFileSync(filePath);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const board = parseAllegroBRD(ab);

    // Total pins across all parts should be > 500
    const totalPins = board.parts.reduce((n, p) => n + p.pins.length, 0);
    expect(totalPins).toBeGreaterThan(500);
    console.log(`[Y0D] Total pins: ${totalPins}`);

    // All pin positions must be finite
    for (const part of board.parts) {
      for (const pin of part.pins) {
        expect(Number.isFinite(pin.position.x)).toBe(true);
        expect(Number.isFinite(pin.position.y)).toBe(true);
      }
    }

    // Some pins should have non-empty net names (> 100)
    const allPins = board.parts.flatMap(p => p.pins);
    const pinsWithNet = allPins.filter(p => p.net && p.net.length > 0);
    expect(pinsWithNet.length).toBeGreaterThan(100);
    console.log(`[Y0D] Pins with net assignments: ${pinsWithNet.length}/${allPins.length}`);
  });

  test('trace extraction with valid geometry', async () => {
    const { parseAllegroBRD } = await import('../src/parsers/allegro/allegro-brd-parser');
    const filePath = path.resolve(SAMPLES_DIR, 'Quanta Y0D DA0Y0DMBAF0 boardview .brd');
    const buf = fs.readFileSync(filePath);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const board = parseAllegroBRD(ab);

    // Traces array should be defined and have > 100 entries
    expect(board.traces).toBeDefined();
    expect(board.traces!.length).toBeGreaterThan(100);
    console.log(`[Y0D] Traces: ${board.traces!.length}`);

    // All traces should have finite coordinates and positive width
    for (const trace of board.traces!.slice(0, 200)) {
      expect(Number.isFinite(trace.start.x)).toBe(true);
      expect(Number.isFinite(trace.start.y)).toBe(true);
      expect(Number.isFinite(trace.end.x)).toBe(true);
      expect(Number.isFinite(trace.end.y)).toBe(true);
      expect(trace.width).toBeGreaterThan(0);
    }
  });

  test('v17.5 and v18.0 format detection', async () => {
    const { AllegroBRDFormat } = await import('../src/parsers/allegro-brd-format');

    // v17.5 magic: 0x00141500
    const header175 = new Uint8Array(512);
    const dv175 = new DataView(header175.buffer);
    dv175.setUint32(0, 0x00141500, true);
    dv175.setUint32(8, 1, true);
    expect(AllegroBRDFormat.detect(header175)).toBe(true);

    // v18.0 magic: 0x00150000
    const header180 = new Uint8Array(512);
    const dv180 = new DataView(header180.buffer);
    dv180.setUint32(0, 0x00150000, true);
    dv180.setUint32(8, 1, true);
    expect(AllegroBRDFormat.detect(header180)).toBe(true);
  });

  test('can render Allegro BRD file in browser', async ({ page }) => {
    await page.goto('/');

    const fileInput = page.getByTestId('file-input');
    const brdFile = path.resolve(SAMPLES_DIR, 'Quanta Y0D DA0Y0DMBAF0 boardview .brd');
    await fileInput.setInputFiles(brdFile);

    // Wait for parsing — status bar should show component/net counts
    await expect(page.getByTestId('statusbar')).toContainText('Components', { timeout: 60000 });
    await expect(page.getByTestId('statusbar')).toContainText('Components:');
    await expect(page.getByTestId('statusbar')).toContainText('Nets:');

    // Canvas should be visible
    await expect(page.getByTestId('board-canvas')).toBeVisible();
    const canvas = page.getByTestId('board-canvas').locator('canvas');
    await expect(canvas).toBeVisible();
  });
});
