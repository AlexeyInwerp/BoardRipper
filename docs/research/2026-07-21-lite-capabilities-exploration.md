# Lite build — capability exploration: local-folder library & MCP

**Date:** 2026-07-21
**Status:** Exploration / feasibility only — nothing built. Scoping for a possible follow-up.
**Context:** The lite build (`--mode lite` hosted at ripperdoc.de/boardripper/web, and
`--mode offline` single-file `boardripper-lite.html`) is backend-free. This asks how far two
"main version" capabilities could be brought into it: a **local-folder library** and **MCP**.

---

## TL;DR

| Capability | Pure browser lite build | Verdict |
|---|---|---|
| **Local-folder library** | Yes — Chromium full, Firefox/Safari/offline degraded (still works) | **Feasible, worth building.** Reuses the existing UI + data seam. |
| **MCP server** | No — a browser page cannot listen for connections | **Not feasible in-browser.** Needs a local process → use the Electron desktop app (already does this), or a future tiny bridge binary. |

---

## 1. Local-folder library — FEASIBLE

The Docker version's library scans a mounted folder into SQLite (databank.db) with FTS,
board-DB matching, and dedup — all backend. A browser can't mount a folder, but two web
APIs get most of the way, and the app is already structured to accept a new data source.

### 1.1 The data-source seam already exists

`databankStore._files: DatabankFile[]` has a single mutation point and **two** producers today:
- **Backend:** `fetchFiles()` ← `/api/databank/files`.
- **Electron:** `initElectron()` (databank-store.ts:2023) ← `window.electronAPI.scanLibrary()` over IPC.

`LibraryPanel` renders purely from `useDatabank().files` — it is **source-agnostic**. A local-folder
library is a **third producer** that fills `_files` the same way `initElectron` does. The browse
UI, filtering, file-open (`openLibraryFileById` / `boardStore.loadFiles(File[])`), and the
IndexedDB board cache are reused unchanged.

### 1.2 Picking / reading the folder — two browser APIs

- **Chromium (Chrome/Edge/Opera):** `showDirectoryPicker()` → a live `FileSystemDirectoryHandle`.
  Recursive scan, re-scan on demand, and the handle can be **persisted in IndexedDB** so the
  library survives reload (with a one-click re-grant prompt). This is the full experience.
- **Firefox / Safari / offline `file://`:** `showDirectoryPicker` is unavailable, but
  `<input type="file" webkitdirectory>` returns a one-shot `FileList` of the whole tree and
  **works everywhere, including from `file://`**. Degraded: no persistent handle, no live
  re-scan — the user re-picks the folder each session. Fully functional for browse+open.

Feature-detect: `('showDirectoryPicker' in window)` → live handle; else → `webkitdirectory`.

### 1.3 What you get (P1 — the 80%)

Pick a folder → recursively collect boardview + PDF files → sniff format + parse the board
number from the filename (reuse `parsers/registry` + `apple-boards`/filename heuristics) →
populate `databankStore._files` → the existing Library panel browses by board#/model/filename
and opens files client-side (already works). Persistence via the existing IndexedDB layer;
Chromium additionally persists the folder handle.

**Effort: small–medium.** Greenfield producer + a "Pick library folder" control; everything
downstream reuses.

### 1.4 Gaps vs the Docker library (client-side reimplementation or drop)

- **Board-DB matching** (board# → manufacturer / ODM / family): backend SQLite today. `boards.db`
  is only **2.2 MB** — shippable client-side via **sql.js** (SQLite→WASM, ~1 MB) as a lazy-loaded
  asset, or a pre-exported JSON. Fine for **hosted-lite**; for the **offline single file** it would
  add ~3 MB of base64 to the HTML, so keep it hosted-only (or lazy-fetch, which offline can't do).
  Without it, the bundled `apple-boards.ts` table still gives basic Apple coverage.
- **PDF full-text search:** backend pdfium+FTS5 today. pdf.js already extracts text client-side;
  an in-browser index (IndexedDB + a JS FTS, or sql.js FTS5) could search it. Non-trivial,
  incremental — P3.
- **Dedup, WebDAV library-sync, OBD, self-update:** server/multi-user/cloud concerns — out of
  scope for a personal local-folder library.

### 1.5 Phasing

- **P1 (small–medium):** folder pick (both APIs) → scan → browse → open + IndexedDB persistence.
  No board-DB, no FTS. Works in every browser and in the offline file.
- **P2 (medium):** client board-DB via sql.js + `boards.db` — **hosted-lite only** (bundle size).
- **P3 (medium–large):** client PDF full-text search over pdf.js-extracted text.

### 1.6 Caveats

- Firefox/Safari/offline: re-pick the folder each session (no persistent handle). Acceptable.
- Scanning thousands of files client-side is slower than the Go scanner but fine for typical
  bench folders (hundreds).
- Offline single file: P1 works via `webkitdirectory`; P2/P3 would bloat the one HTML — keep them
  hosted-only.

---

## 2. MCP — NOT feasible in a pure browser

### 2.1 The hard blocker

MCP requires a **server transport** — Streamable HTTP or stdio — i.e. something that *listens*
for incoming connections. A browser page cannot open a listening socket; it can only make
outbound requests. So the lite build **cannot host an MCP endpoint** the way the Go backend's
`/api/mcp` does. This is architectural, not a gap to fill.

(The Docker version's live-board tools work because the *backend* hosts the MCP server and the
browser connects **outbound** over a WebSocket bridge to it — there is always a server on the
other end. Remove the backend and there is nothing to connect to.)

### 2.2 The existing answer: the Electron desktop app

BoardRipper already solves "MCP without the NAS." The **desktop app** bundles the Go backend as
an opt-in loopback sidecar precisely to expose MCP + the live-board bridge
(`docs/specs/2026-07-15-desktop-mcp-backend-sidecar-design.md`). For anyone who wants an agent to
drive their local board, **that is the supported path** — recommend it, don't try to force MCP
into the pure browser build.

### 2.3 Theoretical browser-only paths (all reintroduce a local process)

- **(a) Tiny MCP-bridge companion binary** — extract just `mcpserver` + the WS bridge from the Go
  backend into a small single-binary the user runs; the browser lite build connects **outbound**
  (WS) to it, and it exposes MCP (HTTP) to agents. Feasible (the package already exists) and much
  smaller than the full backend (no databank/PDF-index), but it **is** a local process — so it's
  not "no backend," and the desktop app already integrates the same thing more cleanly.
- **(b) Browser extension + native messaging** — an extension bridges the page to a native MCP
  host. Heavy: install an extension *and* a native host.
- **(c) WebRTC / relay** — the browser connects to a local or public relay; agents connect to the
  relay. Non-standard (agents speak HTTP/stdio, not WebRTC) and needs a relay server.

### 2.4 Conclusion

Pure browser lite build → MCP is impossible (no server socket). Realistic "local MCP" → the
**Electron desktop app** (already built). A browser-first MCP would need a tiny bridge companion
(path a); only worth it if there's real demand, and even then the desktop app is the
better-integrated option.

---

## Recommendation

1. **Local-folder library (P1)** is the genuinely useful, browser-native win — build it if there's
   appetite. Gate the board-DB (P2) and PDF-FTS (P3) enhancements to hosted-lite for bundle reasons.
2. **MCP:** point users to the desktop app; do not attempt it in the pure browser build. Optionally,
   a future standalone MCP-bridge binary if a browser-first workflow is ever demanded.
