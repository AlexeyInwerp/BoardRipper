import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json' with { type: 'json' }

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    host: '0.0.0.0',
    port: 8082,
    proxy: {
      '/api': {
        target: 'http://localhost:1336',
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
