/**
 * Build-type flags for the backend-free web builds.
 *
 * Two backend-free modes, both driven by the Vite mode:
 *   - `--mode lite`    → the hosted static site (ripperdoc.de/boardripper/web),
 *                        with PWA/offline-SW.
 *   - `--mode offline` → a single self-contained index.html that runs from
 *                        file:// (downloadable, no server). Same app, packaged
 *                        by vite-plugin-singlefile with everything inlined.
 * The NAS build (production) and the Electron build use neither, so both flags
 * are false there and every guarded branch is inert.
 *
 * `isLiteBuild()` is the single "backend-free web build?" gate (true for lite
 * AND offline). IMPORTANT: it is distinct from `hasBackend()` (databank-store),
 * which asks "is an HTTP backend reachable" and is ALSO false on the desktop
 * app (Electron, MCP sidecar off) where library features work over IPC. Gate
 * backend-free hiding on isLiteBuild(), never on hasBackend().
 *
 * `isOfflineBuild()` is the narrower "am I the downloadable single-file
 * bundle?" gate — used for things that only differ in that packaging (e.g. the
 * toolbar's "download offline copy" link, which the offline file itself hides).
 *
 * Kept dependency-free on purpose so any store or component can import it
 * without creating cycles.
 */
export function isLiteBuild(): boolean {
  return import.meta.env.MODE === 'lite' || import.meta.env.MODE === 'offline';
}

export function isOfflineBuild(): boolean {
  return import.meta.env.MODE === 'offline';
}
