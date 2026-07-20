# BoardRipper Web — Lite Build (Backend-Free) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce the lite build of BoardRipper — the full viewer/inspector as a static, backend-free bundle driven entirely by local file open/drag-drop — hosted at `ripperdoc.de/boardripper/web` and later mirrored to a `*.web.app` root.

**Architecture:** One codebase, one build *type*: `vite --mode lite`. A single zero-dependency flag module `store/build-mode.ts` exports `isLiteBuild()` (`import.meta.env.MODE === 'lite'`). The renderer and interface are 100% shared with mainline BoardRipper — no forked components — so all future rendering/UI work flows into the lite build for free. Backend-coupled surfaces get one `isLiteBuild()` guard each, at the feature-registration point. A relative base path makes one bundle host-portable; `vite-plugin-pwa` makes it installable + offline. The E2E suite runs twice: dev server at root AND the built bundle served under `/boardripper/web/`.

**Tech Stack:** React 19 · TypeScript (strict) · Vite 7 · vitest (unit) · Playwright (E2E) · vite-plugin-pwa (new, lite-only).

**Spec:** `docs/specs/2026-07-20-boardripper-web-standalone-design.md` (revised 2026-07-21)

## Global Constraints

- **`isLiteBuild()` is the ONLY gate for lite-specific hiding/no-oping.** Never gate lite UI on `hasBackend()` — it is *also* `false` on the desktop (Electron, MCP-off) build, where those features work via IPC. Gating UI on `hasBackend()` would break desktop.
- **`hasBackend()` keeps its HTTP-backend meaning**, plus one `isLiteBuild()` short-circuit.
- **Zero risk to NAS/Electron:** `MODE === 'lite'` is never true there, so every `isLiteBuild()` guard is inert, and the PWA plugin is excluded at config level. Never change NAS/Electron behavior.
- **Contract:** in the lite build, ZERO `/api/*` requests fire — on cold load, on board open, on PDF open, or on file drop (including update-bundle drops).
- **Output isolation:** lite build emits to `dist-lite/` (never `dist/`, which the Go server embeds).
- **TypeScript strict mode**; scoped loggers only (`store/log-store.ts`), never `console.log`.
- **All lite paths shared, none forked:** do not duplicate any renderer/panel/component for the lite build.
- **Wording:** user-visible copy never says "demo" — this is the lite build of BoardRipper.
- Line numbers are from the source at plan-writing time; if a file has shifted, match on the shown surrounding code, not the line number.

---

### Task 1: Lite build type (Vite config + scripts)

Establishes `vite build --mode lite` → relative base, `dist-lite/` output. No app-code gating yet; this verifies the build plumbing in isolation. No `.env` file is needed — the mode itself is the flag.

**Files:**
- Modify: `src/frontend/vite.config.ts` (whole file — object form → function-of-`{mode}` form)
- Modify: `src/frontend/package.json:6-18` (scripts block)
- Modify: `src/frontend/.gitignore:11-12` (ignore `dist-lite`)
- Modify: `src/frontend/index.html:5` (relative favicon)

**Interfaces:**
- Produces: `import.meta.env.MODE === 'lite'` under `--mode lite`; `npm run build:lite` → `src/frontend/dist-lite/`; scripts `preview:lite`, `serve:lite`, `test:lite` (the latter two get their targets in Tasks 6).

- [ ] **Step 1: Rewrite `vite.config.ts` as a function of `{ mode }`**

Replace the entire contents of `src/frontend/vite.config.ts` with:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
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
    plugins: [react()],
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
```

- [ ] **Step 2: Add scripts to `package.json`**

In `src/frontend/package.json`, replace the `scripts` block (lines 6-18) with (adds `build:lite`, `preview:lite`, `serve:lite`, `test:lite`):

```json
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "build:lite": "tsc -b && vite build --mode lite",
    "preview:lite": "vite preview --mode lite",
    "serve:lite": "node scripts/serve-lite.mjs",
    "lint": "eslint .",
    "preview": "vite preview",
    "test": "npx playwright test",
    "test:ui": "npx playwright test --ui",
    "test:headed": "npx playwright test --headed",
    "test:debug": "npx playwright test --debug",
    "test:report": "npx playwright show-report",
    "test:lite": "npx playwright test --config playwright.lite.config.ts",
    "test:unit": "vitest run",
    "postinstall": "patch-package"
  },
```

(`serve:lite` and `test:lite` reference files created in Task 6 — they are inert until then.)

- [ ] **Step 3: Ignore `dist-lite` in git**

In `src/frontend/.gitignore`, the existing lines 11-12 are `dist` / `dist-ssr` (they do NOT match `dist-lite`). Add a line:

```
dist
dist-ssr
dist-lite
```

- [ ] **Step 4: Make the favicon reference relative**

In `src/frontend/index.html` line 5, change:

```html
    <link rel="icon" type="image/svg+xml" href="/logo.svg" />
```

to:

```html
    <link rel="icon" type="image/svg+xml" href="./logo.svg" />
