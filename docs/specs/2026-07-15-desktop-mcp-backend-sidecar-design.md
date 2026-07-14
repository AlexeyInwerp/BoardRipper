# Desktop App: MCP Support via Go Backend Sidecar — Design

**Date:** 2026-07-15
**Status:** Approved design, pending implementation plan
**Scope:** Bring MCP server support to the Electron desktop app. In-app auto-update for
desktop is a separate, later spec — not designed here.

## 1. Goal

Let desktop (Electron) users opt into the same MCP server + live-board bridge that the
Docker/NAS deployment already ships (`src/backend/mcpserver/`, 20 tools), so an MCP client
(Claude Code, Claude Desktop, etc.) can query and drive a board open in the desktop app.

## 2. Context & constraints

- **The desktop app currently runs no backend at all.** `desktop/main.js` is a pure Electron
  shell: it `loadFile()`s the static Vite build (`desktop/webapp/`) and reimplements a thin
  slice of backend functionality directly in the Node main process via IPC — folder scan
  (`scan-library`), raw file read (`read-file` / `read-library-file`), native open-dialog,
  "show in Finder." Everything backend-dependent (SQLite databank search, board reference DB,
  OBD diagnosis data, PDF full-text index/dedup, and MCP itself) is unavailable on desktop
  today; the frontend's `isElectron()` gate (`databank-store.ts`) suppresses those code paths.
- **The MCP server cannot be meaningfully reimplemented client-side.** Its native tools
  (`pdf_search`, `obd_match`, `board_resolve`, `file_list`, …) are thin wrappers over the same
  SQLite/FTS5 stores the databank uses. There is no shortcut that doesn't either duplicate that
  logic in JS (permanent second implementation to maintain) or bundle the real backend.
- **The backend is `CGO_ENABLED=0`** (confirmed via `Dockerfile`, `modernc.org/sqlite` is
  pure-Go, PDF text extraction runs through wazero/WASM) — it already cross-compiles cleanly to
  Linux for Docker, and the same trick extends to `darwin/arm64`, `darwin/amd64`,
  `windows/amd64` with no source changes.
- **Must not change desktop's default footprint.** MCP is off by default in the web app
  (`mcp_enabled` config key, 404 when disabled) and desktop should preserve that: a user who
  never opts in gets exactly today's lightweight, backend-free app.
- **The existing Docker self-update pipeline (`src/backend/updater/`) does not apply here** —
  `docker.go` and the orchestrator-swap logic are Docker-socket specific. Settings ▸ Update
  must stay hidden on Electron builds regardless of MCP state; desktop's own update mechanism
  is out of scope for this spec.

## 3. Architecture

```
Electron main process                         Bundled Go backend (child process)
┌─────────────────────────┐   spawn on         ┌──────────────────────────────────┐
│ mcpEnabled? (settings)   │   opt-in           │ /server  (DATA_DIR=userData,     │
│  false → loadFile()      │──────────────────► │  LIBRARY_DIR=<setting>,          │
│  true  → spawn + wait    │   poll /api/health  │  STATIC_DIR=<bundled webapp>,   │
│          for health,     │◄──────────────────  │  BOARDDB_PATH=<bundled db>,     │
│          then loadURL()  │                     │  PORT=<n>, n picked by Electron)│
└─────────────────────────┘                     └──────────────────────────────────┘
        │ loadURL('http://127.0.0.1:<port>/')
        ▼
Renderer now talks to relative /api/... exactly like the NAS/Docker version — the existing
mcpserver, databank, boarddb, obd, and pdfindex packages run completely unmodified.
```

The sidecar is gated entirely on one new Electron-native setting, `mcpEnabled` (boolean,
default `false`), so enabling MCP is also, as a side effect, what brings desktop to feature
parity with the NAS version for databank/board-DB/OBD/PDF-search — but only for users who opt
in. Library-sync (WebDAV) stays excluded regardless (NAS-hosting concern, not a desktop-client
one).

