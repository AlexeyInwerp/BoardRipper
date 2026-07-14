# Desktop MCP Backend Sidecar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let desktop (Electron) users opt into the same MCP server + full backend (databank,
board DB, OBD, PDF index) that the Docker/NAS deployment ships, without changing the default
footprint for users who never enable it.

**Architecture:** A new Electron-native `mcpEnabled` setting gates spawning the existing Go
backend (`src/backend`, cross-compiled per-platform, zero source changes) as a loopback child
process. When off (default), desktop behaves exactly as it does today — `loadFile()`, IPC-only
library scan/read. When on, Electron picks a free port, spawns the backend, waits for
`/api/health`, bootstraps its `mcp_enabled` config flag, and `loadURL()`s the page from the
backend origin instead — after which the renderer is indistinguishable from the web/NAS build.

**Tech Stack:** Electron 35 (`desktop/`, CommonJS `main.js`/`preload.js`), Go 1.25 backend
(`src/backend`, `CGO_ENABLED=0`), React 19 frontend (`src/frontend`), Node's built-in
`node:test` runner for the one new pure-Node module.

## Global Constraints

- The Go backend package (`src/backend/mcpserver/*`, `databank`, `boarddb`, `obd`, `pdfindex`)
  is **never modified or forked** — desktop compiles the exact same source tree Docker does.
  Any new MCP tool/prompt in the future goes in the shared package, not a desktop-only copy.
- `mcpEnabled` defaults to `false`. A user who never opts in gets byte-identical behavior to
  today's app: no child process spawned, no new files under `userData`, no network calls.
- The bundled backend binary is built with `CGO_ENABLED=0` and **no** update-related ldflags
  (`PubKey`/`SourceList` stay empty) — the Docker self-update pipeline does not apply to
  desktop; hitting `/api/update/*` from this binary returns a graceful "not configured" error,
  never a crash (verified: `src/backend/updater/updater.go:154-167`).
- `main.go`'s CSRF check (`src/backend/middleware_security.go:53-86`) allows same-origin
  browser requests and any request with no `Origin`/`Referer` header (programmatic clients) —
  both the renderer's `fetch('/api/...')` calls (once loaded from `http://127.0.0.1:<port>/`)
  and Electron main-process calls to the backend pass through untouched. No backend change
  needed for this.
- `main.go` binds via `srv.ListenAndServe()` with no port-discovery mechanism
  (`src/backend/main.go:512-546`) — Electron must pick the port itself and pass it via `PORT`
  env var; it can never ask the backend what port it chose.
- `/api/health` (`src/backend/handlers/health.go`) returns `503 {"status":"starting"}` until
  ready, `200 {"status":"ok"}` once ready — this is the health-check contract to poll.
- `PUT /api/config` (`src/backend/handlers/databank.go:596-628`) takes
  `{"key": "...", "value": "..."}`; `mcp_enabled`/`library_dir` are both in `allowedConfigKeys`.
  Truthy value strings are `"1"` or `"true"` (`src/backend/mcpserver/state.go:15-24`); the
  existing frontend convention (`SettingsPanel.tsx:553`) uses `"true"`.

---

### Task 1: Cross-compile the backend + bundle the board DB into desktop builds

**Files:**
- Modify: `desktop/build-all.mjs`
- Modify: `desktop/build-mac.mjs`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `desktop/bin/darwin-arm64/server`, `desktop/bin/darwin-x64/server`,
  `desktop/bin/win32-x64/server.exe` (built on demand, matching whichever `--mac`/`--legacy`/
  `--win` flags are passed), and `desktop/bin/boards.db` (copied once, shared by all
  platforms). Task 2's `resolveBinaryPath()`/`resolveBoardDbPath()` consume these exact paths.

- [ ] **Step 1: Add the cross-compile step to `build-all.mjs`**

Insert immediately after the existing `webapp/` copy step (after the `cpSync(path.join(FRONTEND, 'dist'), WEBAPP_DIR, ...)` block, before `const packager = ...`):

```js
// ═══════════════════════════════════════════════════════════════
// Step 1.5: Cross-compile the Go backend sidecar (CGO_ENABLED=0, no
// update ldflags — the Docker self-update pipeline doesn't apply here)
// ═══════════════════════════════════════════════════════════════
const BACKEND = path.join(ROOT, 'src', 'backend');
const BIN_DIR = path.join(DESKTOP, 'bin');
if (existsSync(BIN_DIR)) rmSync(BIN_DIR, { recursive: true });

function buildBackend(goos, goarch, dirName) {
  const outDir = path.join(BIN_DIR, dirName);
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, goos === 'win32' || goos === 'windows' ? 'server.exe' : 'server');
  console.log(`\n=== Cross-compiling backend for ${dirName} ===`);
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
  buildBackend('darwin', 'arm64', 'darwin-arm64');
  buildBackend('darwin', 'amd64', 'darwin-x64');
}
if (buildWin) {
  buildBackend('windows', 'amd64', 'win32-x64');
}

console.log('\n=== Copying Board Database → desktop/bin/boards.db ===');
mkdirSync(BIN_DIR, { recursive: true });
cpSync(path.join(ROOT, 'Board Database', 'boards.db'), path.join(BIN_DIR, 'boards.db'));
```

