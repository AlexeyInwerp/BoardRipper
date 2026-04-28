import { defineConfig } from '@playwright/test';

// Ports default to 18083 (vite) / 11336 (backend) — non-default to avoid
// colliding with the user's other vite projects (5174 caused a wrong-app
// login screen during development). Override with VITE_PORT / BACKEND_PORT
// env vars to point at an already-running stack.
const VITE_PORT = process.env.VITE_PORT ? Number(process.env.VITE_PORT) : 18083;
const BACKEND_PORT = process.env.BACKEND_PORT ? Number(process.env.BACKEND_PORT) : 11336;
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${VITE_PORT}`;

export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: 'only-on-failure',
  },
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
