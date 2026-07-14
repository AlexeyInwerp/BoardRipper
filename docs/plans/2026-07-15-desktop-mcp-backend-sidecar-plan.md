# Desktop MCP Backend Sidecar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let desktop (Electron) users opt into the same MCP server + full Go backend (databank,
board DB, OBD, PDF index, live-board bridge) the Docker/NAS deployment ships, without changing
the default footprint for users who never enable it.

**Architecture:** A new Electron-native `mcpEnabled` setting gates spawning the existing Go
backend (`src/backend`, cross-compiled per-platform, **zero source changes**) as a loopback
child process. Off (default) → today's app exactly: `loadFile()`, IPC-only library scan/read,
no backend. On → Electron resolves a stable loopback port, spawns the backend, waits for
`/api/health`, seeds the backend's `mcp_enabled` config flag, and reloads the window from
`http://127.0.0.1:<port>/`. After that reload the renderer is indistinguishable from the
web/NAS build: `/api/…` fetches, the MCP bridge WebSocket, databank, PDF index — all work
unmodified. On desktop, backend-running ⟺ MCP-enabled (per the product decision: the backend
only runs when MCP is on), so there is exactly one user-facing switch.

**Tech Stack:** Electron 35 (`desktop/`, CommonJS `main.js`/`preload.js`), Go 1.25 backend
(`src/backend`, `CGO_ENABLED=0`, cross-compiled + `lipo`'d to a universal mac binary), React 19
frontend (`src/frontend`), Node's built-in `node:test` runner for the new pure-Node module.

## Global Constraints

Copied verbatim from the design spec (`docs/specs/2026-07-15-desktop-mcp-backend-sidecar-design.md`)
and verified against current code. Every task's requirements implicitly include this section.

- **`src/backend` is never modified or forked.** Desktop compiles the exact same source tree
  Docker does. The MCP tool/prompt surface (`src/backend/mcpserver/*`) has one definition; any
  future tool goes there, so desktop and NAS always expose identical `tools/list`.
- **`mcpEnabled` defaults to `false`.** A user who never opts in gets byte-identical behavior to
  today's app: no child process spawned, no new SQLite files under `userData`, no network.
- **On desktop, backend-running ⟺ MCP-enabled.** There is one master switch. Whenever the
  sidecar runs, its `mcp_enabled` config flag is seeded `true` so `/api/mcp` serves and the
  live-board bridge connects. (Web/NAS keep their separate in-app `mcp_enabled` toggle — that
  path is unchanged.)
- **The bundled backend binary carries no update ldflags** (`PubKey`/`SourceList` stay empty).
  `src/backend/updater/updater.go:154-167` returns a graceful "updater not configured" error,
  never a crash, if `/api/update/*` is hit. The Toolbar `UpdateBadge` and the drop-to-update
  handler must be hidden on Electron builds regardless of MCP state.
- **`main.go` cannot report its bound port** — it calls `srv.ListenAndServe()` directly
  (`src/backend/main.go:542`) with no port discovery. Electron picks the port and passes it via
  the `PORT` env var. Never pass `PORT=0`.
- **`/api/health`** (`src/backend/handlers/health.go`): `ready` is `func() bool { return true }`
  (`main.go:199`) and the listener binds *after* all init including `databank.Open`
  (`main.go:112` → listener at `542`). So health is effectively binary: connection-refused
  until init completes, then `200` immediately. Poll it; a 60s budget covers a large databank's
  open/migration (matches the Docker boot invariant).
- **`PUT /api/config`** (`src/backend/handlers/databank.go:598`) body is
  `{"key": "...", "value": "..."}`. `mcp_enabled` and `library_dir` are both in
  `allowedConfigKeys`. Truthy value strings are `"1"` or `"true"`
  (`src/backend/mcpserver/state.go:23`); the frontend convention (`SettingsPanel.tsx:553`) uses
  `"true"`.
- **CSRF** (`src/backend/middleware_security.go:53-86`): same-origin browser requests pass;
  requests with no `Origin`/`Referer` (Node `fetch` from the main process) pass as programmatic
  clients. No backend change needed.
- **Env vars the backend reads** (`main.go`): `PORT`, `DATA_DIR`, `LIBRARY_DIR`, `STATIC_DIR`,
  `BOARDDB_PATH`. The bundled `boards.db` must be pointed at via `BOARDDB_PATH` (desktop has no
  `/boards.db` Docker fallback).

### Key design decision: `electronMode` vs `hasBackend()` (read before Tasks 4-6)

`electronMode` is a reactive store flag consumed in **6+ UI sites**. Two of them —
`DatabaseInfoSection` (`SettingsPanel.tsx:702`) and `AutoScanToggle` (`SettingsPanel.tsx:650`)
— do `if (electronMode || !backendAvailable) return null`. So `electronMode` must stay **false**
when the backend sidecar is running, or the databank/PDF-index/dedup/auto-scan UI we are trying
to unlock would be hidden.

Therefore:

- `electronMode` keeps its meaning: **"Electron IPC mode, no backend."** It is set `true` only
  by `initElectron()`, which is only reached when `isElectron() && !hasBackend()`. When the
  backend runs, `electronMode` stays `false` and every backend-gated UI renders normally.
- `hasBackend()` (new, Task 4) = `!isElectron() || location.protocol !== 'file:'`. True for
  web/NAS always; true for Electron only once the sidecar has loaded the page over `http:`.
  Every existing `isElectron()` fork that means "talk to the backend vs use IPC" switches to
  key on `hasBackend()`.
- A handful of **native affordances** that should apply to *all* Electron builds regardless of
  backend (native "Open" label, hide WebDAV sync, hide the Docker text-path field, native
  folder-picker button, native reveal-in-Finder) switch from `electronMode` to `isElectron()`
  (Task 5 / Task 6). These read `isElectron()` directly — it's a pure, session-stable function.

---

### Task 1: Cross-compile the backend + bundle it (universal mac binary) into desktop builds

**Files:**
- Modify: `desktop/build-all.mjs`
- Modify: `desktop/build-mac.mjs`
- Modify: `.gitignore`

**Interfaces:**
- Produces (consumed by Task 2's `resolveBinaryPath()`/`resolveBoardDbPath()`):
  `desktop/bin/darwin/server` (a `lipo`-merged arm64+x64 universal Mach-O),
  `desktop/bin/win32/server.exe`, and `desktop/bin/boards.db`. A `lipo`'d universal binary is
  used (not two per-arch files) because `@electron/universal`'s `makeUniversalApp` merges the
  arm64 and x64 intermediate app bundles and chokes on differing single-arch Mach-O resources;
  one identical universal binary in both passes sidesteps that entirely, and `resolveBinaryPath`
  needs no per-arch branch on macOS.

- [ ] **Step 1: Add the cross-compile + lipo + bundle step to `build-all.mjs`**

Insert immediately after the existing `cpSync(path.join(FRONTEND, 'dist'), WEBAPP_DIR, ...)`
line (the "Copying dist → desktop/webapp/" block), before `const packager = ...`:

```js
// ═══════════════════════════════════════════════════════════════
// Step 1.5: Cross-compile the Go backend sidecar (CGO_ENABLED=0, no
// update ldflags — the Docker self-update pipeline doesn't apply here).
// macOS ships a single lipo'd universal binary so @electron/universal's
// makeUniversalApp sees one identical resource in both arch passes.
// ═══════════════════════════════════════════════════════════════
const BACKEND = path.join(ROOT, 'src', 'backend');
const BIN_DIR = path.join(DESKTOP, 'bin');
if (existsSync(BIN_DIR)) rmSync(BIN_DIR, { recursive: true });
mkdirSync(BIN_DIR, { recursive: true });

function goBuild(goos, goarch, outFile) {
  mkdirSync(path.dirname(outFile), { recursive: true });
  console.log(`\n=== Cross-compiling backend ${goos}/${goarch} ===`);
  execSync(
    `go build -ldflags="-s -w -X boardripper/updater.Version=${APP_VERSION}" -o "${outFile}" .`,
    {
      cwd: BACKEND,
      stdio: 'inherit',
      env: { ...process.env, CGO_ENABLED: '0', GOOS: goos, GOARCH: goarch },
    },
  );
}

if (buildMac || buildLegacy) {
  const armTmp = path.join(BIN_DIR, '.darwin-arm64');
  const x64Tmp = path.join(BIN_DIR, '.darwin-x64');
  goBuild('darwin', 'arm64', armTmp);
  goBuild('darwin', 'amd64', x64Tmp);
  const fat = path.join(BIN_DIR, 'darwin', 'server');
  mkdirSync(path.dirname(fat), { recursive: true });
  console.log('\n=== lipo → universal darwin/server ===');
  execSync(`lipo -create "${armTmp}" "${x64Tmp}" -output "${fat}"`, { stdio: 'inherit' });
  rmSync(armTmp);
  rmSync(x64Tmp);
}
if (buildWin) {
  goBuild('windows', 'amd64', path.join(BIN_DIR, 'win32', 'server.exe'));
}

console.log('\n=== Copying Board Database → desktop/bin/boards.db ===');
cpSync(path.join(ROOT, 'Board Database', 'boards.db'), path.join(BIN_DIR, 'boards.db'));
```

- [ ] **Step 2: Exclude the non-target platform binary from each packaging pass**

Each packaged app ships only the binaries it needs. `desktop/bin/darwin/server` (fat) works on
both the universal build and the legacy x64 build (macOS runs the x64 slice), so both mac passes
ship `bin/darwin` and ignore `bin/win32`; Windows ships `bin/win32` and ignores `bin/darwin`.
`bin/boards.db` ships everywhere.

In the macOS universal block (`if (buildMac) { ... }`), change `commonOpts.ignore`:

```js
    ignore: IGNORE_PATTERNS,
```
→
```js
    ignore: [...IGNORE_PATTERNS, /^\/bin\/win32($|\/)/],
```

In the macOS Legacy block (`if (buildLegacy) { ... }`), change the packager call's `ignore`:

```js
    ignore: IGNORE_PATTERNS,
```
→
```js
    ignore: [...IGNORE_PATTERNS, /^\/bin\/win32($|\/)/],
```

In the Windows block (`if (buildWin) { ... }`), change the packager call's `ignore`:

```js
    ignore: IGNORE_PATTERNS,
```
→
```js
    ignore: [...IGNORE_PATTERNS, /^\/bin\/darwin($|\/)/],
```

- [ ] **Step 3: Mirror the cross-compile into `build-mac.mjs` (backs `npm run build`)**

First, move the arch-parsing block up. Cut these two lines (currently just before
`const packager = ...`):

```js
const archArg = process.argv.find(a => a.startsWith('--arch='));
const requestedArch = archArg ? archArg.split('=')[1] : process.arch === 'arm64' ? 'arm64' : 'x64';
```

and paste them immediately after the `WEBAPP_DIR`/`OUT_DIR` const declarations near the top of
the file (so `requestedArch` is defined before the new step below uses it).

Then insert after the `cpSync(path.join(FRONTEND, 'dist'), WEBAPP_DIR, ...)` step, before the
"Clean previous output" / `const packager = ...` block:

```js
// ---------- 2.5. Cross-compile the Go backend sidecar ----------
const BACKEND = path.join(ROOT, 'src', 'backend');
const BIN_DIR = path.join(DESKTOP, 'bin');
const APP_VERSION = JSON.parse(readFileSync(path.join(FRONTEND, 'package.json'), 'utf8')).version;
if (existsSync(BIN_DIR)) rmSync(BIN_DIR, { recursive: true });
mkdirSync(BIN_DIR, { recursive: true });

function goBuild(goarch, outFile) {
  mkdirSync(path.dirname(outFile), { recursive: true });
  console.log(`\n=== Cross-compiling backend darwin/${goarch} ===`);
  execSync(
    `go build -ldflags="-s -w -X boardripper/updater.Version=${APP_VERSION}" -o "${outFile}" .`,
    {
      cwd: BACKEND,
      stdio: 'inherit',
      env: { ...process.env, CGO_ENABLED: '0', GOOS: 'darwin', GOARCH: goarch },
    },
  );
}

const fat = path.join(BIN_DIR, 'darwin', 'server');
mkdirSync(path.dirname(fat), { recursive: true });
if (requestedArch === 'universal') {
  const armTmp = path.join(BIN_DIR, '.darwin-arm64');
  const x64Tmp = path.join(BIN_DIR, '.darwin-x64');
  goBuild('arm64', armTmp);
  goBuild('x64', x64Tmp);
  execSync(`lipo -create "${armTmp}" "${x64Tmp}" -output "${fat}"`, { stdio: 'inherit' });
  rmSync(armTmp);
  rmSync(x64Tmp);
} else {
  goBuild(requestedArch, fat);
}
cpSync(path.join(ROOT, 'Board Database', 'boards.db'), path.join(BIN_DIR, 'boards.db'));
```

(`build-mac.mjs` already imports `readFileSync`, `existsSync`, `rmSync`, `mkdirSync`, `cpSync`,
`execSync`, `path` — no new imports needed.)

- [ ] **Step 4: Ignore the build artifact**

Add to `.gitignore` next to the existing `desktop/webapp/` line:

```
desktop/bin/
```

- [ ] **Step 5: Verify the cross-compiled binary builds and serves health**

```bash
cd /Users/besitzer/Desktop/Boardviewer/src/backend && \
  CGO_ENABLED=0 GOOS=darwin GOARCH=$([ "$(uname -m)" = "arm64" ] && echo arm64 || echo amd64) \
  go build -ldflags="-s -w" -o /tmp/br-server-test . && echo "BUILD OK"
DATA=$(mktemp -d); PORT=18099 DATA_DIR="$DATA" STATIC_DIR=/tmp /tmp/br-server-test &
SRV=$!; sleep 2; echo "--- health ---"; curl -sf http://127.0.0.1:18099/api/health; echo
kill $SRV; rm -rf "$DATA" /tmp/br-server-test
```

Expected: `BUILD OK`, then `{"status":"ok"}`.

Also verify the Windows cross-compile links (no run):

```bash
cd /Users/besitzer/Desktop/Boardviewer/src/backend && \
  CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -o /tmp/br-server.exe . && \
  echo "WINDOWS BUILD OK" && rm /tmp/br-server.exe
```

Expected: `WINDOWS BUILD OK`. (Windows *runtime* can't be verified from macOS — flagged for a
manual check on a Windows box before a Windows release.)

- [ ] **Step 6: Commit**

```bash
git add desktop/build-all.mjs desktop/build-mac.mjs .gitignore
git commit -m "build(desktop): cross-compile + bundle backend sidecar (universal mac binary)"
```

---

### Task 2: `desktop/backend-sidecar.js` — sidecar process manager module

**Files:**
- Create: `desktop/backend-sidecar.js`
- Create: `desktop/backend-sidecar.test.js`
- Modify: `desktop/package.json`

**Interfaces:**
- Produces (consumed by Task 3's `main.js`):
  - `pickFreePort(): Promise<number>`
  - `isPortFree(port: number): Promise<boolean>`
  - `resolveBinaryPath(): string`
  - `resolveBoardDbPath(): string`
  - `startBackend({ dataDir, libraryDir, staticDir, boardDbPath, port }): ChildProcess`
  - `waitForHealth(port: number, timeoutMs?: number): Promise<boolean>`
  - `enableMcpConfig(port: number): Promise<void>`
  - `stopBackend(proc: ChildProcess | null): void`

- [ ] **Step 1: Write the failing tests**

Create `desktop/backend-sidecar.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { spawn } = require('node:child_process');
const {
  pickFreePort,
  isPortFree,
  waitForHealth,
  stopBackend,
} = require('./backend-sidecar');

test('pickFreePort returns a usable port in range', async () => {
  const p = await pickFreePort();
  assert.ok(Number.isInteger(p) && p > 0 && p < 65536);
});

test('isPortFree is true for an unused port, false for a bound one', async () => {
  const p = await pickFreePort();
  assert.strictEqual(await isPortFree(p), true);
  const srv = net.createServer();
  await new Promise(res => srv.listen(p, '127.0.0.1', res));
  try {
    assert.strictEqual(await isPortFree(p), false);
  } finally {
    srv.close();
  }
});

test('waitForHealth resolves true once a /api/health server comes up', async () => {
  const port = await pickFreePort();
  // Fake backend that starts serving 200 after a short delay (simulates real
  // startup latency without depending on the Go binary).
  const proc = spawn(process.execPath, ['-e', `
    const http = require('http');
    setTimeout(() => {
      http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"status":"ok"}');
      }).listen(${port}, '127.0.0.1');
    }, 300);
  `]);
  try {
    assert.strictEqual(await waitForHealth(port, 5000), true);
  } finally {
    stopBackend(proc);
  }
});

test('waitForHealth resolves false when nothing ever listens', async () => {
  const port = await pickFreePort();
  assert.strictEqual(await waitForHealth(port, 500), false);
});

test('stopBackend kills the process', async () => {
  const proc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  const exited = new Promise(resolve => proc.on('exit', resolve));
  stopBackend(proc);
  await exited;
  assert.ok(proc.killed);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/besitzer/Desktop/Boardviewer/desktop && node --test backend-sidecar.test.js
```

