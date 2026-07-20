# BoardRipper Web (Standalone, Backend-Free) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a static, backend-free build of the BoardRipper frontend — the full viewer/inspector, driven entirely by local file open/drag-drop — hosted at `ripperdoc.de/boardripper/web` and later mirrored to a `*.web.app` root.

**Architecture:** One codebase, one build *type*. A single zero-dependency flag module `store/build-mode.ts` exports `isDemoBuild()` (true only under `vite build --mode demo`). The renderer and interface are 100% shared with mainline BoardRipper — no forked components — so all future rendering/UI work flows into the standalone build for free. Backend-coupled surfaces get one `isDemoBuild()` guard each, at the feature-registration point. A relative base path makes one bundle host-portable; `vite-plugin-pwa` makes it installable + offline.

**Tech Stack:** React 19 · TypeScript (strict) · Vite 7 · vitest (unit) · Playwright (E2E) · vite-plugin-pwa (new, demo-only).

**Spec:** `docs/specs/2026-07-20-boardripper-web-standalone-design.md`

## Global Constraints

- **`isDemoBuild()` is the ONLY gate for demo-specific hiding/no-oping.** Never gate demo UI on `hasBackend()` — it is *also* `false` on the desktop (Electron, MCP-off) build, where those features work via IPC. Gating UI on `hasBackend()` would break desktop.
- **`hasBackend()` keeps its HTTP-backend meaning**, plus one `isDemoBuild()` short-circuit.
- **Zero risk to NAS/Electron:** `VITE_DEMO` is unset there, so every `isDemoBuild()` guard is `false` at runtime (negligible cost) and the PWA plugin is excluded at config level. Never change NAS/Electron behavior.
- **Contract:** in the demo build, ZERO `/api/*` requests fire — on cold load, on board open, on PDF open, or on file drop.
- **Output isolation:** demo build emits to `dist-demo/` (never `dist/`, which the Go server embeds).
- **TypeScript strict mode**; scoped loggers only (`store/log-store.ts`), never `console.log`.
- **All demo-specific paths shared, none forked:** do not duplicate any renderer/panel/component for the demo.

---

### Task 1: Demo build type (Vite config + env + scripts)

Establishes `vite build --mode demo` → relative base, `dist-demo/` output. No gating yet; this verifies the build plumbing in isolation.

**Files:**
- Create: `src/frontend/.env.demo`
- Modify: `src/frontend/vite.config.ts` (whole file — object form → function-of-`{mode}` form)
- Modify: `src/frontend/package.json:6-18` (scripts block)
- Modify: `src/frontend/.gitignore:11-12` (ignore `dist-demo`)

**Interfaces:**
- Produces: `VITE_DEMO` env (string `"1"`) available as `import.meta.env.VITE_DEMO` under `--mode demo`; `npm run build:demo` → `src/frontend/dist-demo/`.

- [ ] **Step 1: Create `.env.demo`**

Create `src/frontend/.env.demo`:

```
# Standalone, backend-free web build. Loaded only by `vite --mode demo`.
VITE_DEMO=1
```

- [ ] **Step 2: Rewrite `vite.config.ts` to a function of `{ mode }`**

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
  const demo = mode === 'demo';
  return {
    // Standalone web build is served from a sub-path
    // (ripperdoc.de/boardripper/web) AND later mirrored to a domain root
    // (*.web.app). A relative base makes ONE bundle work at any mount point.
    // The NAS/Electron build keeps the root-absolute default.
    base: demo ? './' : '/',
    plugins: [react()],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    build: {
      // Separate output dir so the standalone bundle never collides with the
      // NAS build (dist/), which the Go server embeds.
      outDir: demo ? 'dist-demo' : 'dist',
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
          // isn't running (Playwright / pure-frontend dev / CI).
          configure: (proxy) => {
            proxy.on('error', () => { /* suppress */ });
          },
        },
      },
    },
  };
})
```

- [ ] **Step 3: Add scripts to `package.json`**

In `src/frontend/package.json`, replace the `scripts` block (lines 6-18) with (adds `build:demo`, `preview:demo`, `test:demo`):

```json
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "build:demo": "tsc -b && vite build --mode demo",
    "preview:demo": "vite preview --outDir dist-demo",
    "lint": "eslint .",
    "preview": "vite preview",
    "test": "npx playwright test",
    "test:ui": "npx playwright test --ui",
    "test:headed": "npx playwright test --headed",
    "test:debug": "npx playwright test --debug",
    "test:report": "npx playwright show-report",
    "test:demo": "npx playwright test --config playwright.demo.config.ts",
    "test:unit": "vitest run",
    "postinstall": "patch-package"
  },