- [ ] **Step 2: Exclude the other platforms' binaries from each packaging target**

Each packaging step ships only the binaries it needs — a universal mac build needs both darwin
binaries (merged into one universal `.app`, see rationale below), legacy mac needs x64 only,
Windows needs its own exe only. Update each `commonOpts`/packager call's `ignore` array:

In the macOS universal block (`if (buildMac) { ... }`), the `commonOpts.ignore` array becomes:

```js
    ignore: [...IGNORE_PATTERNS, /^\/bin\/win32-x64($|\/)/],
```

(Both `darwin-arm64` and `darwin-x64` binaries ship in **both** the arm64 and x64 intermediate
packager passes — `makeUniversalApp` requires non-executable resources to be byte-identical
between the two passes it merges, and since `desktop/bin/` isn't touched between the two
`packager()` calls, both binaries are trivially identical across both passes. At runtime
`resolveBinaryPath()` (Task 2) picks the right one via `process.arch`, the same way the
universal Electron Framework itself carries both arches.)

In the macOS Legacy block (`if (buildLegacy) { ... }`), the packager call's `ignore` becomes:

```js
    ignore: [...IGNORE_PATTERNS, /^\/bin\/win32-x64($|\/)/, /^\/bin\/darwin-arm64($|\/)/],
```

In the Windows block (`if (buildWin) { ... }`), the packager call's `ignore` becomes:

```js
    ignore: [...IGNORE_PATTERNS, /^\/bin\/darwin-arm64($|\/)/, /^\/bin\/darwin-x64($|\/)/],
```

- [ ] **Step 3: Mirror the same cross-compile step into `build-mac.mjs`**

This script backs plain `npm run build` (dev iteration, single-arch or `--arch=universal`).
Insert after its `cpSync(path.join(FRONTEND, 'dist'), WEBAPP_DIR, ...)` step, before the
`packager` import:

```js
// ---------- 2.5. Cross-compile the Go backend sidecar ----------
console.log('\n=== Cross-compiling backend ===');
const BACKEND = path.join(ROOT, 'src', 'backend');
const BIN_DIR = path.join(DESKTOP, 'bin');
if (existsSync(BIN_DIR)) rmSync(BIN_DIR, { recursive: true });

function buildBackend(goarch, dirName) {
  const outDir = path.join(BIN_DIR, dirName);
  mkdirSync(outDir, { recursive: true });
  execSync(
    `go build -ldflags="-s -w -X boardripper/updater.Version=${JSON.parse(readFileSync(path.join(FRONTEND, 'package.json'), 'utf8')).version}" -o "${path.join(outDir, 'server')}" .`,
    {
      cwd: BACKEND,
      stdio: 'inherit',
      env: { ...process.env, CGO_ENABLED: '0', GOOS: 'darwin', GOARCH: goarch },
    },
  );
}

const archesToBuild = requestedArch === 'universal' ? ['arm64', 'x64'] : [requestedArch];
for (const a of archesToBuild) buildBackend(a, `darwin-${a}`);

mkdirSync(BIN_DIR, { recursive: true });
cpSync(path.join(ROOT, 'Board Database', 'boards.db'), path.join(BIN_DIR, 'boards.db'));
```

Note this references `requestedArch`, which is parsed a few lines below in the current file —
move the arch-parsing block (`const archArg = ...` / `const requestedArch = ...`) up to before
this new step (it currently sits right before `const packager = ...`).

- [ ] **Step 4: Ignore the build artifact**

Add to `.gitignore` alongside the existing `desktop/webapp/` entry:

```
desktop/bin/
```

- [ ] **Step 5: Verify the cross-compiled binary actually runs**

```bash
cd desktop && node -e "
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
execSync('go build -o /tmp/br-server-test .', {
  cwd: path.join(__dirname, '..', 'src', 'backend'),
  env: { ...process.env, CGO_ENABLED: '0', GOOS: 'darwin', GOARCH: os.arch() === 'arm64' ? 'arm64' : 'amd64' },
});
console.log('build OK');
"
DATA_DIR=$(mktemp -d) STATIC_DIR=desktop/webapp PORT=18099 /tmp/br-server-test &
SERVER_PID=$!
sleep 1
curl -sf http://127.0.0.1:18099/api/health
kill $SERVER_PID
rm /tmp/br-server-test
```