Expected: FAIL — `Cannot find module './backend-sidecar'`.

- [ ] **Step 3: Write `desktop/backend-sidecar.js`**

```js
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

/** Ask the OS for a free loopback port. main.go binds via srv.ListenAndServe()
 *  with no way to report back which port it chose, so the caller decides the
 *  port up front and passes it via PORT — see docs/specs/
 *  2026-07-15-desktop-mcp-backend-sidecar-design.md §4. */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** True if `port` can currently be bound on loopback. Used to decide whether a
 *  previously-persisted preferred port is still usable this launch. Inherently
 *  racy (something could grab it before the backend binds) — the caller treats
 *  a subsequent bind failure as a normal spawn failure. */
function isPortFree(port) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/** Path to the bundled server binary. macOS ships a single lipo'd universal
 *  binary (see build-all.mjs), so there is no per-arch branch. */
function resolveBinaryPath() {
  if (process.platform === 'win32') {
    return path.join(__dirname, 'bin', 'win32', 'server.exe');
  }
  return path.join(__dirname, 'bin', 'darwin', 'server');
}

function resolveBoardDbPath() {
  return path.join(__dirname, 'bin', 'boards.db');
}

/** Spawn the backend. Caller owns the returned process (attach stdout/stderr/
 *  exit listeners; call stopBackend to tear it down). */
function startBackend({ dataDir, libraryDir, staticDir, boardDbPath, port }) {
  const env = {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDir,
    LIBRARY_DIR: libraryDir || '',
    STATIC_DIR: staticDir,
    BOARDDB_PATH: boardDbPath,
  };
  return spawn(resolveBinaryPath(), [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Poll GET /api/health until it returns 200, or timeoutMs elapses. The
 *  backend binds its listener only after full init (databank.Open, board
 *  index), so early polls fail with connection-refused; both that and a 503
 *  "starting" body are retried. 60s default matches the Docker boot invariant. */
async function waitForHealth(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

/** Seed the backend's mcp_enabled config flag so /api/mcp serves and the
 *  live-board bridge auto-connects on the next page load. On desktop,
 *  backend-running ⟺ MCP-enabled, so this is called on every successful
 *  start. Best-effort: a failure just means the user's first MCP call 404s
 *  until they retoggle. */
async function enableMcpConfig(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'mcp_enabled', value: 'true' }),
    });
  } catch { /* best-effort, see doc comment */ }
}

function stopBackend(proc) {
  if (!proc || proc.killed) return;
  proc.kill();
}

module.exports = {
  pickFreePort,
  isPortFree,
  resolveBinaryPath,
  resolveBoardDbPath,
  startBackend,
  waitForHealth,
  enableMcpConfig,
  stopBackend,
};
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/besitzer/Desktop/Boardviewer/desktop && node --test backend-sidecar.test.js
```

