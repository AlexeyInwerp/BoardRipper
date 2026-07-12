import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json' with { type: 'json' }

// Backend port for the dev proxy. Default 1336 matches the documented
// dev setup (CLAUDE.md). Playwright passes BOARDRIPPER_BACKEND_PORT to
// point at its own ephemeral backend so test runs don't collide with a
// dev server on 1336.
const BACKEND_PORT = process.env.BOARDRIPPER_BACKEND_PORT ?? '1336';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    host: '0.0.0.0',
    port: 8082,
    // Cross-origin isolation — unlocks performance.measureUserAgentSpecificMemory
    // (precise memory stat in the status bar, incl. workers). `credentialless`
    // instead of `require-corp` so cross-origin subresources (OBD images, FZ key
    // mirrors via CORS fetch) keep working. Mirrors the Go server's headers.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
    proxy: {
      '/api': {
        target: `http://localhost:${BACKEND_PORT}`,
        changeOrigin: true,
        // Silence Vite's default ECONNREFUSED logging when the Go backend
        // isn't running (Playwright / pure-frontend dev / CI). The app
        // already swallows the fetch error in update-store.ts etc.; Vite's
        // own proxy logger sits above that and spams the terminal.
        configure: (proxy) => {
          proxy.on('error', () => { /* suppress */ });
        },
      },
    },
  },
})