Expected: `build OK`, then `{"status":"ok"}` from curl (backend built and is served correctly
even without `desktop/webapp/` having been freshly built — an empty/missing static dir doesn't
block `/api/health`).

- [ ] **Step 6: Commit**

```bash
git add desktop/build-all.mjs desktop/build-mac.mjs .gitignore
git commit -m "build(desktop): cross-compile backend sidecar into desktop bundles"
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
const { spawn } = require('node:child_process');
const {
  pickFreePort,
  waitForHealth,
  stopBackend,
} = require('./backend-sidecar');

test('pickFreePort returns a usable, distinct port each call', async () => {
  const a = await pickFreePort();
  const b = await pickFreePort();
  assert.ok(Number.isInteger(a) && a > 0 && a < 65536);
  assert.ok(Number.isInteger(b) && b > 0 && b < 65536);
});

test('waitForHealth resolves true once a /api/health-like server comes up', async () => {
  const port = await pickFreePort();
  // Fake backend: starts serving 200 on /api/health after a short delay,
  // simulating real startup latency without depending on the Go binary.
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
    const healthy = await waitForHealth(port, 5000);
    assert.strictEqual(healthy, true);
  } finally {
    stopBackend(proc);
  }
});

test('waitForHealth resolves false when nothing ever listens', async () => {
  const port = await pickFreePort();
  const healthy = await waitForHealth(port, 500);
  assert.strictEqual(healthy, false);
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
cd desktop && node --test backend-sidecar.test.js
```

Expected: FAIL — `Cannot find module './backend-sidecar'`.

- [ ] **Step 3: Write `desktop/backend-sidecar.js`**

```js
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

/** Ask the OS for a free loopback port. main.go binds via srv.ListenAndServe()
 *  with no way to report back which port it chose, so the caller must decide
 *  the port up front and pass it in via PORT — see docs/specs/
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

/** Path to the bundled server binary for the current platform/arch. Both
 *  desktop/bin/darwin-arm64 and desktop/bin/darwin-x64 ship inside a
 *  universal mac build (see build-all.mjs Task 1) — process.arch picks the
 *  right one at runtime, same as the universal Electron Framework itself. */
function resolveBinaryPath() {
  const dirName = process.platform === 'win32'
    ? 'win32-x64'
    : `darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
  const name = process.platform === 'win32' ? 'server.exe' : 'server';
  return path.join(__dirname, 'bin', dirName, name);
}

function resolveBoardDbPath() {
  return path.join(__dirname, 'bin', 'boards.db');
}

/** Spawn the backend. Caller owns the returned process (attach stdout/stderr/
 *  exit listeners, call stopBackend to tear down). */
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

/** Poll GET /api/health until it returns 200, or timeoutMs elapses.
 *  503 {"status":"starting"} means not ready yet; any fetch failure (process
 *  not listening yet) is treated the same way and retried. */