Expected: all 5 tests PASS.

- [ ] **Step 5: Add a `test` script to `desktop/package.json`**

In `"scripts"`, add:

```json
    "test": "node --test"
```

- [ ] **Step 6: Commit**

```bash
git add desktop/backend-sidecar.js desktop/backend-sidecar.test.js desktop/package.json
git commit -m "feat(desktop): add backend sidecar process manager module"
```

---

### Task 3: `main.js` + `preload.js` — the `mcpEnabled` lifecycle end-to-end

**Files:**
- Modify: `desktop/main.js`
- Modify: `desktop/preload.js`
- Modify: `src/frontend/src/electron.d.ts`

**Interfaces:**
- Consumes: Task 2's `backend-sidecar.js` exports.
- Produces: `window.electronAPI.getMcpEnabled(): Promise<boolean>` and
  `window.electronAPI.setMcpEnabled(on: boolean): Promise<boolean>` (returns whether MCP is
  enabled after the call — `false` if a requested enable failed to become healthy). Consumed by
  Task 6's `ElectronMcpToggle`.

- [ ] **Step 1: Require the sidecar module + declare lifecycle state**

After the existing `const fs = require('fs');` line near the top of `main.js`:

```js
const {
  pickFreePort,
  isPortFree,
  resolveBoardDbPath,
  startBackend,
  waitForHealth,
  enableMcpConfig,
  stopBackend,
} = require('./backend-sidecar');

// The running backend sidecar, or null. { proc, port }.
let currentBackend = null;
// True while we deliberately kill the backend (user disabled MCP, or a
// crash-retry is about to replace it) so the 'exit' listener can tell an
// intentional stop from a crash. Reset at the top of startBackendAndLoad().
let stoppingDeliberately = false;
// Consecutive mid-session crash retries (see handleUnexpectedExit).
let crashRetries = 0;
```

