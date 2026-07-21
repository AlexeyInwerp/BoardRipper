import { defineConfig } from '@playwright/test';

// Single-file offline build E2E. Opens dist-offline/boardripper-lite.html
// directly from file:// (no web server) and asserts the app is fully
// self-contained. SwiftShader args let PixiJS init WebGL headlessly so the
// board actually renders (and logs no error). Run via `npm run test:offline`,
// which builds dist-offline/ first.
export default defineConfig({
  testDir: './tests',
  testMatch: /offline-file\.spec\.ts/,
  timeout: 40000,
  retries: 0,
  use: {
    headless: true,
    screenshot: 'only-on-failure',
    launchOptions: {
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  },
});