async function waitForHealth(port, timeoutMs = 15000) {
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

/** Bootstrap the backend's own mcp_enabled config flag so /api/mcp stops
 *  404ing the first time a user opts in — mirrors what the Settings ▸
 *  Integrations "Enable MCP server" checkbox does on the web build
 *  (SettingsPanel.tsx setFlag). Best-effort: a failure here just means the
 *  user has to flip the (now-visible) Integrations toggle once themselves. */
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
cd desktop && node --test backend-sidecar.test.js
```

Expected: all 4 tests PASS.

- [ ] **Step 5: Add a `test` script**

In `desktop/package.json`, add to `"scripts"`:

```json
    "test": "node --test"
```

- [ ] **Step 6: Commit**

```bash
git add desktop/backend-sidecar.js desktop/backend-sidecar.test.js desktop/package.json
git commit -m "feat(desktop): add backend sidecar process manager module"
```

---

### Task 3: Wire `main.js` + `preload.js` — the `mcpEnabled` lifecycle end-to-end

**Files:**
- Modify: `desktop/main.js`
- Modify: `desktop/preload.js`
- Modify: `src/frontend/src/electron.d.ts`

**Interfaces:**
- Consumes: Task 2's `backend-sidecar.js` exports.
- Produces: `window.electronAPI.getMcpEnabled(): Promise<boolean>`,
  `window.electronAPI.setMcpEnabled(on: boolean): Promise<boolean>` (consumed by Task 5's
  `ElectronMcpToggle`).

- [ ] **Step 1: Add the sidecar require + module-level state, near the top of `main.js`**

After the existing `const fs = require('fs');` line:

```js
const {
  pickFreePort,
  resolveBoardDbPath,
  startBackend,
  waitForHealth,
  enableMcpConfig,
  stopBackend,
} = require('./backend-sidecar');

// The currently-running backend sidecar, or null. Set only while
// mcpEnabled is true and the process is (believed to be) alive.
let currentBackend = null; // { proc, port }
```

- [ ] **Step 2: Replace the direct `loadFile` call in `createWindow()` with a `boot()` call**

Find this block near the end of `createWindow()`:

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

Replace it with:

```js
  boot();
```

- [ ] **Step 3: Add `boot()`, `startBackendAndLoad()`, and `loadStaticFile()` helpers**

Insert these functions right after `createWindow()`'s closing brace (before `async function
openFileDialog()`):

```js
// Set right before we deliberately kill the current backend (user toggled
// MCP off, or a crash-retry is about to replace it) so the 'exit' listener
// can tell "we did this on purpose" apart from "it crashed." Cleared at the
// top of startBackendAndLoad() so normal crash-detection resumes once a new
// process is up — NOT reset synchronously after kill(), since 'exit' fires
// asynchronously and a synchronous reset would race it.
let stoppingDeliberately = false;
// How many consecutive unexpected exits we've auto-retried, mid-session
// (i.e. after a prior successful health-check + loadURL — NOT startup
// failures, which are handled separately by the !healthy branch below).
let crashRetries = 0;

function loadStaticFile() {
  const indexPath = path.join(WEBAPP_DIR, 'index.html');
  log('INFO', `Loading: ${indexPath}`);
  return mainWindow.loadFile(indexPath).then(() => {
    log('INFO', 'index.html loaded successfully');
  }).catch((err) => {
    logFatal('Failed to load index.html', err);
  });
}

/** Spawn the backend sidecar, wait for it to become healthy, bootstrap its
 *  mcp_enabled flag, then load the window from it. On startup failure, kill
 *  the process, revert mcpEnabled to false so the next launch doesn't retry
 *  a broken setup, and fall back to loadStaticFile(). Returns true on
 *  success. If the process later exits unexpectedly *after* a successful
 *  start (a genuine mid-session crash), the 'exit' listener below drives
 *  handleUnexpectedExit() instead of this function's own failure path. */
async function startBackendAndLoad() {
  stoppingDeliberately = false;
  const settings = loadSettings();
  const port = await pickFreePort();
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
    if (currentBackend && currentBackend.proc === proc) currentBackend = null;
    if (!wasCurrent) {
      // Exited before ever becoming the "current" backend — that's a
      // startup failure, already handled by the !healthy branch below.
      exitedDuringStartup = true;
      return;
    }
    if (stoppingDeliberately) return; // user-initiated stop, not a crash
    void handleUnexpectedExit();
  });

  const healthy = await waitForHealth(port, 15000);
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

/** A previously-healthy backend died mid-session. Retry with backoff
 *  (1s, 3s, 9s); if that's exhausted, disable MCP and fall back to the
 *  static file so the app is at least usable again. */
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

- [ ] **Step 4: Fix the GPU-retry path in `render-process-gone` to reload from the right place**

Find:

```js
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log('ERROR', `Renderer process gone: reason=${details.reason}, exitCode=${details.exitCode}`);
    if (details.reason === 'launch-failed' && !retried) {
      retried = true;
      log('INFO', 'Retrying with GPU disabled...');
      app.commandLine.appendSwitch('disable-gpu');
      mainWindow.loadFile(path.join(WEBAPP_DIR, 'index.html'));
    } else {
```

Replace the `mainWindow.loadFile(...)` line with:

```js
      if (currentBackend) {
        mainWindow.loadURL(`http://127.0.0.1:${currentBackend.port}/`);
      } else {
        mainWindow.loadFile(path.join(WEBAPP_DIR, 'index.html'));
      }
```

- [ ] **Step 5: Add the `get-mcp-enabled` / `set-mcp-enabled` IPC handlers**

Add near the other `ipcMain.handle` calls (after the `platform` handler):

```js
ipcMain.handle('get-mcp-enabled', () => !!loadSettings().mcpEnabled);