- [ ] **Step 2: Replace the direct `loadFile` in `createWindow()` with `boot()`**

Find, near the end of `createWindow()`:

```js
  const indexPath = path.join(WEBAPP_DIR, 'index.html');
  log('INFO', `Loading: ${indexPath}`);
  log('INFO', `index.html exists: ${fs.existsSync(indexPath)}`);
  mainWindow.loadFile(indexPath).then(() => {
    log('INFO', 'index.html loaded successfully');
  }).catch((err) => {
    logFatal('Failed to load index.html', err);
  });
```

Replace with:

```js
  boot();
```

- [ ] **Step 3: Add the lifecycle helpers**

Insert immediately after `createWindow()`'s closing brace, before `async function
openFileDialog()`:

```js
function loadStaticFile() {
  const indexPath = path.join(WEBAPP_DIR, 'index.html');
  log('INFO', `Loading: ${indexPath}`);
  return mainWindow.loadFile(indexPath).then(() => {
    log('INFO', 'index.html loaded successfully');
  }).catch((err) => {
    logFatal('Failed to load index.html', err);
  });
}

/** Resolve the loopback port for the sidecar. Prefer the persisted port so an
 *  external MCP client's saved connect URL survives restarts; fall back to a
 *  fresh free port (and persist it) if the preferred one is taken. */
async function resolvePort() {
  const settings = loadSettings();
  if (settings.mcpPort && await isPortFree(settings.mcpPort)) {
    return settings.mcpPort;
  }
  const port = await pickFreePort();
  const s = loadSettings();
  s.mcpPort = port;
  saveSettings(s);
  return port;
}

/** Spawn the backend, wait for health, seed mcp_enabled, then load the window
 *  from it. On startup failure: kill, revert mcpEnabled to false so the next
 *  launch doesn't retry a broken setup, and fall back to loadStaticFile().
 *  Returns true on success. A later unexpected exit (genuine crash) is handled
 *  by the 'exit' listener → handleUnexpectedExit(), not this function. */
async function startBackendAndLoad() {
  stoppingDeliberately = false;
  const settings = loadSettings();
  const port = await resolvePort();
  log('INFO', `Starting backend sidecar on port ${port}...`);
  const proc = startBackend({
    dataDir: app.getPath('userData'),
    libraryDir: settings.libraryPath || '',
    staticDir: WEBAPP_DIR,
    boardDbPath: resolveBoardDbPath(),
    port,
  });
  proc.stdout.on('data', d => log('INFO', `[backend] ${d.toString().trim()}`));
  proc.stderr.on('data', d => log('ERROR', `[backend] ${d.toString().trim()}`));
  let exitedDuringStartup = false;
  proc.on('exit', (code, signal) => {
    log('ERROR', `Backend sidecar exited: code=${code} signal=${signal}`);
    const wasCurrent = currentBackend && currentBackend.proc === proc;
    if (wasCurrent) currentBackend = null;
    if (!wasCurrent) { exitedDuringStartup = true; return; } // handled below
    if (stoppingDeliberately) return; // user-initiated, not a crash
    void handleUnexpectedExit();
  });

  const healthy = await waitForHealth(port);
  if (!healthy || exitedDuringStartup) {
    log('ERROR', 'Backend sidecar failed to become healthy — disabling MCP');
    stopBackend(proc);
    const s = loadSettings();
    s.mcpEnabled = false;
    saveSettings(s);
    dialog.showErrorBox(
      'BoardRipper — MCP server failed to start',
      `The local server did not become healthy in time. MCP has been disabled.\n\nLog: ${LOG_FILE}`,
    );
    return false;
  }

  await enableMcpConfig(port);
  currentBackend = { proc, port };
  crashRetries = 0;
  log('INFO', `Backend sidecar healthy, loading http://127.0.0.1:${port}/`);
  await mainWindow.loadURL(`http://127.0.0.1:${port}/`);
  return true;
}

/** A previously-healthy backend died mid-session. Retry with backoff (1s, 3s,
 *  9s); if exhausted, disable MCP and fall back to the static file so the app
 *  stays usable. */
