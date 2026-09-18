import { defineConfig, devices } from '@playwright/test';

// Ports default to 18083 (vite) / 11336 (backend) — non-default to avoid
// colliding with the user's other vite projects (5174 caused a wrong-app
// login screen during development). Override with VITE_PORT / BACKEND_PORT
// env vars to point at an already-running stack.
const VITE_PORT = process.env.VITE_PORT ? Number(process.env.VITE_PORT) : 18083;
const BACKEND_PORT = process.env.BACKEND_PORT ? Number(process.env.BACKEND_PORT) : 11336;
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${VITE_PORT}`;

/**
 * WebKit is opt-in (`npm run test:webkit`), for two reasons.
 *
 * It is the only engine that ships on iPadOS — Chrome and every other browser
 * there is a WKWebView — so it is the only place a touch bug reported from an
 * iPad can be reproduced at all. But the browser is a separate ~100 MB
 * download that CI does not have, and a project defined unconditionally would
 * fail the whole default run on a machine without it. So the default run stays
 * Chromium-only and the WebKit project appears only when asked for.
 *
 * What it does and does not prove: this is WebKit's Mac port, so the DOM,
 * event and layout behaviour is the engine's own — pointer events, gesture
 * events, `touch-action`, canvas limits. It is NOT an iPad: no tile-based GPU,
 * no iOS canvas-memory ceiling, no 120 Hz panel. Correctness reproduces here;
 * performance does not.
 */
const WEBKIT = !!process.env.WEBKIT;

export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: 'only-on-failure',
  },
  projects: WEBKIT
    ? [{
        name: 'webkit-ipad',
        // An iPad Pro descriptor: Safari's own UA, 2× device scale, touch on,
        // and a tablet viewport — the combination the touch paths branch on.
        use: { ...devices['iPad Pro 11'], browserName: 'webkit' },
        // `*.webkit.spec.ts` plus the engine-agnostic touch specs — those drive
        // synthetic pointer events, so they are worth running under the engine
        // that actually ships on iPadOS. `touch-pinch-selection.spec.ts` is
        // deliberately not here: it needs CDP multi-touch, which is Chromium's.
        testMatch: /(.*\.webkit\.spec\.ts|pdf-touch\.spec\.ts)/,
      }]
    : [{
        name: 'chromium',
        use: { ...devices['Desktop Chrome'] },
        // `.webkit.spec.ts` files drive WebKit-only behaviour (gesture events,
        // WebKit's pointer-cancel timing) and are meaningless under Chromium.
        testIgnore: /.*\.webkit\.spec\.ts/,
      }],
  webServer: {
    command: `npx vite --port ${VITE_PORT} --strictPort`,
    port: VITE_PORT,
    reuseExistingServer: true,
    timeout: 15000,
    env: {
      // Forward backend port to vite so its proxy targets the right backend.
      // vite.config.ts reads BOARDRIPPER_BACKEND_PORT.
      BOARDRIPPER_BACKEND_PORT: String(BACKEND_PORT),
    },
  },
});