ipcMain.handle('set-mcp-enabled', async (_event, on) => {
  const settings = loadSettings();
  settings.mcpEnabled = !!on;
  saveSettings(settings);
  if (on) {
    return await startBackendAndLoad();
  }
  stopCurrentBackend();
  await loadStaticFile();
  return true;
});
```

- [ ] **Step 6: Kill the sidecar on quit**

Add near the other `app.on(...)` handlers, before `app.on('activate', ...)`:

```js
app.on('before-quit', () => {
  stopCurrentBackend();
});
```

- [ ] **Step 7: Expose the two new calls from `preload.js`**

In `desktop/preload.js`, add to the `contextBridge.exposeInMainWorld('electronAPI', { ... })`
object, after the existing `platform` entry:

```js
  // MCP server sidecar toggle — persisted in Electron settings.json,
  // gates whether the Go backend child process is spawned at all.
  getMcpEnabled: () => ipcRenderer.invoke('get-mcp-enabled'),
  setMcpEnabled: (on) => ipcRenderer.invoke('set-mcp-enabled', on),
```

- [ ] **Step 8: Add the matching TypeScript declarations**

In `src/frontend/src/electron.d.ts`, add to the `ElectronAPI` interface, after `platform`:

```ts
  // MCP server sidecar toggle (see desktop/main.js)
  getMcpEnabled: () => Promise<boolean>;
  setMcpEnabled: (on: boolean) => Promise<boolean>;
```

- [ ] **Step 9: Manual verification**

Requires Task 1 having produced a binary for the host platform (`node build-mac.mjs` or the
Step-5 snippet from Task 1).

```bash
cd desktop && npm start
```

- With no prior `settings.json`, confirm the log file
  (`~/Library/Application Support/BoardRipper/logs/boardripper.log` on macOS) shows
  `index.html loaded successfully` and no `[backend]` lines — today's behavior, unchanged.
- Quit. Manually set `mcpEnabled: true` in
  `~/Library/Application Support/BoardRipper/settings.json`, relaunch with `npm start`.
  Confirm the log shows `Starting backend sidecar on port ...` then
  `Backend sidecar healthy, loading http://127.0.0.1:.../`, and the app window renders the
  normal UI (now backend-served).
- Quit via Cmd+Q / window close; confirm (via `ps aux | grep desktop/bin`) the `server` process
  is gone within ~1s.
- **Crash-restart:** with `mcpEnabled: true` and the app running (backend-served), find the
  sidecar's pid (`ps aux | grep desktop/bin`) and `kill -9 <pid>`. Confirm the log shows
  `Backend sidecar exited: code=null signal=SIGKILL`, then `retrying in 1000ms (attempt 1/3)`,
  then a fresh `Backend sidecar healthy, loading http://127.0.0.1:.../` on a new port, and the
  window reloads showing the normal UI again (open tabs are lost — expected, see spec §9).

- [ ] **Step 10: Commit**

```bash
git add desktop/main.js desktop/preload.js src/frontend/src/electron.d.ts
git commit -m "feat(desktop): spawn backend sidecar when mcpEnabled, wire IPC toggle"
```

---

### Task 4: `hasBackend()` helper + `databank-store.ts` call-site audit

**Files:**
- Modify: `src/frontend/src/store/databank-store.ts`