async function handleUnexpectedExit() {
  if (crashRetries >= 3) {
    logFatal('Backend sidecar crashed repeatedly', new Error('Exceeded restart retries'));
    const s = loadSettings();
    s.mcpEnabled = false;
    saveSettings(s);
    await loadStaticFile();
    return;
  }
  crashRetries += 1;
  const delayMs = 1000 * 3 ** (crashRetries - 1); // 1s, 3s, 9s
  log('INFO', `Backend sidecar crashed — retrying in ${delayMs}ms (attempt ${crashRetries}/3)`);
  await new Promise(r => setTimeout(r, delayMs));
  await startBackendAndLoad();
}

function stopCurrentBackend() {
  if (currentBackend) {
    stoppingDeliberately = true;
    stopBackend(currentBackend.proc);
    currentBackend = null;
  }
}

/** Startup entry point: honours the persisted mcpEnabled setting. */
async function boot() {
  const settings = loadSettings();
  if (settings.mcpEnabled) {
    const ok = await startBackendAndLoad();
    if (ok) return;
  }
  await loadStaticFile();
}
```

- [ ] **Step 4: Point the GPU-retry reload at the right origin**

Find, in the `render-process-gone` handler:

```js
      app.commandLine.appendSwitch('disable-gpu');
      mainWindow.loadFile(path.join(WEBAPP_DIR, 'index.html'));
```

Replace the `loadFile` line with:

```js
      if (currentBackend) {
        mainWindow.loadURL(`http://127.0.0.1:${currentBackend.port}/`);
      } else {
        mainWindow.loadFile(path.join(WEBAPP_DIR, 'index.html'));
      }
```

- [ ] **Step 5: Add the `get-mcp-enabled` / `set-mcp-enabled` IPC handlers**

After the existing `ipcMain.handle('platform', ...)` handler:

```js
ipcMain.handle('get-mcp-enabled', () => !!loadSettings().mcpEnabled);

ipcMain.handle('set-mcp-enabled', async (_event, on) => {
  const settings = loadSettings();
  settings.mcpEnabled = !!on;
  saveSettings(settings);
  if (on) {
    return await startBackendAndLoad(); // true on success, false if unhealthy
  }
  stopCurrentBackend();
  await loadStaticFile();
  return false;
});
```

- [ ] **Step 6: Kill the sidecar on quit**

Before `app.on('activate', ...)`:

```js
app.on('before-quit', () => {
  stopCurrentBackend();
});
```

- [ ] **Step 7: Expose the two calls from `preload.js`**

In the `contextBridge.exposeInMainWorld('electronAPI', { ... })` object, after the `platform`
entry:

```js
  // MCP server sidecar toggle — persisted in Electron settings.json; gates
  // whether the Go backend child process is spawned at all. setMcpEnabled
  // resolves to whether MCP is enabled after the call (false if an enable
  // failed to become healthy).
  getMcpEnabled: () => ipcRenderer.invoke('get-mcp-enabled'),
  setMcpEnabled: (on) => ipcRenderer.invoke('set-mcp-enabled', on),
```

- [ ] **Step 8: Add the TypeScript declarations**

In `src/frontend/src/electron.d.ts`, in the `ElectronAPI` interface after `platform`:

```ts
  // MCP server sidecar toggle (see desktop/main.js)
  getMcpEnabled: () => Promise<boolean>;
  setMcpEnabled: (on: boolean) => Promise<boolean>;
```

- [ ] **Step 9: Manual verification**

Requires Task 1 to have produced a host-platform binary (`cd desktop && node build-mac.mjs`).

```bash
cd /Users/besitzer/Desktop/Boardviewer/desktop && npm start
```

Log file: `~/Library/Application Support/BoardRipper/logs/boardripper.log`.

- Fresh `settings.json` (or `mcpEnabled` absent): log shows `index.html loaded successfully`,
  **no** `[backend]` lines. Today's behavior, unchanged. Quit.
- Set `"mcpEnabled": true` in `~/Library/Application Support/BoardRipper/settings.json`,
  relaunch. Log shows `Starting backend sidecar on port <N>` → `Backend sidecar healthy,
  loading http://127.0.0.1:<N>/`; the window renders the normal UI (now backend-served).
  Confirm `settings.json` now has a stable `"mcpPort": <N>`.
- Quit (Cmd+Q); confirm `ps aux | grep bin/darwin/server` shows the process gone within ~1s.
- Relaunch; confirm the SAME `mcpPort` is reused (log shows the same port).
- **Crash-restart:** with the app running backend-served, `kill -9` the `server` pid. Log shows
  `Backend sidecar exited: ... signal=SIGKILL` → `retrying in 1000ms (attempt 1/3)` → a fresh
  `Backend sidecar healthy` and the window reloads (open tabs lost — expected, spec §9).

- [ ] **Step 10: Commit**

```bash
git add desktop/main.js desktop/preload.js src/frontend/src/electron.d.ts
git commit -m "feat(desktop): spawn backend sidecar when mcpEnabled, wire IPC toggle"
```

---

### Task 4: `hasBackend()` + `databank-store.ts` fork audit

**Files:**
- Modify: `src/frontend/src/store/databank-store.ts`

**Interfaces:**
- Produces: `export function hasBackend(): boolean` (consumed by Tasks 5-7).

Every `isElectron()` site below exists to choose "talk to the backend over HTTP" vs "use the
Electron IPC fallback." They switch to `hasBackend()`. The IPC paths are **not** deleted — they
remain the only path when `mcpEnabled` is off. Crucially, this task must **not** set
`electronMode = true` in the backend-running path (see the Global Constraints design note):
`electronMode` must stay false so backend-gated UI renders. Every site was read in full; there
are no other `isElectron()` uses in this file.

- [ ] **Step 1: Add `hasBackend()` next to `isElectron()`**

After the existing `isElectron()` definition:

```ts
/** True whenever a real Go backend is reachable at the current origin. Always
 *  true for the web/NAS build. True for Electron only once the mcpEnabled
 *  sidecar has taken over the page load (loadURL to http://127.0.0.1:<port>/
 *  instead of loadFile's file:// origin) — see docs/specs/
 *  2026-07-15-desktop-mcp-backend-sidecar-design.md §4. */
export function hasBackend(): boolean {
  return !isElectron() || (typeof location !== 'undefined' && location.protocol !== 'file:');
}
```

- [ ] **Step 2: `checkScanStatus()` — `if (isElectron()) return;` → `if (!hasBackend()) return;`**

- [ ] **Step 3: `_runStartupLoad()` startup fork**