```

(Verified in review: this is the only `/`-rooted public reference — the pdf.js worker uses `new URL(..., import.meta.url)`, Dockview popout already uses relative `popout.html`, and `index.css` has no `url(/...)`. Relative favicon is also correct for the NAS build at root.)

- [ ] **Step 5: Build and verify the relative base**

Run:

```bash
cd src/frontend && npm run build:lite
grep -oE '(src|href)="[^"]*"' dist-lite/index.html
```

Expected: build succeeds into `dist-lite/`; every emitted script/style/icon path begins with `./` (no leading `/`).

Also confirm the NAS build is untouched:

```bash
npm run build && grep -oE '(src|href)="[^"]*"' dist/index.html | head -5
```

Expected: `dist/` assets remain root-absolute (`/assets/...`) apart from the favicon now being `./logo.svg` (equivalent at root).

- [ ] **Step 6: Commit**

```bash
git add src/frontend/vite.config.ts src/frontend/package.json src/frontend/.gitignore src/frontend/index.html
git commit -m "build(lite): add lite build type (mode lite, relative base, dist-lite output)"
```

---

### Task 2: `isLiteBuild()` flag + central backend short-circuit

The one flag that defines the build type, plus the two central cutoffs in `databank-store` (its `hasBackend()` and its startup load chain).

**Files:**
- Create: `src/frontend/src/store/build-mode.ts`
- Create: `src/frontend/src/store/build-mode.test.ts`
- Modify: `src/frontend/src/store/databank-store.ts` (imports; `hasBackend()` at 25-27; `_runStartupLoad` at ~834-836)

**Interfaces:**
- Produces: `isLiteBuild(): boolean` from `store/build-mode.ts` — consumed by every later task.

- [ ] **Step 1: Write the failing test**

Create `src/frontend/src/store/build-mode.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { isLiteBuild } from './build-mode';

afterEach(() => vi.unstubAllEnvs());

