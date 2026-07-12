import { test, expect } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Task 6 of docs/plans/2026-07-12-parse-time-optimization-plan.md:
// board parsing must run inside the parse worker (a) actually be used,
// (b) produce a working board, with parser logs forwarded to the main
// thread. Uses a text-format sample so no decryption key is involved.

const BVR3_FILE = path.resolve(__dirname, '../../../samples/820-02016/820-02016.bvr');

test('board parse runs in the worker and the board opens', async ({ page }) => {
  test.skip(!fs.existsSync(BVR3_FILE), `${path.basename(BVR3_FILE)} not present (proprietary fixture)`);

  const consoleLines: string[] = [];
  page.on('console', m => consoleLines.push(m.text()));

  await page.goto('/');
  const fileInput = page.getByTestId('file-input');
  await fileInput.setInputFiles(BVR3_FILE);

  // Board loads end-to-end (status bar shows the known part count).
  await expect(page.getByTestId('statusbar')).toContainText('3075', { timeout: 30000 });

  // The worker path was actually used…
  expect(consoleLines.some(l => l.includes('Parsed in worker: 820-02016.bvr'))).toBe(true);
  // …and parser-side logs were forwarded to the main thread's console/log
  // store (the "Parsed OK" summary is logged main-side; side-detection runs
  // inside the parser → inside the worker).
  expect(consoleLines.some(l => l.includes('Side detection:'))).toBe(true);
});