### Components & boundaries

| Unit | Responsibility | Depends on |
|------|----------------|-----------|
| `desktop/main.js` (Electron main) | Read/write `mcpEnabled`; spawn/health-check/kill the sidecar; choose `loadFile()` vs `loadURL()` | bundled per-platform `server` binary |
| `desktop/build-all.mjs` | Cross-compile the backend for `darwin/arm64`, `darwin/amd64`, `windows/amd64` into `desktop/bin/<platform-arch>/`; bundle `Board Database/boards.db` as an unpacked resource | Go toolchain |
| `desktop/preload.js` | Expose `getMcpEnabled` / `setMcpEnabled` IPC (mirrors existing `getLibraryPath`/`setLibraryPath`) | `ipcMain.handle` in `main.js` |
| `SettingsPanel.tsx` | Electron-only "Enable MCP Server" switch, shown when backend isn't reachable; existing Integrations tab takes over once it is | `isElectron()`, new IPC calls |
| `src/backend/mcpserver/*` | **Unchanged.** Same 20 tools, same bridge, same config keys (`mcp_enabled`, `mcp_drive_ui`) | — |
| `databank-store.ts` | Drop the `isElectron()` IPC special-casing for scan/read once the backend is reachable — talk to `/api/...` like the web app | backend HTTP API |

## 4. Lifecycle & gating

- **Launch, `mcpEnabled === false`:** identical to today. `loadFile(webapp/index.html)`, no
  child process, no SQLite files created, zero extra startup cost.
- **Launch, `mcpEnabled === true`:** Electron picks a free loopback port itself (Node's `net`
  module — bind to port 0, read back the assigned port, close the probe socket), spawns the
  bundled `server` binary with `PORT=<that port>`, polls `/api/health` (same boot invariant as
  Docker: healthy within a bounded window or treat as failed), then
  `mainWindow.loadURL('http://127.0.0.1:<port>/')`. `main.go` calls `srv.ListenAndServe()`
  directly with no logging of its bound address and no `PORT=0`-reports-back mechanism, so the
  port must be decided by Electron up front rather than discovered after the fact — this keeps
  the backend genuinely unmodified, which is the point of bundling the existing binary as-is.
- **Toggling live, in Settings:** no full app restart needed.
  - **Turning on:** spawn + health-check, then `mainWindow.loadURL(newOrigin)`.
  - **Turning off:** kill the child process, then `mainWindow.loadFile(webapp/index.html)`.
  - Both paths are a full page navigation either way, so the renderer's in-memory state (open
    tabs, panel layout) is discarded regardless of which direction — a live reload costs no
    more than a restart would have, and avoids making the user quit/reopen the app.
- **Where the toggle lives:** the current Settings ▸ Integrations panel talks to live
  `/api/mcp/*` endpoints (secret, connect-snippets, drive-UI sub-toggle) and is useless before
  a backend exists. `SettingsPanel.tsx` gets a small Electron-only block, gated on
  `isElectron()`, shown whenever the backend isn't currently reachable: just the master
  "Enable MCP Server" switch, backed by `getMcpEnabled`/`setMcpEnabled` IPC, persisted in
  `settings.json` next to `libraryPath`. Once the backend is up, the normal
  Integrations UI (secret, per-client connect cards, status, drive-UI toggle) takes over
  unmodified — it already resolves connect-snippet URLs relative to the page origin, so no
  changes are needed there for the dynamic loopback port.

## 5. Data & packaging

- `DATA_DIR = app.getPath('userData')` — per-install `.mcp-secret`, SQLite DBs, PDF index all
  land in the standard Electron per-user data directory, persisting across app updates the same
  way `settings.json` already does.
- `LIBRARY_DIR = <persisted libraryPath setting>` — reuses the folder the user already picked
  via `select-library-folder`; if unset, the backend behaves as it does today with no library
  configured (empty state, not an error).