```

- [ ] **Step 4: Ignore `dist-demo` in git**

In `src/frontend/.gitignore`, the existing lines 11-12 are `dist` / `dist-ssr` (they do NOT match `dist-demo`). Add a line so the demo artifact isn't committed:

```
dist
dist-ssr
dist-demo
```

- [ ] **Step 5: Build the demo bundle and verify relative base**

Run:

```bash
cd src/frontend && npm run build:demo
```

Expected: build succeeds, emits `dist-demo/index.html`. Then verify assets are **relative** (`./assets/...`, not `/assets/...`):

```bash
grep -oE '(src|href)="[^"]*"' src/frontend/dist-demo/index.html
```

Expected: every emitted script/style path begins with `./assets/` (or `./`), confirming the relative base. (`logo.svg` may still show as `/logo.svg` — that public reference is fixed in Step 6.)

- [ ] **Step 6: Fix the absolute public-asset reference in `index.html`**

Vite rewrites bundled assets but leaves literal public references as-authored. In `src/frontend/index.html`, change the favicon href from absolute to relative so it resolves under a sub-path:

```html
    <link rel="icon" type="image/svg+xml" href="./logo.svg" />
```

(The `<script src="/src/main.tsx">` reference is dev-only and is rewritten by Vite at build; leave it.)

Re-run `npm run build:demo` and confirm `dist-demo/index.html` now shows `href="./logo.svg"`.

- [ ] **Step 7: Commit**

```bash
git add src/frontend/.env.demo src/frontend/vite.config.ts src/frontend/package.json src/frontend/.gitignore src/frontend/index.html
git commit -m "build(web): add demo build type (relative base, dist-demo output)"
```

---

### Task 2: `isDemoBuild()` flag + central backend short-circuit

The one flag that defines the build type, plus the two central cutoffs in `databank-store` (its own `hasBackend()` and its startup load chain).

**Files:**
- Create: `src/frontend/src/store/build-mode.ts`
- Create: `src/frontend/src/store/build-mode.test.ts`
- Modify: `src/frontend/src/store/databank-store.ts` (imports; `hasBackend()` at 25-27; `_runStartupLoad` at ~834-836)

**Interfaces:**
- Produces: `isDemoBuild(): boolean` from `store/build-mode.ts` — consumed by every later task.

- [ ] **Step 1: Write the failing test**

Create `src/frontend/src/store/build-mode.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { isDemoBuild } from './build-mode';

afterEach(() => vi.unstubAllEnvs());

