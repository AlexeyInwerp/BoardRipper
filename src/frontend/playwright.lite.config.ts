import { defineConfig } from '@playwright/test';

// Lite-build E2E. Two projects run the SAME spec:
//   lite-dev          — `vite --mode lite` dev server at the root path.
//   lite-dist-subpath — the BUILT bundle served under /boardripper/web/ by
//                       scripts/serve-lite.mjs, exercising the relative base
//                       exactly as production mounts it.
// Tests must navigate with page.goto('.') — goto('/') would escape the
// sub-path baseURL.
const DEV_PORT = process.env.LITE_DEV_PORT ? Number(process.env.LITE_DEV_PORT) : 18085;
const DIST_PORT = process.env.LITE_DIST_PORT ? Number(process.env.LITE_DIST_PORT) : 18086;

export default defineConfig({
  testDir: './tests',
  testMatch: /web-lite\.spec\.ts/,
  timeout: 30000,
  retries: 0,
  use: {
    headless: true,
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'lite-dev', use: { baseURL: `http://localhost:${DEV_PORT}/` } },
    { name: 'lite-dist-subpath', use: { baseURL: `http://localhost:${DIST_PORT}/boardripper/web/` } },
  ],
  webServer: [
    {
      command: `npx vite --mode lite --port ${DEV_PORT} --strictPort`,
      port: DEV_PORT,
      reuseExistingServer: true,
      timeout: 20000,
    },
    {
      // Builds first, then serves the bundle — generous timeout for tsc+vite.
      command: `npm run build:lite && node scripts/serve-lite.mjs ${DIST_PORT}`,
      port: DIST_PORT,
      reuseExistingServer: true,
      timeout: 240000,
    },
  ],
});
