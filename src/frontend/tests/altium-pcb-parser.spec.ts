import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SAMPLES_DIR = path.resolve(__dirname, '../../../samples/altium');
const SAMPLE_PCB = path.join(SAMPLES_DIR, 'PCB.PcbDoc');
const SAMPLE_ESD = path.join(SAMPLES_DIR, 'ESD_GW1N_4L.PcbDoc');

test.describe('Altium PCB Parser — Phase 1', () => {
  test('cfb dependency is loadable', async () => {
    const cfb = await import('cfb');
    expect(typeof cfb.read).toBe('function');
    expect(typeof cfb.find).toBe('function');
  });

  test('samples are present (informational)', () => {
    test.skip(!fs.existsSync(SAMPLE_PCB), 'samples/altium/PCB.PcbDoc missing — local-only file');
    expect(fs.statSync(SAMPLE_PCB).size).toBeGreaterThan(100_000);
    if (fs.existsSync(SAMPLE_ESD)) {
      expect(fs.statSync(SAMPLE_ESD).size).toBeGreaterThan(1_000_000);
    }
  });
});