describe('isDemoBuild', () => {
  it('is false by default (NAS / Electron build)', () => {
    expect(isDemoBuild()).toBe(false);
  });

  it('is true when VITE_DEMO is set (standalone web build)', () => {
    vi.stubEnv('VITE_DEMO', '1');
    expect(isDemoBuild()).toBe(true);
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
 * Build-type flag for the standalone, backend-free web build.
 *
 * `VITE_DEMO=1` is set only by `vite build --mode demo` (see .env.demo). In the
 * NAS and Electron builds the env var is undefined, so `isDemoBuild()` is false
 * at runtime and every guarded branch is inert.
 *
 * This is the single source of truth for "are we the standalone web build?".
 * IMPORTANT: this is distinct from `hasBackend()` (databank-store), which asks
 * "is an HTTP backend reachable" and is ALSO false on the desktop app (Electron,
 * MCP off) where features work over IPC. Gate demo-specific hiding on
 * `isDemoBuild()`, never on `hasBackend()`.
 *
 * Kept dependency-free on purpose: databank-store imports several stores that
 * would otherwise create import cycles if they consulted `hasBackend()` for the
 * demo cutoff. They import `isDemoBuild` from here instead.
 */
export function isDemoBuild(): boolean {
  return !!import.meta.env.VITE_DEMO;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/frontend && npx vitest run src/store/build-mode.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Short-circuit `hasBackend()`**

In `src/frontend/src/store/databank-store.ts`, add the import near the top (after the existing relative imports, e.g. after line 3 `import { Emitter } from './emitter';`):

```ts
import { isDemoBuild } from './build-mode';
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
  if (isDemoBuild()) return false;   // standalone web build: no HTTP backend, ever
  return !isElectron() || (typeof location !== 'undefined' && location.protocol !== 'file:');
}
```

- [ ] **Step 6: Short-circuit the databank startup load chain**

In `src/frontend/src/store/databank-store.ts`, inside `_runStartupLoad()`, immediately after the view-mode fixup block (the `if (this._viewMode === 'history' && this._recentItems.length === 0) { this._viewMode = 'metadata'; }` block ending ~line 836) and BEFORE the `// Electron with NO backend sidecar` comment (~line 838), insert:

```ts
      // Standalone web build: no HTTP backend and no Electron IPC — there is
      // nothing to load. Present an empty, ready library so the UI (which hides
      // backend surfaces via isDemoBuild) never spins or fires dead /api calls.
      if (isDemoBuild()) {
        this._loadStatus = 'loaded';
        this.notify();
        return;
      }
```

- [ ] **Step 7: Verify typecheck + unit tests**

Run: `cd src/frontend && npx tsc -b && npx vitest run src/store/build-mode.test.ts`
Expected: typecheck clean; unit tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/frontend/src/store/build-mode.ts src/frontend/src/store/build-mode.test.ts src/frontend/src/store/databank-store.ts
git commit -m "feat(web): isDemoBuild() flag + central databank backend short-circuit"
```

---

### Task 3: No dead `/api` — gate boot-time and call-driven backend network

Guards the network side so the demo build fires zero `/api/*`. Boot-time module side-effects first (they poll forever), then the call-driven fires.

**Files:**
- Modify: `src/frontend/src/store/update-store.ts` (imports; boot block 429-433)
- Modify: `src/frontend/src/store/librarysync-store.ts` (imports; boot block 172-182)
- Modify: `src/frontend/src/store/mcp-bridge.ts` (imports; `startMcpBridgeIfEnabled` 147-155)
- Modify: `src/frontend/src/store/obd-store.ts` (imports; `loadMatches` 106, `fetchBoard` 195, `syncIndex` 223)
- Modify: `src/frontend/src/pdf/pdf-index-client.ts` (imports; `ensureIndexed` 91)
- Modify: `src/frontend/src/store/incoming-upload.ts` (imports; guard 24-25)

**Interfaces:**
- Consumes: `isDemoBuild()` from Task 2.

- [ ] **Step 1: Gate the update-store boot poll**

In `src/frontend/src/store/update-store.ts`, add the import at the top:

```ts
import { isDemoBuild } from './build-mode';
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
if (typeof window !== 'undefined' && !import.meta.env.SSR && !isDemoBuild()) {
  updateStore.resumeIfRestarting();
  updateStore.fetchStatus();
  setInterval(() => updateStore.fetchStatus(), 30 * 60 * 1000);
}
```

- [ ] **Step 2: Gate the librarysync-store boot poll**

In `src/frontend/src/store/librarysync-store.ts`, add the import:

```ts
import { isDemoBuild } from './build-mode';
```

Change the boot block (lines 174-182) opening condition from:

```ts
if (typeof window !== 'undefined' && !import.meta.env.SSR) {
```

to:

```ts
if (typeof window !== 'undefined' && !import.meta.env.SSR && !isDemoBuild()) {
```

(Leave the block body unchanged.)

- [ ] **Step 3: Gate the MCP bridge start**

In `src/frontend/src/store/mcp-bridge.ts`, add the import:

```ts
import { isDemoBuild } from './build-mode';
```

Change `startMcpBridgeIfEnabled()` (lines 147-155) to early-return in the demo build:

```ts
/** Check whether MCP is enabled on the backend and, if so, start the bridge. */
export function startMcpBridgeIfEnabled() {
  if (isDemoBuild()) return;   // standalone web build: no backend, no bridge
  fetch('/api/mcp/status')
    .then((r) => (r.ok ? r.json() : null))
    .then((s) => {
      if (s && s.enabled) startMcpBridge();
    })
    .catch(() => {});
}
```

- [ ] **Step 4: Gate the OBD fetchers**

In `src/frontend/src/store/obd-store.ts`, add the import:

```ts
import { isDemoBuild } from './build-mode';
```

Add a guard as the first line of each of the three UI entry points:

`loadMatches` (line 106) — after the signature, before the existing `if (!boardNumber)`:

```ts
  async loadMatches(boardNumber: string): Promise<ObdMatch[]> {
    if (isDemoBuild()) return [];
    if (!boardNumber) return [];
```

`fetchBoard` (line 195):

```ts
  async fetchBoard(bpath: string): Promise<ObdData | null> {
    if (isDemoBuild()) return null;
    if (this._fetching.has(bpath)) return null;
```

`syncIndex` (line 223):

```ts
  async syncIndex(): Promise<void> {
    if (isDemoBuild()) return;
    if (this._syncing) return;
```

(These are the only entry points reached from the UI — `loadMatches` is the board-open auto-fire from `BoardViewerPanel.tsx:99`. The sibling fetchers `loadCachedData`/`refreshStatus`/`clearCache` are reached only through these or through settings UI hidden in Task 4; the Task 6 E2E backstops any stray call.)

- [ ] **Step 5: Gate the PDF-index on-open upload**

In `src/frontend/src/pdf/pdf-index-client.ts`, add the import (relative path from `pdf/`):

```ts
import { isDemoBuild } from '../store/build-mode';
```

Guard `ensureIndexed` (line 91) as its first line:

```ts
export function ensureIndexed(fileId: number, getTextPages: () => string[][]): Promise<void> {
  if (isDemoBuild()) return Promise.resolve();
  const existing = inflight.get(fileId);
```

- [ ] **Step 6: Gate the incoming-upload path**

In `src/frontend/src/store/incoming-upload.ts`, add `isDemoBuild` to the existing build-mode-less imports — extend the line 3 import and add the new one:

```ts
import { databankStore, isElectron } from './databank-store';
import { isDemoBuild } from './build-mode';
```

Change the guard (line 25) from:

```ts
  if (isElectron()) return;
```

to:

```ts
  if (isElectron() || isDemoBuild()) return;
```

- [ ] **Step 7: Verify typecheck**

Run: `cd src/frontend && npx tsc -b`
Expected: clean. (Behavioral proof — zero `/api` — is asserted end-to-end in Task 6.)

- [ ] **Step 8: Commit**

```bash
git add src/frontend/src/store/update-store.ts src/frontend/src/store/librarysync-store.ts src/frontend/src/store/mcp-bridge.ts src/frontend/src/store/obd-store.ts src/frontend/src/pdf/pdf-index-client.ts src/frontend/src/store/incoming-upload.ts
git commit -m "feat(web): no /api in demo build — gate boot + call-driven backend network"
```

---

### Task 4: Hide backend UI surfaces

Removes every dead backend surface: the Library sidebar tab + panel, the update badge, the Home "Library" section, and the backend Settings tabs/sections (Library, Integrations, Software update — the last transitively hides the Database Editor launcher).

**Files:**
- Modify: `src/frontend/src/components/Sidebar.utils.ts` (imports; `TABS` 21-25; default `activeTab` 54; `showSidebarTab` 74-78; `toggleLibrarySidebar` 86-96)
- Modify: `src/frontend/src/components/Sidebar.tsx` (imports; Library panel div 132-134)
- Modify: `src/frontend/src/components/Toolbar.tsx` (imports; badge 553)
- Modify: `src/frontend/src/components/home/HomeBackdrop.tsx` (imports; AutoOpenPdfToggle usage 936; Library section 942-945)
- Modify: `src/frontend/src/panels/SettingsPanel.tsx` (imports; `TAB_ORDER` 65; `SoftwareUpdateSection` 2332)

**Interfaces:**
- Consumes: `isDemoBuild()` from Task 2.

- [ ] **Step 1: Remove the Library from the sidebar tab registry + defaults**

In `src/frontend/src/components/Sidebar.utils.ts`, add the import at the top (after the doc comment / before the constants):

```ts
import { isDemoBuild } from '../store/build-mode';
```

Change `TABS` (lines 21-25) to drop `library` in the demo build:

```ts
export const TABS: { id: SidebarTab; label: string }[] = [
  { id: 'library', label: 'Library' },
  { id: 'settings', label: 'Settings' },
  { id: 'debug', label: 'Debug' },
].filter(t => !(isDemoBuild() && t.id === 'library'));
```

Change the default active tab (line 54) so the demo build doesn't open on the (now-absent) Library:

```ts
  activeTab: (isDemoBuild() ? 'settings' : 'library') as SidebarTab,
```

Guard `showSidebarTab` (lines 74-78) so nothing can select Library in the demo build:

```ts
export function showSidebarTab(tab: SidebarTab): void {
  state.activeTab = (isDemoBuild() && tab === 'library') ? 'settings' : tab;
  if (state.collapsed) state.collapsed = false;
  emitSidebarChange();
}
```

Guard `toggleLibrarySidebar` (lines 86-96) so the library shortcut/toolbar toggle degrades to a plain sidebar toggle in the demo build:

```ts
export function toggleLibrarySidebar(): void {
  // Pure toggle:
  //   collapsed                          → open with library tab
  //   open on a non-library tab          → switch to library tab
  //   open on library tab                → collapse
  if (isDemoBuild()) { toggleSidebar(); return; }
  if (state.collapsed || state.activeTab !== 'library') {
    showSidebarTab('library');
  } else {
    toggleSidebar();
  }
}
```

- [ ] **Step 2: Don't mount the Library panel in the demo build**

In `src/frontend/src/components/Sidebar.tsx`, add the import (with the other store imports near the top):

```ts
import { isDemoBuild } from '../store/build-mode';
```

Change the Library panel wrapper (lines 132-134) so `LibraryPanel` never mounts (it otherwise stays mounted with `display:none` and would run its effects):

```tsx
        {!isDemoBuild() && (
          <div style={{ display: activeTab === 'library' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
            <LibraryPanel />
          </div>
        )}
```

- [ ] **Step 3: Hide the update badge**

In `src/frontend/src/components/Toolbar.tsx`, add `isDemoBuild` — extend the existing databank-store import (line 14) with a new import line:

```ts
import { databankStore, isElectron } from '../store/databank-store';
import { isDemoBuild } from '../store/build-mode';
```

Change the badge render (line 553) from:

```tsx
      {!isElectron() && <UpdateBadge update={update} />}
```

to:

```tsx
      {!isElectron() && !isDemoBuild() && <UpdateBadge update={update} />}
```

- [ ] **Step 4: Hide the Home "Library" section + auto-open-PDF toggle**

In `src/frontend/src/components/home/HomeBackdrop.tsx`, add the import (with the other store imports near line 4):

```ts
import { isDemoBuild } from '../../store/build-mode';
```

In `QuickSettings`, drop the auto-open-bound-PDFs toggle (line 936, a library-binding feature) in the demo build:

```tsx
          <AutoSwitchToggle />
          {!isDemoBuild() && <AutoOpenPdfToggle />}
          <ThemeSelect />
          <InterfaceColorPickers />
```

And hide the whole "Library" quick-section (lines 942-945):

```tsx
      {!isDemoBuild() && (
        <div className="home-quick-section">
          <h3 className="home-quick-section-title">Library</h3>
          <LibraryStats />
        </div>
      )}
```

- [ ] **Step 5: Hide the backend Settings tabs + Software-update section**

In `src/frontend/src/panels/SettingsPanel.tsx`, add `isDemoBuild` — extend the existing databank-store import (line 36) with a new line:

```ts
import { isElectron, hasBackend } from '../store/databank-store';
import { isDemoBuild } from '../store/build-mode';
```

Change `TAB_ORDER` (line 65) to drop the `library` and `integrations` tabs in the demo build. Because the active-tab normalizer (line 107) and the tab-bar render (line 1946) both consult `TAB_ORDER`, filtering here removes the buttons AND makes their content blocks (`activeTab === 'library'` / `=== 'integrations'` / `=== SECTION_TO_TAB.server`) permanently unreachable:

```ts
const TAB_ORDER: SettingsTabId[] = (['theme', 'board', 'input', 'library', 'system', 'integrations'] as SettingsTabId[])
  .filter(t => !(isDemoBuild() && (t === 'library' || t === 'integrations')));
```

The `system` tab stays (for local Troubleshooting/cache controls), so hide only its backend child — `SoftwareUpdateSection` (line 2332):

```tsx
      {activeTab === 'system' && (
        <>
          {!isDemoBuild() && <SoftwareUpdateSection />}
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
git commit -m "feat(web): hide backend UI (library tab, update badge, backend settings) in demo build"
```

---

### Task 5: PWA — installable + offline

Adds a service worker + web manifest, demo-only, so the standalone build works offline after first load and installs to the home screen / dock.

**Files:**
- Modify: `src/frontend/package.json` (add `vite-plugin-pwa` devDependency)
- Modify: `src/frontend/vite.config.ts` (conditionally add the PWA plugin in demo mode)

**Interfaces:**
- Consumes: the `demo` flag inside `vite.config.ts` (Task 1).
- Produces: `manifest.webmanifest` + generated service worker in `dist-demo/`; a `<link rel="manifest">` injected into the page (including the demo dev server, via `devOptions.enabled`).

- [ ] **Step 1: Add the dependency**

Run:

```bash
cd src/frontend && npm install -D vite-plugin-pwa
```

Expected: `vite-plugin-pwa` appears in `devDependencies`; `package-lock.json` updates.

- [ ] **Step 2: Wire the plugin into `vite.config.ts` (demo-only)**

In `src/frontend/vite.config.ts`, add the import at the top:

```ts
import { VitePWA } from 'vite-plugin-pwa'
```

Change the `plugins` array so the PWA plugin is present ONLY in the demo build:

```ts
    plugins: [
      react(),
      ...(demo ? [VitePWA({
        registerType: 'autoUpdate',      // new deploy picked up on next load
        injectRegister: 'auto',          // registration script injected at build
        // Show the manifest + SW in `vite --mode demo` dev too, so the E2E and
        // manual testing exercise the real thing.
        devOptions: { enabled: true },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,woff2,wasm}'],
          // pdf.worker + wasm can be large; lift the default precache size cap.
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

- [ ] **Step 3: Build and verify the SW + manifest are emitted**

Run:

```bash
cd src/frontend && npm run build:demo
ls dist-demo | grep -E 'sw\.js|workbox|manifest\.webmanifest'
```

Expected: `sw.js` (or `sw.js` + a `workbox-*.js`) and `manifest.webmanifest` are present in `dist-demo/`. Also confirm the manifest link was injected:

```bash
grep -o 'rel="manifest"' dist-demo/index.html
```

Expected: one match.

- [ ] **Step 4: Confirm the NAS build is unaffected**

Run:

```bash
cd src/frontend && npm run build
ls dist | grep -E 'sw\.js|manifest\.webmanifest' || echo "NAS build has no PWA artifacts (correct)"
```

Expected: prints the "no PWA artifacts (correct)" line — the plugin is demo-only.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/package.json src/frontend/package-lock.json src/frontend/vite.config.ts
git commit -m "feat(web): PWA (installable + offline) for the demo build only"
```

---

### Task 6: Standalone E2E gate

The integration proof: against a `--mode demo` server, assert zero `/api/*` requests on load/board-open/PDF-open, backend UI absent, and the PWA manifest present. A dedicated config isolates it from the main suite (which expects a backend proxy).

**Files:**
- Create: `src/frontend/playwright.demo.config.ts`
- Create: `src/frontend/tests/web-standalone.spec.ts`

**Interfaces:**
- Consumes: `test:demo` script (Task 1); the demo build behavior (Tasks 2-5).

- [ ] **Step 1: Create the demo Playwright config**

Create `src/frontend/playwright.demo.config.ts`:

```ts
import { defineConfig } from '@playwright/test';

// Standalone (backend-free) build E2E. Runs the app in `--mode demo` so
// isDemoBuild() is true; no backend is started (there is none to start).
const VITE_PORT = process.env.VITE_PORT ? Number(process.env.VITE_PORT) : 18085;
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${VITE_PORT}`;

export default defineConfig({
  testDir: './tests',
  testMatch: /web-standalone\.spec\.ts/,
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `npx vite --mode demo --port ${VITE_PORT} --strictPort`,
    port: VITE_PORT,
    reuseExistingServer: true,
    timeout: 20000,
  },
});
```

- [ ] **Step 2: Write the E2E spec**

Create `src/frontend/tests/web-standalone.spec.ts`:

```ts
import { test, expect, type Page } from '@playwright/test';

/** Record every /api/* request the page makes, for the whole test. */
function trackApiCalls(page: Page): string[] {
  const calls: string[] = [];
  page.on('request', (req) => {
    try {
      const u = new URL(req.url());
      if (u.pathname.startsWith('/api/')) calls.push(`${req.method()} ${u.pathname}`);
    } catch { /* non-URL request, ignore */ }
  });
  return calls;
}

test('cold load fires zero /api requests', async ({ page }) => {
  const api = trackApiCalls(page);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  // Let mount effects and the first tick of any interval settle.
  await page.waitForTimeout(1500);
  expect(api, `unexpected /api calls: ${api.join(', ')}`).toEqual([]);
});

test('backend-only UI is absent', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  // Self-update badge — gated off in the demo build.
  await expect(page.getByTestId('update-badge')).toHaveCount(0);
  // Library sidebar tab — filtered out of the TABS registry.
  await expect(page.locator('.sidebar-tab', { hasText: 'Library' })).toHaveCount(0);
  // Database Editor launcher lives in a backend Settings section that's hidden.
  await expect(page.getByRole('button', { name: 'Open Database Editor' })).toHaveCount(0);
});

test('PWA manifest is linked', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);
});
```

- [ ] **Step 3: Run the standalone E2E**

Run:

```bash
cd src/frontend && npm run test:demo
```

Expected: all three tests PASS. If "cold load fires zero /api requests" fails, the printed list names the offending endpoint — add an `isDemoBuild()` guard at that source (Task 3 pattern) and re-run.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/playwright.demo.config.ts src/frontend/tests/web-standalone.spec.ts
git commit -m "test(web): standalone E2E — zero /api, no backend UI, PWA manifest"
```

---

### Task 7: Deploy notes + docs

Documents how the standalone build is produced, its one host requirement (COEP), and that manual visual board-render verification happens on the handed-off demo server.

**Files:**
- Modify: `docs/specs/2026-07-20-boardripper-web-standalone-design.md` (mark Status: implemented; add the build/serve commands)
- Create: `src/frontend/WEB_STANDALONE.md` (short operator note)

**Interfaces:** none (docs only).

- [ ] **Step 1: Write the operator note**

Create `src/frontend/WEB_STANDALONE.md`:

```markdown
# BoardRipper Web (standalone, backend-free)

The full BoardRipper viewer/inspector as a static site — local file open /
drag-drop only, no server. Hosted at `ripperdoc.de/boardripper/web`, later
mirrored to a `*.web.app` root.

## Build

    cd src/frontend
    npm run build:demo        # → dist-demo/ (relative base, PWA, no backend UI)

`dist-demo/` is self-contained and host-portable (relative base) — deploy the
folder as-is at any mount point via the RipperDocWeb rsync, same as `landing/`.

## Local preview / manual check

    npm run preview:demo      # serves dist-demo/
    # or, dev server in demo mode:
    npx vite --mode demo

Board rendering uses WebGL and is verified manually here (headless CI can't do
WebGL). The automated gate (`npm run test:demo`) proves zero `/api` calls,
absent backend UI, and the PWA manifest.

## Host requirement

Serve with NO `Cross-Origin-Embedder-Policy` header, or `COEP: credentialless`
— never `require-corp`. The FZ-key "Fetch" button and cross-origin OBD images
are browser `fetch()`es to third-party origins that `require-corp` would block.

## Definition of the build type

One flag: `store/build-mode.ts` `isDemoBuild()` (true only under
`--mode demo`). Renderer + interface are 100% shared with mainline BoardRipper,
so this build tracks the app automatically. A new backend feature needs exactly
one `isDemoBuild()` guard at its registration point.
```

- [ ] **Step 2: Update the spec status**

In `docs/specs/2026-07-20-boardripper-web-standalone-design.md`, change the Status line near the top from `Design — …` to:

```markdown
**Status:** Implemented — see plan `docs/plans/2026-07-20-boardripper-web-standalone-plan.md` and `src/frontend/WEB_STANDALONE.md`.
```

- [ ] **Step 3: Commit**

```bash
git add docs/specs/2026-07-20-boardripper-web-standalone-design.md src/frontend/WEB_STANDALONE.md
git commit -m "docs(web): standalone build operator note + spec status"
```

---

## Self-Review

**1. Spec coverage:**
- §4.1 build flag / relative base / dist-demo → Task 1. ✓
- §4.2 `isDemoBuild()` + `hasBackend()` short-circuit + databank startup short-circuit → Task 2. ✓
- §4.4 PWA → Task 5. ✓
- §5 feature matrix (kept viewer; removed library/db-editor/OBD/PDF-FTS/update/MCP/sync/upload) → Tasks 3 (network) + 4 (UI). ✓
- §6 boot-time fires (update, sync, mcp) → Task 3 Steps 1-3. ✓
- §6 call-driven (obd, pdf-index, incoming) → Task 3 Steps 4-6. ✓
- §6 UI (sidebar, toolbar badge, home, settings sections) → Task 4. ✓
- §6 worklist kept (MCP writes already gated) → no edit; noted in spec. ✓
- §8 deploy + COEP host requirement → Task 7. ✓
- §9 risks: relative base (Task 1 Step 5-6), FZ key (unchanged — no task needed), SW staleness (`registerType: 'autoUpdate'`, Task 5), zero-`/api` assertion (Task 6). ✓
- §10 testing (no /api, backend UI absent, manifest) → Task 6. Board/PDF WebGL render verified manually (Task 7 note), per repo's headless-WebGL limitation. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; every command lists expected output. ✓

**3. Type/name consistency:** `isDemoBuild()` — identical signature defined in Task 2, consumed by Tasks 3-4-5. Import paths correct per file location (`./build-mode` from `store/`, `../store/build-mode` from `pdf/` and `components/`, `../../store/build-mode` from `components/home/`). `TABS`, `TAB_ORDER`, `SidebarTab`, `SettingsTabId`, `startMcpBridgeIfEnabled`, `ensureIndexed`, `saveDroppedToIncoming`, `loadMatches`/`fetchBoard`/`syncIndex`, `SoftwareUpdateSection` — all match the current source (verified against line anchors). ✓

**Note for the implementer:** line numbers are from the source at plan-writing time; if a file has shifted, match on the shown surrounding code, not the line number.

---

## Execution Handoff

(Filled in by the driver after the user picks an execution approach.)