```ts
      // Electron branch: same as today's initElectron path.
      if (typeof window !== 'undefined' && window.electronAPI?.scanLibrary) {
        await this.initElectron();
        this._loadStatus = 'loaded';
        this.notify();
        return;
      }

      // Browser branch: matches the order in today's LibraryPanel useEffect
      // (which this method is replacing).
      await this.loadConfig();
```
→
```ts
      // Electron with NO backend sidecar: IPC-only path, unchanged. When a
      // sidecar IS running (mcpEnabled), fall through to the backend chain
      // below and leave electronMode false so backend-gated UI renders.
      if (isElectron() && !hasBackend()) {
        await this.initElectron();
        this._loadStatus = 'loaded';
        this.notify();
        return;
      }

      // Browser / backend branch: matches the order in today's LibraryPanel
      // useEffect (which this method is replacing). Also used by Electron once
      // a backend sidecar is running.
      await this.loadConfig();
```

- [ ] **Step 4: `_doFetchFiles()` — `if (isElectron()) {` → `if (!hasBackend()) {`**

(The `libraryLoadStore.begin('Electron scan')` IPC branch.)

- [ ] **Step 5: `_doFetchFilesByIds()` — `if (isElectron() || ids.length === 0) return;` → `if (!hasBackend() || ids.length === 0) return;`**

- [ ] **Step 6: `fetchTree()` — `if (isElectron()) {` → `if (!hasBackend()) {`**

- [ ] **Step 7: `triggerFileScan()` — `if (isElectron()) {` → `if (!hasBackend()) {`**

(The `_electronScan()` branch; the `else` backend-POST branch is unchanged.)

- [ ] **Step 8: `stopScan()` — `if (isElectron()) return;` → `if (!hasBackend()) return;`**

- [ ] **Step 9: `generatePdfPreview()` — replace `isElectron()` in the guard**

```ts
    if (file.file_type !== 'pdf' || file.has_preview || isElectron()) return false;
```
→
```ts
    if (file.file_type !== 'pdf' || file.has_preview || !hasBackend()) return false;
```

- [ ] **Step 10: `fetchFileBuffer()` — flip the phase label + the read fork**

```ts
      loadProgressStore.setPhase('Downloading', isElectron()
        ? 'Reading from local library mount (Electron IPC)'
        : `Backend → browser via /api/files/path (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
    }
    if (isElectron()) {
```
→
```ts
      loadProgressStore.setPhase('Downloading', hasBackend()
        ? `Backend → browser via /api/files/path (${(file.size / 1024 / 1024).toFixed(2)} MB)`
        : 'Reading from local library mount (Electron IPC)');
    }
    if (!hasBackend()) {
```

- [ ] **Step 11: `loadConfig()` — `if (isElectron()) return;` → `if (!hasBackend()) return;`**

- [ ] **Step 12: `setLibraryDir()` — `if (isElectron()) return false;` → `if (!hasBackend()) return false;`**

- [ ] **Step 13: `selectLibraryFolder()` — sync the picked folder to the backend when one runs**

```ts
  async selectLibraryFolder(): Promise<string | null> {
    if (!isElectron()) return null;
    const folderPath = await window.electronAPI!.selectLibraryFolder();
    if (folderPath) {
      this._libraryPath = folderPath;
      this.notify();
      await this._electronScan();
    }
    return folderPath;
  }
```
→
```ts
  async selectLibraryFolder(): Promise<string | null> {
    if (!isElectron()) return null;
    const folderPath = await window.electronAPI!.selectLibraryFolder();
    if (folderPath) {
      this._libraryPath = folderPath;
      this.notify();
      if (hasBackend()) {
        // Backend sidecar running: tell it the new root (mirrors the web/NAS
        // setLibraryDir flow) and let it do the real scan.
        await this.setLibraryDir(folderPath);
        await this.triggerFileScan();
      } else {
        await this._electronScan();
      }
    }
    return folderPath;
  }
```

(`initElectron()` and `_electronScan()` are unchanged — reached only via the
`isElectron() && !hasBackend()` fork. `initElectron` still sets `_electronMode = true` there.)

- [ ] **Step 14: Typecheck**

```bash
cd /Users/besitzer/Desktop/Boardviewer/src/frontend && npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 15: Commit**

```bash
git add src/frontend/src/store/databank-store.ts
git commit -m "feat(desktop): add hasBackend() and switch backend-vs-IPC forks onto it"
```

---

### Task 5: Native affordances — re-gate `electronMode` → `isElectron()` where they must apply to all desktop builds

**Files:**
- Modify: `src/frontend/src/components/Toolbar.tsx`
- Modify: `src/frontend/src/panels/LibrarySyncSection.tsx`
- Modify: `src/frontend/src/panels/LibraryPanel.tsx`

These five UI affordances should behave the "desktop native" way whenever we're in Electron,
**independent of whether the backend runs**. Today `electronMode === isElectron()` on desktop so
they look correct; once the backend can run (electronMode goes false), they'd regress. Switch
them to `isElectron()`. Do **not** touch the other `electronMode` uses in these files (the
backend-fetch skips at `LibraryPanel.tsx:410,419` and the `electronMode` prop thread at
`:1271`) — those correctly stay on `electronMode`.

**Interfaces:**
- Consumes: `isElectron()` from `databank-store.ts` (already exported).

- [ ] **Step 1: Toolbar "Open" vs "Upload" label → `isElectron()`**

In `Toolbar.tsx`, `isElectron` is not yet imported. Change:

```ts
import { databankStore } from '../store/databank-store';
```
→
```ts
import { databankStore, isElectron } from '../store/databank-store';
```

Then in the open-button JSX (the `data-testid="open-btn"` button), the component currently reads
`electronMode` from `useDatabank()`. Replace the three `electronMode` references in that button
with `isElectron()`:

```tsx
          data-tooltip={electronMode ? 'Open boards or PDFs' : 'Upload boards or PDFs from your device'}
          style={electronMode ? undefined : { gap: 6 }}
        >
          {electronMode ? 'Open' : (<><IconUpload size={14} stroke={1.75} />Upload</>)}
```
→
```tsx
          data-tooltip={isElectron() ? 'Open boards or PDFs' : 'Upload boards or PDFs from your device'}
          style={isElectron() ? undefined : { gap: 6 }}
        >
          {isElectron() ? 'Open' : (<><IconUpload size={14} stroke={1.75} />Upload</>)}
```

If `electronMode` is now otherwise unused in that component, remove it from the `useDatabank()`
destructure at `Toolbar.tsx:299` to avoid an unused-var lint error; if it's still used
elsewhere in the component, leave it.

- [ ] **Step 2: LibrarySyncSection — hide on all Electron builds**

In `LibrarySyncSection.tsx`, add the import and re-gate. Change:

```ts
import { useDatabank } from '../hooks/useDatabank';
```
→
```ts
import { useDatabank } from '../hooks/useDatabank';
import { isElectron } from '../store/databank-store';
```

Then:

```ts
  const { backendAvailable, electronMode } = useDatabank();
  const { config, configLoaded } = useLibrarySync();
  if (electronMode) return null;
```
→
```ts
  const { backendAvailable } = useDatabank();
  const { config, configLoaded } = useLibrarySync();
  // WebDAV library sync is a NAS-hosting concern, excluded from desktop
  // regardless of whether the backend sidecar is running (design spec §9).
  if (isElectron()) return null;
```

- [ ] **Step 3: LibraryPanel — native folder-picker button, backend-warn hint, and file reveal**

In `LibraryPanel.tsx`, add `isElectron` to the existing import. Change:

```ts
import { databankStore, contentCollapsePlan } from '../store/databank-store';
```
→
```ts
import { databankStore, contentCollapsePlan, isElectron } from '../store/databank-store';
```

Native folder-picker button (currently `{electronMode && (`):

```tsx
      {/* Electron library folder picker */}
      {electronMode && (
```
→
```tsx
      {/* Electron library folder picker */}
      {isElectron() && (
```

Backend-unreachable warning (should not show on desktop — the "start the server" wording is
Docker-specific):

```tsx
      {/* Backend warning (web mode only) */}
      {!electronMode && !backendAvailable && (
```
→
```tsx
      {/* Backend warning (web mode only) */}
      {!isElectron() && !backendAvailable && (
```

File reveal vs download in `FileDetailPane` (native reveal is nicer for a local file):

```tsx
        {electronMode ? (
          <RevealButton path={detail.path} />
        ) : (
```
→
```tsx
        {isElectron() ? (
          <RevealButton path={detail.path} />
        ) : (
```

(The `FileDetailPane` `electronMode` prop and its type stay — only this one usage flips to
`isElectron()`. Leave the prop threading at `:1271` and the effect guards at `:410,:419`
untouched.)

- [ ] **Step 4: Typecheck**

```bash
cd /Users/besitzer/Desktop/Boardviewer/src/frontend && npx tsc --noEmit
```

Expected: no new errors. (If a now-unused `electronMode` destructure remains in any of the three
files, remove that single identifier to clear the lint/TS unused warning.)

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/components/Toolbar.tsx src/frontend/src/panels/LibrarySyncSection.tsx src/frontend/src/panels/LibraryPanel.tsx
git commit -m "feat(desktop): keep native library affordances on isElectron, not electronMode"
```

---

### Task 6: `SettingsPanel.tsx` — unified desktop MCP toggle + backend-aware gates

**Files:**
- Modify: `src/frontend/src/panels/SettingsPanel.tsx`

**Interfaces:**
- Consumes: Task 3's `window.electronAPI.getMcpEnabled/setMcpEnabled`; Task 4's `hasBackend()`.

On desktop there is one MCP switch: the Electron `mcpEnabled` setting (spawns the backend). The
Integrations tab replaces its own "Enable MCP server" row with an `ElectronMcpToggle` that drives
`setMcpEnabled` (which spawns/kills the backend and reloads the page). The rest of the
Integrations UI (drive-UI toggle, token, connect cards, live status) renders when the backend is
up — driven, as today, by `/api/mcp/status`. The `library_dir` text field and watermark-reindex
prompt become `hasBackend()`-aware.

- [ ] **Step 1: Import `hasBackend`**

```ts
import { isElectron } from '../store/databank-store';
```
→
```ts
import { isElectron, hasBackend } from '../store/databank-store';
```

- [ ] **Step 2: Add the `ElectronMcpToggle` component**

Insert immediately before `function IntegrationsSection() {`:

```tsx
/** Desktop-only master MCP switch. Drives the Electron `mcpEnabled` setting,
 *  which spawns/kills the backend sidecar and reloads the page. On success the
 *  window navigates (loadURL/loadFile) and this component unmounts. On a failed
 *  enable (backend never became healthy) it stays mounted and reflects the
 *  revert. */
function ElectronMcpToggle() {
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    window.electronAPI!.getMcpEnabled().then(v => { setEnabled(v); setLoaded(true); });
  }, []);

  const toggle = async (on: boolean) => {
    setPending(true);
    setEnabled(on);
    const result = await window.electronAPI!.setMcpEnabled(on);
    // Reachable only if the page did NOT navigate (i.e. a failed enable).
    setEnabled(result);
    setPending(false);
  };

  return (
    <div className="settings-row settings-toggle-row">
      <label className="settings-label">Enable MCP server</label>
      <input type="checkbox" checked={enabled} disabled={!loaded || pending}
        onChange={e => toggle(e.target.checked)} />
    </div>
  );
}