**Interfaces:**
- Produces: `export function hasBackend(): boolean` (consumed by Task 5's `SettingsPanel.tsx`
  and Task 6's `Toolbar.tsx`/`App.tsx`).

This task changes the *condition* on every existing `isElectron()` call site that exists to
choose "talk to the backend over HTTP" vs. "use the Electron IPC fallback." It does **not**
delete the IPC paths — they remain the only path when `mcpEnabled` is off. Every site below was
read in full before writing this task; there are no others in this file.

- [ ] **Step 1: Add `hasBackend()` next to `isElectron()`**

```ts
/** Are we running inside Electron with library APIs available? */
export function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI?.scanLibrary;
}

/** True whenever a real Go backend is reachable at the current origin.
 *  Always true for the web/NAS build. True for Electron only once the
 *  mcpEnabled sidecar has taken over the page load (loadURL to
 *  http://127.0.0.1:<port>/ instead of loadFile's file:// origin) — see
 *  docs/specs/2026-07-15-desktop-mcp-backend-sidecar-design.md §4. */
export function hasBackend(): boolean {
  return !isElectron() || (typeof location !== 'undefined' && location.protocol !== 'file:');
}
```

- [ ] **Step 2: `checkScanStatus()` (was line 786)**

```ts
  async checkScanStatus(): Promise<void> {
    if (isElectron()) return;
```
→
```ts
  async checkScanStatus(): Promise<void> {
    if (!hasBackend()) return;
```

- [ ] **Step 3: `_runStartupLoad()` startup fork (was line 830)**

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
      // Electron, no backend sidecar running: IPC-only path, unchanged.
      if (isElectron() && !hasBackend()) {
        await this.initElectron();
        this._loadStatus = 'loaded';
        this.notify();
        return;
      }
      if (isElectron()) {
        // Backend sidecar is live (mcpEnabled) — still mark Electron mode
        // so LibraryFolderSetting keeps deferring to the native
        // folder-picker UI, but otherwise fall through to the normal
        // browser/backend load chain below. loadConfig() will read
        // library_dir from the same backend the sidecar was spawned with.
        this._electronMode = true;
      }

      // Browser branch: matches the order in today's LibraryPanel useEffect
      // (which this method is replacing). Also used by Electron once a
      // backend sidecar is running.
      await this.loadConfig();
```

- [ ] **Step 4: `_doFetchFiles()` (was line 963)**

```ts
    if (isElectron()) {
      libraryLoadStore.begin('Electron scan');
```
→
```ts
    if (!hasBackend()) {
      libraryLoadStore.begin('Electron scan');
```

- [ ] **Step 5: `_doFetchFilesByIds()` (was line 1155)**

```ts
  private async _doFetchFilesByIds(ids: number[]): Promise<void> {
    if (isElectron() || ids.length === 0) return;
```
→
```ts
  private async _doFetchFilesByIds(ids: number[]): Promise<void> {
    if (!hasBackend() || ids.length === 0) return;
```

- [ ] **Step 6: `fetchTree()` (was line 1171)**

```ts
  async fetchTree(): Promise<void> {
    if (isElectron()) {
      // Tree is built during _electronScan
      return;
    }
```
→
```ts
  async fetchTree(): Promise<void> {
    if (!hasBackend()) {
      // Tree is built during _electronScan
      return;
    }
```

- [ ] **Step 7: `triggerFileScan()` (was line 1359)**

```ts
    if (isElectron()) {
      await this._electronScan();
```
→
```ts
    if (!hasBackend()) {
      await this._electronScan();
```

(The `else` branch — `apiFetch` POST `/api/databank/scan` — is unchanged.)

- [ ] **Step 8: `stopScan()` (was line 1376)**

```ts
  async stopScan(): Promise<void> {
    if (isElectron()) return;
```
→
```ts
  async stopScan(): Promise<void> {
    if (!hasBackend()) return;
```

- [ ] **Step 9: `generatePdfPreview()` (was line 1640)**

```ts
    if (file.file_type !== 'pdf' || file.has_preview || isElectron()) return false;
```
→
```ts
    if (file.file_type !== 'pdf' || file.has_preview || !hasBackend()) return false;
```

- [ ] **Step 10: `fetchFileBuffer()` (was lines 1864-1869)**

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

- [ ] **Step 11: `loadConfig()` (was line 1964)**

```ts
  async loadConfig(): Promise<void> {
    if (isElectron()) return;
```
→
```ts
  async loadConfig(): Promise<void> {
    if (!hasBackend()) return;
```

- [ ] **Step 12: `setLibraryDir()` (was line 1975) — generalize the guard**

```ts
  async setLibraryDir(dir: string): Promise<boolean> {
    if (isElectron()) return false;
```
→
```ts
  async setLibraryDir(dir: string): Promise<boolean> {
    if (!hasBackend()) return false;
```

- [ ] **Step 13: `selectLibraryFolder()` (was lines 1949-1958) — sync the new path to the backend when one is running**

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
        // Backend sidecar is running: tell it the new root (mirrors the
        // web/NAS setLibraryDir flow) and let it do the real scan.
        await this.setLibraryDir(folderPath);
        await this.triggerFileScan();
      } else {
        await this._electronScan();
      }
    }
    return folderPath;
  }
```

`initElectron()` (line 1938) and `_electronScan()` (line 1990) are unchanged — both remain the
IPC-only implementation, now reached only from the `isElectron() && !hasBackend()` fork.
`LibraryFolderSetting()` in `SettingsPanel.tsx` (`if (electronMode) return null;`) is also
unchanged — it stays gated on `electronMode` alone (not `hasBackend()`), since Electron keeps
its native folder-picker as the library-selection UX regardless of whether a backend is running.

- [ ] **Step 14: Typecheck**

```bash
cd src/frontend && npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 15: Commit**

```bash
git add src/frontend/src/store/databank-store.ts
git commit -m "feat(desktop): add hasBackend() and switch backend-vs-IPC forks onto it"
```

---

### Task 5: `SettingsPanel.tsx` — pre-backend "Enable MCP server" switch

**Files:**
- Modify: `src/frontend/src/panels/SettingsPanel.tsx`

**Interfaces:**
- Consumes: Task 3's `window.electronAPI.getMcpEnabled/setMcpEnabled`; Task 4's `hasBackend()`.

- [ ] **Step 1: Import `hasBackend`**

Find the existing import (line 36):

```ts
import { isElectron } from '../store/databank-store';
```

Replace with:

```ts
import { isElectron, hasBackend } from '../store/databank-store';
```

- [ ] **Step 2: Add the `ElectronMcpToggle` component**

Insert immediately before `function IntegrationsSection() {` (line 518):

```tsx
/** Pre-backend Electron switch: the only way to opt into MCP before a
 *  backend sidecar has ever run. Same "Enable MCP server" label/copy as the
 *  real Integrations toggle below — flipping it on triggers a page reload
 *  once the sidecar is healthy, at which point IntegrationsSection (the
 *  full backend-driven UI) takes over seamlessly. */
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
    const ok = await window.electronAPI!.setMcpEnabled(on);
    // On success the window navigates away (loadURL/loadFile) and this
    // component unmounts. On failure (backend never became healthy) we're
    // still here — reflect the revert.
    if (!ok) { setEnabled(false); setPending(false); }
  };

  return (
    <div className="settings-tab-body">
      <StandaloneCollapsibleSection title="MCP server (AI agents)" defaultOpen storageKey="mcp">
        <p className="settings-hint">
          Let an AI agent (Claude Code, Claude Desktop, Cursor, or any MCP client) query
          this BoardRipper — PDF full-text search, OpenBoardData readings, the board
          reference DB, and the live connectivity of whatever board you have open — and
          drive the view. Off by default. Enabling it starts BoardRipper's local server;
          the app will reload.
        </p>
        <div className="settings-row settings-toggle-row">
          <label className="settings-label">Enable MCP server</label>
          <input type="checkbox" checked={enabled} disabled={!loaded || pending}
            onChange={e => toggle(e.target.checked)} />
        </div>
        {pending && <p className="settings-hint">Starting local server…</p>}
      </StandaloneCollapsibleSection>
    </div>
  );
}

```

- [ ] **Step 3: Branch at the render call site, not inside `IntegrationsSection`**

`IntegrationsSection` calls hooks unconditionally today; an early `return` before those hooks
would make hook execution depend on a runtime condition, tripping React's rules-of-hooks lint
rule. Branch one level up instead, where the tab is rendered. Find (in `SettingsPanel()`):

```tsx
      {activeTab === 'integrations' && (
        <IntegrationsSection />
      )}
```

Replace with:

```tsx
      {activeTab === 'integrations' && (
        isElectron() && !hasBackend() ? <ElectronMcpToggle /> : <IntegrationsSection />
      )}
```

`IntegrationsSection` itself is unchanged — it's simply not mounted at all while Electron has no
backend yet, so its `/api/mcp/status` fetch (which would otherwise fail against a `file://`
origin) never runs.

- [ ] **Step 4: Update the two remaining `isElectron()` sites in this file**

`pushWatermarkTermsToBackend()` (line 1268):

```ts
function pushWatermarkTermsToBackend(terms: string[]): void {
  if (isElectron()) return;
```
→
```ts
function pushWatermarkTermsToBackend(terms: string[]): void {
  if (!hasBackend()) return;
```

The reindex prompt (line 1364):

```tsx
      {showReindex && !isElectron() && (
```
→
```tsx
      {showReindex && hasBackend() && (
```

- [ ] **Step 5: Typecheck**

```bash
cd src/frontend && npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/panels/SettingsPanel.tsx
git commit -m "feat(desktop): pre-backend Enable MCP server switch in Settings"
```

---

### Task 6: Hide the Docker-update UI on Electron builds

**Files:**
- Modify: `src/frontend/src/components/Toolbar.tsx`
- Modify: `src/frontend/src/App.tsx`

Not a new feature — a guard. Once a real backend can run inside Electron (Task 3), the existing
`UpdateBadge` would otherwise look functional while silently failing (`PubKey`/`SourceList`
are empty in the desktop-compiled binary — Global Constraints). This must be hidden regardless
of `mcpEnabled` state, since it's about the *binary's* capabilities, not the MCP toggle.

**Interfaces:**
- Consumes: `isElectron()` from `databank-store.ts` (already exported, no change needed).

- [ ] **Step 1: Import `isElectron` in `Toolbar.tsx`**

Find:

```ts
import { databankStore } from '../store/databank-store';
```

Replace with:

```ts
import { databankStore, isElectron } from '../store/databank-store';
```

- [ ] **Step 2: Gate `<UpdateBadge />`**

Find (near the end of the toolbar's render):

```tsx
      <UpdateBadge update={update} />
```

Replace with:

```tsx
      {!isElectron() && <UpdateBadge update={update} />}
```

- [ ] **Step 3: Import `isElectron` in `App.tsx`**

Find:

```ts
import { saveDroppedToIncoming } from './store/incoming-upload';
```

Add immediately after it:

```ts
import { isElectron } from './store/databank-store';
```

- [ ] **Step 4: Gate the drop-to-update-bundle branch**

Find:

```tsx
    for (const file of files) {
      if (isUpdateBundle(file.name)) {
```

Replace with:

```tsx
    for (const file of files) {
      if (!isElectron() && isUpdateBundle(file.name)) {
```

- [ ] **Step 5: Typecheck**

```bash
cd src/frontend && npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 6: Manual verification**

Build and run the desktop app (`cd desktop && npm start`), confirm the toolbar shows no version
badge / update control at all. Confirm dropping a file named `boardripper-update-v1.0.0.tar`
onto the window does not show the "Install update bundle?" confirm dialog (falls through to
normal file handling instead).

- [ ] **Step 7: Commit**

```bash
git add src/frontend/src/components/Toolbar.tsx src/frontend/src/App.tsx
git commit -m "fix(desktop): hide Docker-update UI on Electron builds"
```

---

### Task 7: End-to-end verification — MCP tool parity + full opt-in flow

**Files:** none (verification only).

This task has no code changes; it exercises Tasks 1-6 together and confirms the "single source
of truth" invariant from the design spec (§3) actually holds — the desktop sidecar and a
NAS/Docker instance expose identical MCP tools, since they compile the same source tree.

- [ ] **Step 1: Build a full desktop package**

```bash
cd desktop && node build-all.mjs --mac
```

Expected: completes, produces `desktop/out/BoardRipper-macOS-universal-v<version>.zip`.

- [ ] **Step 2: Launch it, enable MCP through the UI**

Unzip and open the built `.app`. Go to Settings ▸ Integrations, confirm the pre-backend
"Enable MCP server" switch (Task 5) is visible and unchecked. Check it. Confirm the app reloads
and the full Integrations UI (token, connect-card snippets, client picker) now renders — same
as the web build.

- [ ] **Step 3: Connect a real MCP client and list tools**

```bash
claude mcp add --transport http boardripper-desktop-test \
  http://127.0.0.1:<port>/api/mcp \
  --header "Authorization: Bearer <token from the Integrations tab>"
claude mcp list
```

(`<port>` is visible in the connect-snippet URL shown in the Integrations tab; `<token>` is
the bearer token shown there too.)

Expected: `boardripper-desktop-test` shows `✓ Connected`.

- [ ] **Step 4: Diff the tool list against a NAS/Docker instance on the same commit**

```bash
claude mcp add --transport http boardripper-nas-test http://<nas-host>:1336/api/mcp \
  --header "Authorization: Bearer <NAS token>"
```

Using each connection, list available tools (e.g. via `claude mcp list` tool inspection, or any
MCP client's `tools/list` view) and confirm the tool names, count, and schemas are identical
between `boardripper-desktop-test` and `boardripper-nas-test`. This is the parity check called
for in the design spec (§8) — any difference means something drifted into a desktop-only or
NAS-only tool definition, which should not happen given `src/backend/mcpserver` is never
forked (Global Constraints).

- [ ] **Step 5: Confirm the opt-out path**

In Settings ▸ Integrations, uncheck "Enable MCP server". Confirm the app reloads back to the
lightweight IPC-only mode (folder scan works via the native picker; Settings ▸ Integrations
shows the pre-backend switch again, unchecked). Confirm (`ps aux | grep bin/darwin`) the
backend process is gone.

- [ ] **Step 6: Clean up test MCP connections**

```bash
claude mcp remove boardripper-desktop-test
claude mcp remove boardripper-nas-test
```

---

### Task 8: Documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Extend the MCP bullet in "Key Architectural Decisions"**

Find the bullet starting `- **MCP server + live-board bridge (feature/mcp-server-live-board-bridge):**`
in `CLAUDE.md`. Append a new sentence to the end of that bullet (same bullet, not a new one —
this is the same subsystem, not a separate feature):

```
Desktop (Electron) opt-in: a new `mcpEnabled` setting (off by default, `desktop/main.js`)
spawns the exact same backend binary (`CGO_ENABLED=0` cross-compiled per-platform in
`desktop/build-all.mjs`) as a loopback child process and reloads the window from it —
`src/backend/mcpserver` is never forked, so desktop and NAS always expose identical tools.
See `docs/specs/2026-07-15-desktop-mcp-backend-sidecar-design.md`.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: note desktop MCP backend sidecar in CLAUDE.md"
```
