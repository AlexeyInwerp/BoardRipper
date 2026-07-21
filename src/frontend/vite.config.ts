import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import pkg from './package.json' with { type: 'json' }

// Backend port for the dev proxy. Default 1336 matches the documented
// dev setup (CLAUDE.md). Playwright passes BOARDRIPPER_BACKEND_PORT to
// point at its own ephemeral backend so test runs don't collide with a
// dev server on 1336.
const BACKEND_PORT = process.env.BOARDRIPPER_BACKEND_PORT ?? '1336';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Lite build = the standalone, backend-free web build (see
  // docs/specs/2026-07-20-boardripper-web-standalone-design.md). The mode IS
  // the build type; app code reads it via isLiteBuild() (store/build-mode.ts).
  const lite = mode === 'lite';
  return {
    // The lite build is served from a sub-path (ripperdoc.de/boardripper/web)
    // AND later mirrored to a domain root (*.web.app). A relative base makes
    // ONE bundle work at any mount point. The NAS/Electron build keeps the
    // root-absolute default.
    base: lite ? './' : '/',
    plugins: [
      react(),
      ...(lite ? [VitePWA({
        registerType: 'autoUpdate',      // new deploy picked up on next load
        injectRegister: 'auto',          // registration script injected at build
        // Serve the manifest + SW on `vite --mode lite` dev too, so the E2E
        // and manual testing exercise the real thing.
        devOptions: { enabled: true },
        workbox: {
          // NOTE 'mjs': the pdf.js worker may be emitted as an .mjs asset — omit
          // it and PDF viewing could break offline.
          globPatterns: ['**/*.{js,mjs,css,html,svg,woff2,wasm}'],
          // pdf worker + wasm can be large; lift the default precache cap.
          maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        },
        manifest: {
          name: 'BoardRipper',
          short_name: 'BoardRipper',
          description: 'PCB boardview viewer & inspector — open boardview files and PDFs locally.',
          // Relative so the installed app works under a sub-path AND a web.app root.
          start_url: '.',
          scope: '.',
          display: 'standalone',
          background_color: '#0b0f14',
          theme_color: '#0b0f14',
          icons: [
            { src: 'logo.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
          ],
        },
      })] : []),
    ],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    build: {
      // Separate output dir so the lite bundle never collides with the NAS
      // build (dist/), which the Go server embeds.
      outDir: lite ? 'dist-lite' : 'dist',
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
  };
})