```

- [ ] **Step 3: Swap the enable row + gate the body on backend availability**

In `IntegrationsSection()`, the enable row and the body currently read:

```tsx
        <div className="settings-row settings-toggle-row">
          <label className="settings-label">Enable MCP server</label>
          <input type="checkbox" checked={enabled}
            onChange={e => setFlag('mcp_enabled', e.target.checked)} />
        </div>
        <div className="settings-row settings-toggle-row">
```

Replace the first row (the `mcp_enabled` checkbox) with a desktop/web branch, keeping the
drive-UI row that follows:

```tsx
        {isElectron()
          ? <ElectronMcpToggle />
          : (
            <div className="settings-row settings-toggle-row">
              <label className="settings-label">Enable MCP server</label>
              <input type="checkbox" checked={enabled}
                onChange={e => setFlag('mcp_enabled', e.target.checked)} />
            </div>
          )}
        <div className="settings-row settings-toggle-row">
```

Then find where the body is gated on `enabled` and make it also accept "Electron backend up":

```tsx
        {enabled && (
          <>
            <McpLiveStatus status={status!} />
```
→
```tsx
        {(enabled || (isElectron() && hasBackend())) && status && (
          <>
            <McpLiveStatus status={status!} />
```

(Adding `&& status` guards `status!` and the connect snippet against the brief window between
page load and the first `/api/mcp/status` response. On web, `enabled` already implies a loaded
status; on desktop the extra `hasBackend()` opens the body once the sidecar is up.)

- [ ] **Step 4: `LibraryFolderSetting` — hide the Docker text field on all Electron builds**

The text field says "Path inside the container… docker -v …" — wrong for desktop, which uses the
native folder picker (Task 5). Currently `if (electronMode) return null;`:

```tsx
  // Don't show in Electron mode (has its own folder picker)
  if (electronMode) return null;
```
→
```tsx
  // Don't show on desktop — it has its own native folder picker (LibraryPanel).
  if (isElectron()) return null;
```

If `electronMode` is now unused in `LibraryFolderSetting`, drop it from that function's
`useDatabank()` destructure.

- [ ] **Step 5: `pushWatermarkTermsToBackend` + reindex prompt → `hasBackend()`**

```ts
function pushWatermarkTermsToBackend(terms: string[]): void {
  if (isElectron()) return;
```
→
```ts
function pushWatermarkTermsToBackend(terms: string[]): void {
  if (!hasBackend()) return;
```

And the reindex prompt:

```tsx
      {showReindex && !isElectron() && (
```
→
```tsx
      {showReindex && hasBackend() && (
```

- [ ] **Step 6: Typecheck**

```bash
cd /Users/besitzer/Desktop/Boardviewer/src/frontend && npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add src/frontend/src/panels/SettingsPanel.tsx
git commit -m "feat(desktop): unified MCP toggle + backend-aware Settings gates"
```

---

### Task 7: Hide the Docker-update UI on Electron builds

**Files:**
- Modify: `src/frontend/src/components/Toolbar.tsx`
- Modify: `src/frontend/src/App.tsx`

A guard, not a feature. Once a real backend runs inside Electron (Task 3), the `UpdateBadge`
would look functional while silently failing (no `PubKey`/`SourceList` in the desktop binary —
Global Constraints). Hidden regardless of MCP state. `Toolbar.tsx` already imports `isElectron`
after Task 5.

**Interfaces:**
- Consumes: `isElectron()` (Toolbar already imports it after Task 5; App.tsx adds the import).

- [ ] **Step 1: Gate `<UpdateBadge />` in `Toolbar.tsx`**

```tsx
      <UpdateBadge update={update} />
```
→
```tsx
      {!isElectron() && <UpdateBadge update={update} />}
```

- [ ] **Step 2: Import `isElectron` in `App.tsx`**

After `import { saveDroppedToIncoming } from './store/incoming-upload';`:

```ts
import { isElectron } from './store/databank-store';
```

- [ ] **Step 3: Gate the drop-to-update-bundle branch**

```tsx
    for (const file of files) {
      if (isUpdateBundle(file.name)) {
```
→
```tsx
    for (const file of files) {
      if (!isElectron() && isUpdateBundle(file.name)) {
```

- [ ] **Step 4: Typecheck**

```bash
cd /Users/besitzer/Desktop/Boardviewer/src/frontend && npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/components/Toolbar.tsx src/frontend/src/App.tsx
git commit -m "fix(desktop): hide Docker-update UI on Electron builds"
```

---

### Task 8: End-to-end verification, MCP parity check, and docs

**Files:**
- Modify: `CLAUDE.md`

Exercises Tasks 1-7 together and confirms the design's "single source of truth" invariant (§3):
the desktop sidecar and a NAS/Docker instance expose identical MCP tools because they compile
the same source tree.

- [ ] **Step 1: Full frontend test + build sanity**

```bash
cd /Users/besitzer/Desktop/Boardviewer/src/frontend && npx tsc --noEmit && npx vite build --base ./
```

Expected: typecheck clean, Vite build succeeds.

- [ ] **Step 2: Build a desktop package with the sidecar**

```bash
cd /Users/besitzer/Desktop/Boardviewer/desktop && node build-all.mjs --mac
```

Expected: completes; produces `desktop/out/BoardRipper-macOS-universal-v<version>.zip`. Confirm
`desktop/bin/darwin/server` is a universal binary: `lipo -info desktop/bin/darwin/server`
prints `Architectures in the fat file: ... arm64 x86_64`.

- [ ] **Step 3: Launch it and enable MCP through the UI**

Unzip and open the built `.app`. Settings ▸ Integrations shows the "Enable MCP server" switch
(the `ElectronMcpToggle`), unchecked; the databank/Database-info sections behave as today
(IPC-only). Check the switch → the app reloads → the full Integrations UI (token, connect-card
snippets, client picker, drive-UI toggle) renders, **and** Settings ▸ Database info now shows
PDF-index/dedup controls (backend features unlocked). Confirm the Library tab uses the native
folder picker (not a Docker path field) and the toolbar button reads "Open".

- [ ] **Step 4: Connect a real MCP client + verify the live bridge**

```bash
claude mcp add --transport http boardripper-desktop-test \
  http://127.0.0.1:<port>/api/mcp \
  --header "Authorization: Bearer <token from the Integrations tab>"
claude mcp list
```

Expected: `boardripper-desktop-test` shows `✓ Connected`. Open a board in the app, then confirm a
live-board tool (e.g. `board_active`) returns the open board over the WS bridge — proving the
sidecar-served page connected the bridge.

- [ ] **Step 5: Tool-list parity vs a NAS/Docker instance on the same commit**

```bash
claude mcp add --transport http boardripper-nas-test http://<nas-host>:1336/api/mcp \
  --header "Authorization: Bearer <NAS token>"
```

Inspect `tools/list` on both connections; confirm identical tool names, count, and schemas. Any
difference means a tool drifted into a desktop-only or NAS-only definition — which must not
happen given `src/backend/mcpserver` is never forked (Global Constraints / design §8).

- [ ] **Step 6: Opt-out path**

Uncheck "Enable MCP server". The app reloads to the lightweight IPC-only mode; Settings ▸
Integrations shows the switch again (unchecked); `ps aux | grep bin/darwin/server` shows the
backend gone.

- [ ] **Step 7: Clean up test connections**

```bash
claude mcp remove boardripper-desktop-test
claude mcp remove boardripper-nas-test
```

- [ ] **Step 8: Document in `CLAUDE.md`**

Append to the end of the existing MCP bullet under "Key Architectural Decisions" (the bullet
starting `- **MCP server + live-board bridge`) — same bullet, same subsystem:

```
Desktop (Electron) opt-in: a new `mcpEnabled` setting (off by default, `desktop/main.js`,
persisted in `settings.json` with a stable `mcpPort`) spawns the exact same backend binary
(`CGO_ENABLED=0`, cross-compiled + `lipo`'d to a universal mac binary in
`desktop/build-all.mjs`) as a loopback child process, seeds `mcp_enabled`, and reloads the
window from `http://127.0.0.1:<port>/` — after which the renderer is identical to the web build
(`hasBackend()` in `databank-store.ts` gates the IPC-vs-backend forks). Because
`src/backend/mcpserver` is never forked, desktop and NAS always expose identical tools. On
desktop the backend runs only while MCP is enabled. See
`docs/specs/2026-07-15-desktop-mcp-backend-sidecar-design.md`.
```

- [ ] **Step 9: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: note desktop MCP backend sidecar in CLAUDE.md"
```
