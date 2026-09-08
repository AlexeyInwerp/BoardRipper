import { defineConfig } from '@playwright/test';

// Desktop (Electron) smoke test. Launches the real app from desktop/ — the
// same main.js and the same bundled webapp the packaged .app runs — so a UI
// change that only breaks under Electron (a missing file:// asset, a control
// that lives behind a backend gate, a crash on boot) is caught before a
// release. Skips itself when desktop/webapp has not been built.
export default defineConfig({
  testDir: './tests',
  testMatch: /electron-smoke\.spec\.ts/,
  timeout: 120000,
  retries: 0,
  workers: 1,
  use: { screenshot: 'only-on-failure' },
});