describe('isLiteBuild', () => {
  it('is false outside the lite build (NAS / Electron / tests)', () => {
    expect(isLiteBuild()).toBe(false);
  });

  it('is true under --mode lite', () => {
    vi.stubEnv('MODE', 'lite');
    expect(isLiteBuild()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/frontend && npx vitest run src/store/build-mode.test.ts`
Expected: FAIL — `Failed to resolve import "./build-mode"` (module not created yet).

- [ ] **Step 3: Create `build-mode.ts`**

Create `src/frontend/src/store/build-mode.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/frontend && npx vitest run src/store/build-mode.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Short-circuit `hasBackend()`**

In `src/frontend/src/store/databank-store.ts`, add the import near the top (after line 3 `import { Emitter } from './emitter';`):

```ts
import { isLiteBuild } from './build-mode';
```

Then change `hasBackend()` (lines 25-27) from:

```ts
export function hasBackend(): boolean {
  return !isElectron() || (typeof location !== 'undefined' && location.protocol !== 'file:');
}
```

to:

```ts
export function hasBackend(): boolean {
  if (isLiteBuild()) return false;   // lite web build: no HTTP backend, ever
  return !isElectron() || (typeof location !== 'undefined' && location.protocol !== 'file:');
}
```

- [ ] **Step 6: Short-circuit the databank startup load chain**

In `src/frontend/src/store/databank-store.ts`, inside `_runStartupLoad()`, immediately after the view-mode fixup block (the `if (this._viewMode === 'history' && this._recentItems.length === 0) { this._viewMode = 'metadata'; }` block ending ~line 836) and BEFORE the `// Electron with NO backend sidecar` comment (~line 838), insert:

```ts
      // Lite web build: no HTTP backend and no Electron IPC — there is
      // nothing to load. Present an empty, ready library so the UI (which
      // hides backend surfaces via isLiteBuild) never spins or fires dead
      // /api calls.
      if (isLiteBuild()) {
        this._loadStatus = 'loaded';
        this.notify();
        return;
      }
```

- [ ] **Step 7: Verify typecheck + unit tests**

Run: `cd src/frontend && npx tsc -b && npx vitest run`
Expected: typecheck clean; all unit tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/frontend/src/store/build-mode.ts src/frontend/src/store/build-mode.test.ts src/frontend/src/store/databank-store.ts
git commit -m "feat(lite): isLiteBuild() flag + central databank backend short-circuit"
```

---

### Task 3: Zero `/api` — gate every backend network path

Boot-time module side-effects first (they poll forever), then call-driven fires, then the two review-found leaks: the worklist AI-relay 5-second poll and the drop-handler update-bundle branches.

**Files:**
- Modify: `src/frontend/src/store/update-store.ts` (imports; boot block 429-433)
- Modify: `src/frontend/src/store/librarysync-store.ts` (imports; boot block 174)
- Modify: `src/frontend/src/store/mcp-bridge.ts` (imports; `startMcpBridgeIfEnabled` 147-155)
- Modify: `src/frontend/src/store/obd-store.ts` (imports; `loadMatches` 106, `loadCachedData` 155, `refreshStatus` 176, `fetchBoard` 195, `syncIndex` 223, `clearCache` 245)
- Modify: `src/frontend/src/pdf/pdf-index-client.ts` (imports; `ensureIndexed` 91)
- Modify: `src/frontend/src/store/incoming-upload.ts` (imports; guard 25)
- Modify: `src/frontend/src/panels/WorklistPanel.tsx` (imports; `AiWorklistSection` call site ~396)
- Modify: `src/frontend/src/App.tsx` (imports; `handleDrop` update-bundle branches 191 + 203)

**Interfaces:**
- Consumes: `isLiteBuild()` from Task 2.

- [ ] **Step 1: Gate the update-store boot poll**

In `src/frontend/src/store/update-store.ts`, add the import at the top:

```ts
import { isLiteBuild } from './build-mode';
```

Change the boot block (lines 429-433) from:

```ts
if (typeof window !== 'undefined' && !import.meta.env.SSR) {
  updateStore.resumeIfRestarting();
  updateStore.fetchStatus();
  setInterval(() => updateStore.fetchStatus(), 30 * 60 * 1000);
}
```

to:

```ts
if (typeof window !== 'undefined' && !import.meta.env.SSR && !isLiteBuild()) {
  updateStore.resumeIfRestarting();
  updateStore.fetchStatus();
  setInterval(() => updateStore.fetchStatus(), 30 * 60 * 1000);
}
```

- [ ] **Step 2: Gate the librarysync-store boot poll**

In `src/frontend/src/store/librarysync-store.ts`, add the import:

```ts
import { isLiteBuild } from './build-mode';
```

Change the boot block opening condition (line 174) from:

```ts
if (typeof window !== 'undefined' && !import.meta.env.SSR) {
```

to:

```ts
if (typeof window !== 'undefined' && !import.meta.env.SSR && !isLiteBuild()) {
```

(Leave the block body unchanged.)

- [ ] **Step 3: Gate the MCP bridge start**

In `src/frontend/src/store/mcp-bridge.ts`, add the import:

```ts
import { isLiteBuild } from './build-mode';
```

Change `startMcpBridgeIfEnabled()` (lines 147-155) to:

```ts
/** Check whether MCP is enabled on the backend and, if so, start the bridge. */
export function startMcpBridgeIfEnabled() {
  if (isLiteBuild()) return;   // lite web build: no backend, no bridge
  fetch('/api/mcp/status')
    .then((r) => (r.ok ? r.json() : null))
    .then((s) => {
      if (s && s.enabled) startMcpBridge();
    })
    .catch(() => {});
}
```

- [ ] **Step 4: Gate all six OBD fetchers**

In `src/frontend/src/store/obd-store.ts`, add the import:

```ts
import { isLiteBuild } from './build-mode';
```

Add a guard as the first line of each fetcher (three UI entry points + three siblings, belt-and-suspenders):

`loadMatches` (line 106):

```ts
  async loadMatches(boardNumber: string): Promise<ObdMatch[]> {
    if (isLiteBuild()) return [];
    if (!boardNumber) return [];
```

`loadCachedData` (line 155):

```ts
  async loadCachedData(bpath: string): Promise<ObdData | null> {
    if (isLiteBuild()) return null;
    if (this._data.has(bpath)) return this._data.get(bpath)!;
```

`refreshStatus` (line 176):

```ts
  async refreshStatus(): Promise<void> {
    if (isLiteBuild()) return;
    try {
```

`fetchBoard` (line 195):

```ts
  async fetchBoard(bpath: string): Promise<ObdData | null> {
    if (isLiteBuild()) return null;
    if (this._fetching.has(bpath)) return null;
```

`syncIndex` (line 223):

```ts
  async syncIndex(): Promise<void> {
    if (isLiteBuild()) return;
    if (this._syncing) return;
```

`clearCache` (line 245):

```ts
  async clearCache(): Promise<void> {
    if (isLiteBuild()) return;
    const res = await fetch('/api/obd/cache', { method: 'DELETE' });
```

- [ ] **Step 5: Gate the PDF-index on-open upload**

In `src/frontend/src/pdf/pdf-index-client.ts`, add the import (relative path from `pdf/`):

```ts
import { isLiteBuild } from '../store/build-mode';
```

Guard `ensureIndexed` (line 91) as its first line:

```ts
export function ensureIndexed(fileId: number, getTextPages: () => string[][]): Promise<void> {
  if (isLiteBuild()) return Promise.resolve();
  const existing = inflight.get(fileId);
```

- [ ] **Step 6: Gate the incoming-upload path**

In `src/frontend/src/store/incoming-upload.ts`, add the import (after line 3):

```ts
import { isLiteBuild } from './build-mode';
```

Change the guard (line 25) from:

```ts
  if (isElectron()) return;
```

to:

```ts
  if (isElectron() || isLiteBuild()) return;
```

- [ ] **Step 7: Gate the worklist AI-relay poll (review finding)**

`AiWorklistSection` in `src/frontend/src/panels/WorklistPanel.tsx` polls `/api/mcp/status` every 5 s from a mount effect whenever a worklist is open. Gate the **call site** (not inside the component — an early return before its hooks would violate rules-of-hooks).

Add the import:

```ts
import { isLiteBuild } from '../store/build-mode';
```

Change the call site (~line 396) from:

```tsx
        ))}
      </div>
      <AiWorklistSection worklist={activeWorklist} />
    </>
```

to:

```tsx
        ))}
      </div>
      {!isLiteBuild() && <AiWorklistSection worklist={activeWorklist} />}
    </>
```

The local worklist itself (parts/nets rows, notes, clipboard flow) stays fully functional.

- [ ] **Step 8: Gate the drop-handler update-bundle branches (review finding)**

Dropping `latest-update.tar` / `*.brupdate` on the lite build would `window.confirm` and then `POST /api/update/apply-bundle`. In `src/frontend/src/App.tsx`, add the import:

```ts
import { isLiteBuild } from './store/build-mode';
```

In `handleDrop`, change the two dispatch conditions (lines 191 and 203) from:

```ts
      if (!isElectron() && isUpdateBundle(file.name)) {
```
```ts
      if (!isElectron() && isDockerImageTarball(file.name)) {
```

to:

```ts
      if (!isElectron() && !isLiteBuild() && isUpdateBundle(file.name)) {
```
```ts
      if (!isElectron() && !isLiteBuild() && isDockerImageTarball(file.name)) {
```

Dropped `.tar` files then fall through to the normal "unsupported file" toast — correct for a build that cannot self-update.

- [ ] **Step 9: Verify typecheck + lint**

Run: `cd src/frontend && npx tsc -b && npm run lint`
Expected: both clean. (Behavioral proof — zero `/api` — is asserted end-to-end in Task 6.)

- [ ] **Step 10: Commit**

```bash
git add src/frontend/src/store/update-store.ts src/frontend/src/store/librarysync-store.ts src/frontend/src/store/mcp-bridge.ts src/frontend/src/store/obd-store.ts src/frontend/src/pdf/pdf-index-client.ts src/frontend/src/store/incoming-upload.ts src/frontend/src/panels/WorklistPanel.tsx src/frontend/src/App.tsx
git commit -m "feat(lite): zero /api — gate boot, call-driven, worklist-poll and drop-bundle paths"
```

---

### Task 4: Hide backend UI surfaces

Removes every dead backend surface: the Library sidebar tab + panel, the update badge, the Home "Library" section, and the backend Settings tabs/sections (Library, Integrations, Software update — the first transitively hides the Database Editor launcher, whose only call site is there; the settings search self-heals because `TabPill` and `SearchEmptyState` both derive from `TAB_ORDER`).

**Files:**
- Modify: `src/frontend/src/components/Sidebar.utils.ts` (imports; `TABS` 21-25; default `activeTab` 54; `showSidebarTab` 74-78; `toggleLibrarySidebar` 86-96)
- Modify: `src/frontend/src/components/Sidebar.tsx` (imports; Library panel div 132-134)
- Modify: `src/frontend/src/components/Toolbar.tsx` (imports; badge 553)
- Modify: `src/frontend/src/components/home/HomeBackdrop.tsx` (imports; `AutoOpenPdfToggle` usage 936; Library section 942-945)
- Modify: `src/frontend/src/panels/SettingsPanel.tsx` (imports; `TAB_ORDER` 65; `SoftwareUpdateSection` 2332)

**Interfaces:**
- Consumes: `isLiteBuild()` from Task 2.

- [ ] **Step 1: Remove the Library from the sidebar tab registry + defaults**

In `src/frontend/src/components/Sidebar.utils.ts`, add the import (after the doc comment, before the constants):

```ts
import { isLiteBuild } from '../store/build-mode';
```

Change `TABS` (lines 21-25) to drop `library` in the lite build:

```ts
export const TABS: { id: SidebarTab; label: string }[] = [
  { id: 'library', label: 'Library' },
  { id: 'settings', label: 'Settings' },
  { id: 'debug', label: 'Debug' },
].filter(t => !(isLiteBuild() && t.id === 'library'));
```

Change the default active tab (line 54) so the lite build doesn't open on the (now-absent) Library:

```ts
  activeTab: (isLiteBuild() ? 'settings' : 'library') as SidebarTab,
```

Guard `showSidebarTab` (lines 74-78) so nothing can select Library in the lite build:

```ts
export function showSidebarTab(tab: SidebarTab): void {
  state.activeTab = (isLiteBuild() && tab === 'library') ? 'settings' : tab;
  if (state.collapsed) state.collapsed = false;
  emitSidebarChange();
}
```

Degrade `toggleLibrarySidebar` (lines 86-96) to a plain sidebar toggle in the lite build (its only external caller is the library keyboard shortcut, `useKeyboardShortcuts.ts:423` — verified in review):

```ts
export function toggleLibrarySidebar(): void {
  // Pure toggle:
  //   collapsed                          → open with library tab
  //   open on a non-library tab          → switch to library tab
  //   open on library tab                → collapse
  // Lite build has no library tab — degrade to a plain sidebar toggle.
  if (isLiteBuild()) { toggleSidebar(); return; }
  if (state.collapsed || state.activeTab !== 'library') {
    showSidebarTab('library');
  } else {
    toggleSidebar();
  }
}
```

- [ ] **Step 2: Don't mount the Library panel in the lite build**

In `src/frontend/src/components/Sidebar.tsx`, add the import (with the other imports near the top):

```ts
import { isLiteBuild } from '../store/build-mode';
```

Change the Library panel wrapper (lines 132-134) so `LibraryPanel` never mounts (it otherwise stays mounted with `display:none` and would run its effects):

```tsx
        {!isLiteBuild() && (
          <div style={{ display: activeTab === 'library' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
            <LibraryPanel />
          </div>
        )}
```

- [ ] **Step 3: Hide the update badge**

In `src/frontend/src/components/Toolbar.tsx`, add the import (after line 14 `import { databankStore, isElectron } from '../store/databank-store';`):

```ts
import { isLiteBuild } from '../store/build-mode';
```

Change the badge render (line 553) from:

```tsx
      {!isElectron() && <UpdateBadge update={update} />}
```

to:

```tsx
      {!isElectron() && !isLiteBuild() && <UpdateBadge update={update} />}
```

- [ ] **Step 4: Hide the Home "Library" section + auto-open-PDF toggle**

In `src/frontend/src/components/home/HomeBackdrop.tsx`, add the import (with the store imports near line 4):

```ts
import { isLiteBuild } from '../../store/build-mode';
```

In `QuickSettings`, drop the auto-open-bound-PDFs toggle (line 936 — a library-binding feature) in the lite build:

```tsx
          <AutoSwitchToggle />
          {!isLiteBuild() && <AutoOpenPdfToggle />}
          <ThemeSelect />
          <InterfaceColorPickers />
```

And hide the whole "Library" quick-section (lines 942-945):

```tsx
      {!isLiteBuild() && (
        <div className="home-quick-section">
          <h3 className="home-quick-section-title">Library</h3>
          <LibraryStats />
        </div>
      )}
```

- [ ] **Step 5: Hide the backend Settings tabs + Software-update section**

In `src/frontend/src/panels/SettingsPanel.tsx`, add the import (after line 36 `import { isElectron, hasBackend } from '../store/databank-store';`):

```ts
import { isLiteBuild } from '../store/build-mode';
```

Change `TAB_ORDER` (line 65) to drop the `library` and `integrations` tabs in the lite build. The active-tab normalizer (line 107), the tab-bar render (line 1946), and the search machinery (`TabPill`, `SearchEmptyState`) all consult `TAB_ORDER`, so filtering here removes the buttons AND makes their content blocks (`activeTab === 'library'` / `=== 'integrations'` / `=== SECTION_TO_TAB.server` — including the "Open Database Editor" button, Library Sync, and MCP settings) permanently unreachable:

```ts
const TAB_ORDER: SettingsTabId[] = (['theme', 'board', 'input', 'library', 'system', 'integrations'] as SettingsTabId[])
  .filter(t => !(isLiteBuild() && (t === 'library' || t === 'integrations')));
```

The `system` tab stays (local Troubleshooting/cache controls), so hide only its backend child — `SoftwareUpdateSection` (line 2332):

```tsx
      {activeTab === 'system' && (
        <>
          {!isLiteBuild() && <SoftwareUpdateSection />}
          {/* Cache/render resets are troubleshooting tools, not everyday
              controls — demoted from the panel header into their own block. */}
          <StandaloneCollapsibleSection title="Troubleshooting" defaultOpen={false}
            storageKey="troubleshooting" searchSectionId="troubleshooting">
            <CacheControlBar hasBoard={hasBoard} />
          </StandaloneCollapsibleSection>
        </>
      )}
```

- [ ] **Step 6: Verify typecheck + lint**

Run: `cd src/frontend && npx tsc -b && npm run lint`
Expected: both clean. (Visible-UI proof is asserted in Task 6.)

- [ ] **Step 7: Commit**

```bash
git add src/frontend/src/components/Sidebar.utils.ts src/frontend/src/components/Sidebar.tsx src/frontend/src/components/Toolbar.tsx src/frontend/src/components/home/HomeBackdrop.tsx src/frontend/src/panels/SettingsPanel.tsx
git commit -m "feat(lite): hide backend UI (library tab, update badge, backend settings)"
```

---

### Task 5: PWA — installable + offline

Service worker + web manifest, lite-only. Precache MUST include `.mjs` (the pdf.js worker — PDF viewing offline depends on it; review finding).

**Files:**
- Modify: `src/frontend/package.json` (add `vite-plugin-pwa` devDependency)
- Modify: `src/frontend/vite.config.ts` (conditionally add the PWA plugin in lite mode)

**Interfaces:**
- Consumes: the `lite` flag inside `vite.config.ts` (Task 1).
- Produces: `manifest.webmanifest` + generated service worker in `dist-lite/`; a `<link rel="manifest">` injected into the page (including the lite dev server, via `devOptions.enabled`).

- [ ] **Step 1: Add the dependency**

Run:

```bash
cd src/frontend && npm install -D vite-plugin-pwa
```

Expected: `vite-plugin-pwa` appears in `devDependencies`; `package-lock.json` updates.

- [ ] **Step 2: Wire the plugin into `vite.config.ts` (lite-only)**

In `src/frontend/vite.config.ts`, add the import at the top:

```ts
import { VitePWA } from 'vite-plugin-pwa'
```

Change the `plugins` array so the PWA plugin exists ONLY in the lite build:

```ts
    plugins: [
      react(),
      ...(lite ? [VitePWA({
        registerType: 'autoUpdate',      // new deploy picked up on next load
        injectRegister: 'auto',          // registration script injected at build
        // Serve the manifest + SW on `vite --mode lite` dev too, so the E2E
        // and manual testing exercise the real thing.
        devOptions: { enabled: true },
        workbox: {
          // NOTE 'mjs': the pdf.js worker is emitted as an .mjs asset — omit
          // it and PDF viewing breaks offline.
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
```

(Leave `base`, `define`, `build`, `server` as set in Task 1.)

- [ ] **Step 3: Build and verify SW, manifest, and worker precache**

Run:

```bash
cd src/frontend && npm run build:lite
ls dist-lite | grep -E 'sw\.js|workbox|manifest\.webmanifest'
grep -o 'rel="manifest"' dist-lite/index.html
grep -c 'pdf.worker' dist-lite/sw.js
```

Expected: `sw.js` + `manifest.webmanifest` present; one `rel="manifest"` match; the last grep returns ≥1 (the pdf.js worker is in the precache manifest — the review-found `.mjs` glob at work).

- [ ] **Step 4: Confirm the NAS build is unaffected**

Run:

```bash
cd src/frontend && npm run build
ls dist | grep -E 'sw\.js|manifest\.webmanifest' || echo "NAS build has no PWA artifacts (correct)"
```

Expected: prints the "no PWA artifacts (correct)" line.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/package.json src/frontend/package-lock.json src/frontend/vite.config.ts
git commit -m "feat(lite): PWA (installable + offline, pdf worker precached) for lite build only"
```

---

### Task 6: Lite E2E gate — dev at root AND built bundle under the sub-path

The integration proof, run twice via two Playwright projects: (a) `vite --mode lite` dev server at root; (b) the **built** bundle served at `/boardripper/web/` by a dependency-free static server — so relative-base regressions surface in CI, not on the host. Asserts zero `/api/*` (cold load AND after a real board open through the file input), zero failed responses, backend UI absent, manifest present.

**Files:**
- Create: `src/frontend/scripts/serve-lite.mjs`
- Create: `src/frontend/playwright.lite.config.ts`
- Create: `src/frontend/tests/web-lite.spec.ts`

**Interfaces:**
- Consumes: `test:lite` + `serve:lite` scripts (Task 1); the lite build behavior (Tasks 2-5); the tracked fixture `src/frontend/public/samples/test-board.bvr` (already in the repo — synthetic, 10 parts).

- [ ] **Step 1: Create the sub-path static server**

Create `src/frontend/scripts/serve-lite.mjs`:

```js
#!/usr/bin/env node
/**
 * Serves dist-lite/ under the /boardripper/web/ sub-path — mirroring the
 * production mount at ripperdoc.de — so relative-base regressions surface in
 * the lite E2E (and in manual checks via `npm run serve:lite`) instead of on
 * the live host. Dependency-free on purpose.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.argv[2] ?? 18086);
const PREFIX = '/boardripper/web';
const ROOT = fileURLToPath(new URL('../dist-lite', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  if (!url.pathname.startsWith(PREFIX)) {
    res.writeHead(302, { Location: `${PREFIX}/` });
    return res.end();
  }
  let rel = url.pathname.slice(PREFIX.length) || '/';
  if (rel.endsWith('/')) rel += 'index.html';
  const file = normalize(join(ROOT, rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`not found: ${url.pathname}`);
  }
}).listen(PORT, () => {
  console.log(`lite build at http://localhost:${PORT}${PREFIX}/`);
});
```

- [ ] **Step 2: Create the lite Playwright config (two projects, two servers)**

Create `src/frontend/playwright.lite.config.ts`:

```ts
import { defineConfig } from '@playwright/test';

// Lite-build E2E. Two projects run the SAME spec:
//   lite-dev          — `vite --mode lite` dev server at the root path.
//   lite-dist-subpath — the BUILT bundle served under /boardripper/web/ by
//                       scripts/serve-lite.mjs, exercising the relative base
//                       exactly as production mounts it.
// Tests must navigate with page.goto('.') — goto('/') would escape the
// sub-path baseURL.
const DEV_PORT = process.env.LITE_DEV_PORT ? Number(process.env.LITE_DEV_PORT) : 18085;
const DIST_PORT = process.env.LITE_DIST_PORT ? Number(process.env.LITE_DIST_PORT) : 18086;

export default defineConfig({
  testDir: './tests',
  testMatch: /web-lite\.spec\.ts/,
  timeout: 30000,
  retries: 0,
  use: {
    headless: true,
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'lite-dev', use: { baseURL: `http://localhost:${DEV_PORT}/` } },
    { name: 'lite-dist-subpath', use: { baseURL: `http://localhost:${DIST_PORT}/boardripper/web/` } },
  ],
  webServer: [
    {
      command: `npx vite --mode lite --port ${DEV_PORT} --strictPort`,
      port: DEV_PORT,
      reuseExistingServer: true,
      timeout: 20000,
    },
    {
      // Builds first, then serves the bundle — generous timeout for tsc+vite.
      command: `npm run build:lite && node scripts/serve-lite.mjs ${DIST_PORT}`,
      port: DIST_PORT,
      reuseExistingServer: true,
      timeout: 240000,
    },
  ],
});
```

- [ ] **Step 3: Write the E2E spec**

Create `src/frontend/tests/web-lite.spec.ts`:

```ts
import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

// Tracked synthetic fixture (10 parts: U1, R1-R4, C1-C3, U2, J1) — same file
// comprehensive.spec.ts uses. Not proprietary; ships in public/samples/.
const TEST_BVR1 = path.resolve(__dirname, '../public/samples/test-board.bvr');

/** Record every request whose path contains /api/, for the whole test. */
function trackApi(page: Page): string[] {
  const calls: string[] = [];
  page.on('request', (req) => {
    try {
      const u = new URL(req.url());
      if (u.pathname.includes('/api/')) calls.push(`${req.method()} ${u.pathname}`);
    } catch { /* non-URL scheme, ignore */ }
  });
  return calls;
}

/** Record every failed (>=400) response — catches /-rooted asset misses under the sub-path. */
function trackFailures(page: Page): string[] {
  const bad: string[] = [];
  page.on('response', (res) => {
    if (res.status() >= 400) bad.push(`${res.status()} ${res.url()}`);
  });
  return bad;
}

// NOTE: goto('.') everywhere — goto('/') would escape the sub-path baseURL of
// the lite-dist-subpath project.

test('cold load: zero /api requests, zero failed responses', async ({ page }) => {
  const api = trackApi(page);
  const bad = trackFailures(page);
  await page.goto('.');
  await page.waitForLoadState('networkidle');
  // Let mount effects and the first tick of any interval settle.
  await page.waitForTimeout(1500);
  expect(api, `unexpected /api calls: ${api.join(', ')}`).toEqual([]);
  expect(bad, `failed requests: ${bad.join(', ')}`).toEqual([]);
});

test('board opens locally and stays network-silent', async ({ page }) => {
  const api = trackApi(page);
  await page.goto('.');
  await page.waitForLoadState('networkidle');
  // Upload through the real hidden file input. Rename the fixture to an
  // Apple-style board number so the OBD board-open path (obdStore.loadMatches
  // from BoardViewerPanel) would fire if it were ungated.
  await page.getByTestId('file-input').setInputFiles({
    name: '820-00281.bvr',
    mimeType: 'application/octet-stream',
    buffer: fs.readFileSync(TEST_BVR1),
  });
  await expect(page.getByTestId('statusbar')).toContainText('parts', { timeout: 15000 });
  await page.waitForTimeout(1000);
  expect(api, `unexpected /api calls after board open: ${api.join(', ')}`).toEqual([]);
});

test('backend-only UI is absent', async ({ page }) => {
  await page.goto('.');
  await page.waitForLoadState('networkidle');
  // Self-update badge — gated off in the lite build.
  await expect(page.getByTestId('update-badge')).toHaveCount(0);
  // Library sidebar tab — filtered out of the TABS registry.
  await expect(page.locator('.sidebar-tab', { hasText: 'Library' })).toHaveCount(0);
  // Backend settings tabs — filtered out of TAB_ORDER (sidebar opens on the
  // Settings tab by default in the lite build, so the pills are rendered).
  await expect(page.locator('.library-tab', { hasText: 'Integrations' })).toHaveCount(0);
  await expect(page.locator('.library-tab', { hasText: /^Library$/ })).toHaveCount(0);
});

test('PWA manifest is linked', async ({ page }) => {
  await page.goto('.');
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);
});
```

(The board-open test asserts parse-level success via the status bar — the same wait `comprehensive.spec.ts` uses — which does not depend on WebGL, so it holds in headless CI where the renderer itself cannot start.)

- [ ] **Step 4: Run the lite E2E**

Run:

```bash
cd src/frontend && npm run test:lite
```

Expected: 8 passed (4 tests × 2 projects). If "zero /api" fails, the printed list names the offending endpoint — add an `isLiteBuild()` guard at that source (Task 3 pattern) and re-run. If a failed-response entry appears only in `lite-dist-subpath`, it is a `/`-rooted asset — make that reference relative.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/scripts/serve-lite.mjs src/frontend/playwright.lite.config.ts src/frontend/tests/web-lite.spec.ts
git commit -m "test(lite): E2E gate — zero /api (cold + board open), sub-path dist project, PWA manifest"
```

---

### Task 7: Operator docs + spec status

**Files:**
- Create: `src/frontend/LITE_BUILD.md`
- Modify: `docs/specs/2026-07-20-boardripper-web-standalone-design.md` (Status line)

**Interfaces:** none (docs only).

- [ ] **Step 1: Write the operator note**

Create `src/frontend/LITE_BUILD.md`:

```markdown
# BoardRipper Web — lite build (backend-free)

The full BoardRipper viewer/inspector as a static site — local file open /
drag-drop only, no server. Not a demo: same renderer, same interface, same
shortcuts as mainline; it tracks the app automatically because nothing is
forked. Hosted at `ripperdoc.de/boardripper/web`, later mirrored to a
`*.web.app` root.

## Build

    cd src/frontend
    npm run build:lite        # → dist-lite/ (relative base, PWA, no backend UI)

`dist-lite/` is self-contained and host-portable (relative base) — deploy the
folder as-is at any mount point via the RipperDocWeb rsync, same as `landing/`.

## Local preview / test

    npm run serve:lite        # dist-lite/ at http://localhost:18086/boardripper/web/
    npm run preview:lite      # dist-lite/ at the root path
    npx vite --mode lite      # dev server in lite mode
    npm run test:lite         # E2E gate: zero /api, sub-path dist project, UI absence

## Manual bench checklist (WebGL — headless CI cannot cover these)

1. Open a board (drag-drop + toolbar open) — renders, selection works.
2. Open a PDF — renders; rotate/mirror work.
3. FZ file → key dialog appears; mirror links + paste-back work.
4. Install as PWA, go offline, reload — app shell + PDF viewing still work.

## Host requirement

Serve with NO `Cross-Origin-Embedder-Policy` header, or `COEP: credentialless`
— never `require-corp`. The FZ-key "Fetch" button and cross-origin OBD images
are browser `fetch()`es to third-party origins that `require-corp` would block.

## Definition of the build type

One flag: `store/build-mode.ts` `isLiteBuild()` — true only under
`--mode lite`. A new backend-coupled feature needs exactly one `isLiteBuild()`
guard at its registration point. Never gate lite UI on `hasBackend()`: that is
also false on desktop (Electron, MCP off), where library features work via IPC.
```

- [ ] **Step 2: Update the spec status**

In `docs/specs/2026-07-20-boardripper-web-standalone-design.md`, change the Status line near the top to:

```markdown
**Status:** Implemented — see plan `docs/plans/2026-07-20-boardripper-web-standalone-plan.md` and `src/frontend/LITE_BUILD.md`.
```

- [ ] **Step 3: Commit**

```bash
git add docs/specs/2026-07-20-boardripper-web-standalone-design.md src/frontend/LITE_BUILD.md
git commit -m "docs(lite): operator note + spec status"
```

---

## Self-Review

**1. Spec coverage:**
- §4.1 mode-as-build-type / relative base / dist-lite → Task 1. ✓
- §4.2 `isLiteBuild()` + `hasBackend()` short-circuit + databank startup short-circuit → Task 2. ✓
- §4.3 relative-base findings (favicon fix; worker/popout/css verified safe) → Task 1 Step 4; CI-covered by Task 6's dist-subpath project. ✓
- §4.4 PWA incl. `.mjs` precache → Task 5. ✓
- §4.5 WelcomeSetup needs no gating (fully local) → no task, by design. ✓
- §6 boot-time fires (update, sync, mcp) → Task 3 Steps 1-3. ✓
- §6 worklist AI-relay 5 s poll → Task 3 Step 7. ✓
- §6 call-driven (obd ×6, pdf-index, incoming, App drop bundles) → Task 3 Steps 4-6, 8. ✓
- §6 UI (sidebar, toolbar badge, home, settings TAB_ORDER + SoftwareUpdateSection) → Task 4. ✓
- §6 transitively hidden (UpdateProgressOverlay, DatabaseEditorPanel launcher, PDF FTS UI, settings search, popouts) → verified, no edits. ✓
- §8 deploy + serve:lite + COEP host requirement → Tasks 1, 6, 7. ✓
- §9 risks: sub-path CI coverage (Task 6), FZ (no change needed), SW staleness (`autoUpdate`, Task 5), zero-`/api` incl. board open (Task 6), NAS isolation checks (Tasks 1 Step 5, 5 Step 4). ✓
- §10 testing: two projects, goto('.'), zero-api + zero-failures, board-open via renamed tracked fixture, UI absence, manifest → Task 6. Pixel rendering manual → LITE_BUILD.md checklist (Task 7). ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; every command lists expected output. ✓

**3. Type/name consistency:** `isLiteBuild()` — defined once in Task 2, consumed in Tasks 3-4-5-6 discussion; import paths per file location (`./build-mode` from `store/`; `../store/build-mode` from `pdf/`, `components/`, `panels/`; `../../store/build-mode` from `components/home/`; `./store/build-mode` from `App.tsx`). `TABS`, `TAB_ORDER`, `SidebarTab`, `SettingsTabId`, `startMcpBridgeIfEnabled`, `ensureIndexed`, `saveDroppedToIncoming`, `loadMatches`/`loadCachedData`/`refreshStatus`/`fetchBoard`/`syncIndex`/`clearCache`, `AiWorklistSection`, `isUpdateBundle`/`isDockerImageTarball`, `SoftwareUpdateSection` — all match current source (verified against line anchors during the 2026-07-21 review). Ports: 18085/18086 don't collide with the main config's 18083/11336. ✓

---

## Execution Handoff

(Filled in by the driver after the user approves execution.)
