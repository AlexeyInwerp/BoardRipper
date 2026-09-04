import { defineConfig, transformWithEsbuild, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { viteSingleFile } from 'vite-plugin-singlefile'
import pkg from './package.json' with { type: 'json' }

// Backend port for the dev proxy. Default 1336 matches the documented
// dev setup (CLAUDE.md). Playwright passes BOARDRIPPER_BACKEND_PORT to
// point at its own ephemeral backend so test runs don't collide with a
// dev server on 1336.
const BACKEND_PORT = process.env.BOARDRIPPER_BACKEND_PORT ?? '1336';

/**
 * The pdf.js worker is referenced with `new URL(..., import.meta.url)`, which
 * makes Vite copy it as an ASSET — verbatim, never minified. That is the copy
 * every http(s) visitor actually downloads and the service worker precaches:
 * 2.18 MB / 63 000 lines on the wire (447 KB brotli) where a minified one is
 * 1.19 MB (367 KB). The unminified SOURCE is deliberate (the watermark-filter
 * patch targets readable code — see patches/README.md); the unminified OUTPUT
 * never was. Minify the emitted asset in place.
 */
function minifyPdfWorkerAsset(): Plugin {
  return {
    name: 'boardripper:minify-pdf-worker-asset',
    apply: 'build',
    async generateBundle(_opts, bundle) {
      for (const [name, item] of Object.entries(bundle)) {
        if (item.type !== 'asset' || !/pdf\.worker-[\w-]+\.mjs$/.test(name)) continue;
        const src = typeof item.source === 'string' ? item.source : Buffer.from(item.source).toString('utf8');
        const out = await transformWithEsbuild(src, name, { minify: true, format: 'esm', target: 'es2020', sourcemap: false });
        item.source = out.code;
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Backend-free web builds (see docs/specs/2026-07-20-boardripper-web-
  // standalone-design.md). The mode IS the build type; app code reads it via
  // isLiteBuild()/isOfflineBuild() (store/build-mode.ts).
  //   lite    → hosted static site (ripperdoc.de/boardripper/web) + PWA.
  //   offline → single self-contained index.html that runs from file://
  //             (downloadable, no server), packaged by vite-plugin-singlefile.
  const lite = mode === 'lite';
  const offline = mode === 'offline';
  const backendFree = lite || offline;
  return {
    // Relative base: the lite build mounts at a sub-path AND a web.app root; the
    // offline single-file runs from file://. The NAS/Electron build keeps '/'.
    base: backendFree ? './' : '/',
    plugins: [
      react(),
      // Single-file offline bundle: inline JS/CSS and flatten dynamic imports
      // into one index.html so it opens straight from file:// (no server, no
      // module/asset fetches that file:// would CORS-block). No PWA here — a
      // service worker can't register on file://.
      ...(offline ? [viteSingleFile({ removeViteModuleLoader: true })] : []),
      minifyPdfWorkerAsset(),
      // Present in EVERY mode (disabled outside lite) so `virtual:pwa-register/
      // react` resolves for the NAS/offline/Electron builds too — the
      // UpdatePrompt component imports it and is itself gated on isLiteBuild().
      // `disable` makes the plugin emit no SW/manifest and a no-op register.
      VitePWA({
        disable: !lite,
        // 'prompt', not 'autoUpdate': with autoUpdate the new SW calls
        // skipWaiting()+clientsClaim() and deploy-lite's `mirror --delete`
        // prunes the old hashed chunks, so a page open across a deploy 404s on
        // its first lazy chunk — and nothing ever told the user a version
        // existed. Now the app shows "vX available — reload" (UpdatePrompt)
        // and the swap happens on the user's reload.
        registerType: 'prompt',
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
            // PNGs rasterised from logo.svg (public/). iOS ignores SVG manifest
            // icons entirely; Chrome's install prompt wants 192 + 512 PNG.
            { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
            { src: 'logo.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          ],
        },
      }),
    ],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    build: {
      // Separate output dirs so the backend-free bundles never collide with the
      // NAS build (dist/), which the Go server embeds.
      outDir: offline ? 'dist-offline' : lite ? 'dist-lite' : 'dist',
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
