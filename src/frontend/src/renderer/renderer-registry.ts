/**
 * Module-level registry of live PixiJS Applications keyed by board tab id,
 * so the MCP bridge (mcp-bridge.ts) can snapshot the currently-active board's
 * canvas (`board_snapshot`) without threading a React ref through the panel
 * tree. BoardRenderer registers/unregisters itself as its Application is
 * created/released (see BoardRenderer.ts init() / reinitApp() / teardownForReinit() / destroy()).
 *
 * Keyed by `number`, not `string`: BoardRenderer.tabId and
 * boardStore.activeTabId are both `number | null` (tab ids come from a
 * monotonic `nextTabId` counter starting at 1 in board-store.ts) — there is
 * no string tab-id representation anywhere else in the codebase, so this
 * keeps the registry type-consistent with its only producer/consumer instead
 * of introducing a needless string conversion.
 */
import type { Application } from 'pixi.js';
import { boardStore } from '../store/board-store';

const apps = new Map<number, Application>();

// Leak probe: WeakRefs of every Application ever registered, exposed for
// tests/DevTools. WeakRefs retain nothing — after a tab closes and GC runs,
// its entry should deref() to undefined; a live deref on a closed tab is a
// leak. (window.__brAppRefs in the console.)
const appRefs: WeakRef<Application>[] = [];
(globalThis as unknown as { __brAppRefs: WeakRef<Application>[] }).__brAppRefs = appRefs;

export function registerRenderer(tabId: number, app: Application): void {
  apps.set(tabId, app);
  if (!appRefs.some(r => r.deref() === app)) appRefs.push(new WeakRef(app));
}
export function unregisterRenderer(tabId: number): void { apps.delete(tabId); }

export function getActiveApp(): Application | null {
  const id = boardStore.activeTabId;
  // `!= null` (not truthiness) — tab ids are a monotonic counter starting at
  // 1 so 0 never occurs in practice, but this avoids relying on that.
  return id != null ? apps.get(id) ?? null : null;
}