- `BOARDDB_PATH = <bundled Board Database/boards.db>` — shipped alongside the binary, same file
  Docker already bundles.
- `STATIC_DIR = <bundled webapp/>` — the existing Vite build output, unchanged.
- The `server` binary must ship as an **unpacked resource**, not inside any asar archive (asar
  cannot execute binaries). `build-all.mjs` gains a cross-compile step
  (`CGO_ENABLED=0 GOOS=<platform> GOARCH=<arch> go build`) that runs alongside the existing
  frontend build/copy step, writing to `desktop/bin/<platform>-<arch>/server[.exe]`; the
  packaging step includes only the binary matching the target being built.
- The macOS Legacy target (Electron 22, Catalina 10.15+) needs its bundled binary
  smoke-tested on actual Catalina — `CGO_ENABLED=0` avoids dynamic-linking surprises, but this
  is a real machine/VM check, not something to assume from cross-compiling successfully.

## 6. Error handling

- **Spawn failure or health-check timeout:** show an error toast, auto-revert `mcpEnabled` to
  `false` in `settings.json`, and fall back to `loadFile()` — a broken backend can never brick
  the next launch.
- **Sidecar crash mid-session:** same crash-restart-with-backoff pattern `main.js` already
  applies to renderer `render-process-gone` events; if retries are exhausted, surface via the
  existing `logFatal` dialog (which already points the user at the crash log file).
- **Port conflicts:** the probe-bind-then-close approach has an inherent (very small) race —
  something else could grab the port between the probe closing and the backend binding it. On
  a single-user desktop loopback this is unlikely; if it happens, the backend fails to bind,
  `/api/health` never responds, and it's handled identically to any other spawn failure (§6,
  first bullet) — auto-revert `mcpEnabled` and fall back to `loadFile()`.

## 7. What changes in the frontend

- `databank-store.ts`: once the backend is reachable, the `isElectron()`-gated IPC branches
  (`scan-library`, `read-library-file`, "reindex disabled on Electron," etc.) become dead code
  for that session — delete them rather than dual-maintain, since the app is now talking to the
  same `/api/...` surface as the web build.
- `SettingsPanel.tsx`: new pre-backend "Enable MCP Server" switch (§4); Settings ▸ Update stays
  hidden on Electron builds unconditionally (Docker-orchestration endpoints don't apply,
  independent of MCP state).
- `electron.d.ts` / `preload.js`: add `getMcpEnabled` / `setMcpEnabled`; the file-dialog,
  library-folder-picker, and "open an arbitrary file outside my library" IPC paths are
  untouched — those are genuinely OS-native concerns, not backend concerns.

## 8. Testing

- Unit: `main.js`'s spawn/health-check/fallback logic (mockable child_process + fetch).
- Manual/E2E: build a local desktop package with the sidecar, verify `claude mcp add` against
  `http://127.0.0.1:<port>/api/mcp` lists and calls tools, mirroring the verification already
  done for the NAS deployment (`project_mcp_server_live_board_bridge` memory).
- Regression: confirm `mcpEnabled=false` launch is byte-for-byte the same startup path as
  today (no child process spawned, no new files under `userData`).

## 9. Out of scope

- **In-app auto-update for desktop** — separate future spec. The existing signed-manifest /
  Docker-socket pipeline doesn't transfer; desktop needs its own mechanism (real code signing,
  an installer format, likely `electron-builder`/`electron-updater`).
- **WebDAV library-sync scheduler on desktop** — explicitly excluded; desktop users point
  directly at a local folder.
- **Headless/background-service backend** (running without the GUI open) — nothing currently
  needs it; the live-board MCP tools require a focused browser tab regardless, since board data
  lives only in renderer memory.
- **Hot-swapping the backend without any page navigation** — not attempted; toggling MCP always
  costs a full page reload, which is accepted as equivalent-to-restart cost, not avoided.
