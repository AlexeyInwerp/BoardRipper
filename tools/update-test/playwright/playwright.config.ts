import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  // The whole flow (status fetch → apply → orchestrator pull alpine → docker
  // load tarball → restart → new container health → reload) can take 90 s
  // on a cold cache. 5 minutes leaves headroom.
  timeout: 5 * 60 * 1000,
  retries: 0,
  reporter: [['list']],
  use: {
    headless: process.env.BR_HARNESS_HEADED ? false : true,
    baseURL: process.env.BR_HARNESS_URL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    // The /api/health probe + window.location.reload after the new container
    // comes up briefly serves errors; treat those as expected, not fatal.
    ignoreHTTPSErrors: true,
  },
});
