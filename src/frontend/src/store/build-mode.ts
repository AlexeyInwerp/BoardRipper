/**
 * Build-type flag for the lite (standalone, backend-free) web build.
 *
 * `vite build --mode lite` / `vite --mode lite` set MODE to 'lite'; the NAS
 * build (production) and the Electron build never do, so isLiteBuild() is
 * false there and every guarded branch is inert.
 *
 * Single source of truth for "are we the lite web build?". IMPORTANT: this is
 * distinct from `hasBackend()` (databank-store), which asks "is an HTTP
 * backend reachable" and is ALSO false on the desktop app (Electron, MCP
 * sidecar off) where library features work over IPC. Gate lite-specific
 * hiding on isLiteBuild(), never on hasBackend().
 *
 * Kept dependency-free on purpose so any store or component can import it
 * without creating cycles.
 */
export function isLiteBuild(): boolean {
  return import.meta.env.MODE === 'lite';
}
