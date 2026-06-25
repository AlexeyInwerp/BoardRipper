# Session Restore (reopen boards + PDFs after reload / update) — Design

- **Date:** 2026-06-25
- **Status:** Approved (design); implementation plan to follow
- **Scope:** Reopen the boards and PDFs that were open before a page reload or a post-update reload, gated behind an explicit prompt. Web app is the primary target; Electron and failure modes degrade gracefully.

## Problem

Open boards and PDFs live only in memory (`boardStore._tabs`, `pdfStore._documents`). Any reload — manual or the self-update's `window.location.reload()` — loses them, and the user has to find and reopen each file by hand. They want, after a reload, to be **asked** whether to reopen the previous session or discard it. The ask (not auto-restore) is deliberate: a user often reloads *because* the app hung, and auto-reopening the offending board would re-hang it.

## Current state (verified)

- **Open boards:** `boardStore._tabs: BoardTab[]` (`store/board-store.ts`), each with `id`, `fileName`, `board`, `cacheKey` (= `` `${fileName}:${fileSize}:${lastModified}` ``, set on load), view state, and `pdfFileNames`. `_activeTabId` tracks focus. The source `File` objects sit in an **in-memory-only** `_openFiles: Map<fileName, File>` — gone after reload.
- **Open PDFs:** `pdfStore._documents: Map<string, PdfDocument>`; `PdfDocument` carries `fileName`, `fileSize`, `fileLastModified`, and `fileId?` (set when opened from the databank). `pdfStore.loadFile(file: File, fileId?: number)`.
- **Board cache:** `store/board-cache.ts` — IndexedDB `boardripper-cache`, store `boards`, **last 20** parsed boards. `get(fileName, fileSize, lastModified) → BoardData | null` reconstructs a full board for display **without the original `File`** (parser-version checked; stale → `null`). This is exactly how warm opens render today.
- **Dropped files land in the databank:** `store/incoming-upload.ts` `saveDroppedToIncoming()` POSTs every dropped board/PDF to `POST /api/upload`, which saves it under `<scanRoot>/incoming/{brand}/{model}/` and indexes it (`handlers/files.go` `Upload`), then calls `databankStore.fetchFiles({ force: true })`. So a dropped file becomes a re-fetchable databank entry. Caveats: **skipped in Electron** (`isElectron()` early-return — Electron uses a local scanned folder, not server upload), **best-effort** (read-only library / offline → upload fails), and the upload response does **not** return the new file id.
- **Databank re-fetch:** `databankStore.fetchFileBuffer(file: DatabankFile) → File` (GET `/api/files/path/<path>`), `fileById(id)`, the loaded file list (refreshed after upload).
- **Reload sites:** update path `window.location.reload()` in `updateStore.waitForRestart()`; boot runs `updateStore.resumeIfRestarting()`. No session is persisted today — **all open boards/PDFs are lost on every reload.**
- **Boot / mount:** `App.tsx` mounts overlays (`<WelcomeSetup/>`, `<UpdateProgressOverlay/>`); `databankStore.ensureLoaded()` runs in a mount effect.

## Goals

- After a reload (manual **or** post-update), if a session was open, show a prompt: **Reopen** or **Discard**.
- Reopen restores the previously-open **boards and PDFs** and re-activates the board tab that was focused.
- **Never auto-restore** — the prompt appears before anything loads, so a hang-causing board can't re-hang on boot.
- Survive a hard hang/crash, not just a clean unload.
- Degrade gracefully: restore everything resolvable; clearly list what isn't.

## Non-goals

- Per-board **view state** (selection, top/bottom/butterfly side, zoom/pan) — restore opens a fresh view. ("Just reopen + active tab.")
- Re-**binding** a restored PDF to its board (PDFs reopen as panels only).
- Restoring **local-drop PDFs in Electron**, or files whose `incoming/` upload failed or that aged out of the 20-board cache — these are reported as unavailable, not reconstructed.
- Any new server-side state — session lives entirely in the browser's `localStorage`.

## Design

### Session record + continuous persistence

A new `store/session-store.ts` owns a single `localStorage` key **`boardripper-session`** holding:

```ts
interface SessionEntry {
  kind: 'board' | 'pdf';
  fileName: string;
  fileSize: number;
  fileLastModified: number;
  fileId?: number;     // present for databank-opened items (PDFs always; boards if known)
  active?: boolean;    // the focused board tab (one board entry at most)
}
interface SavedSession { version: 1; savedAt: number; entries: SessionEntry[] }
```

The store **mirrors the open set continuously** (not only on `beforeunload`): it subscribes to `boardStore` and `pdfStore` change events and, **debounced ~500 ms**, rewrites `boardripper-session` from the current `_tabs` + `_documents`. Continuous persistence is what makes a hard hang/crash recoverable. The cache-key triple (`fileName`, `fileSize`, `fileLastModified`) is sourced per board from the tab (board-store exposes the triple — derived from `cacheKey` / the open `File`), and per PDF from its `PdfDocument`. A `beforeunload` flush is added as a belt-and-suspenders final write.

Capture rules: only boards/PDFs with a usable identity are recorded. An empty open set writes an empty `entries: []` (which suppresses the prompt). `version` guards future format changes.

### Restore resolution (one resolver per entry)

On Reopen, after `databankStore.ensureLoaded()`, each entry resolves in order:

**Board** —
1. `fileId` set and `databankStore.fileById(fileId)` exists → `fetchFileBuffer` → `boardStore.loadFile(file)`.
2. else `databankStore.findFileByName(fileName, fileSize)` (new resolver; matches the refreshed databank list incl. `incoming/`, disambiguating same-name files by size) → `fetchFileBuffer` → `loadFile`.
3. else `boardCache.get(fileName, fileSize, fileLastModified)` → if hit, `boardStore.loadFromCache(fileName, fileSize, fileLastModified, board)` (new path: display the cached `BoardData` without an `_openFiles` entry — re-parse simply won't be available until the file is re-dropped).
4. else → **unavailable**.

**PDF** —
1. `fileId` set and resolvable → `fetchFileBuffer` → `pdfStore.loadFile(file, fileId)`.
2. else `findFileByName(fileName, fileSize)` (covers dropped PDFs now in `incoming/`) → `fetchFileBuffer` → `pdfStore.loadFile(file, fileId)`.
3. else → **unavailable** (no PDF binary cache exists).

After all entries resolve, the board tab whose entry had `active: true` is focused. Failures are collected and surfaced in one summary toast (e.g. *"Reopened 3 boards, 1 PDF · 1 file unavailable — re-drop it"*).

### Prompt UX

A new `components/SessionRestorePrompt.tsx` mounts from `App.tsx` (beside the existing overlays). On boot it reads `boardripper-session`; if `entries` is non-empty it renders a modal:

> **Reopen your last session?** *N board(s) and M PDF(s) were open.* **[Reopen] [Discard]**

- **Reopen** → run the resolver over all entries, then dismiss. The reopened items re-persist as the new session (so a later reload offers them again).
- **Discard** → clear `boardripper-session` and dismiss. (This is the escape hatch for the "it hung" case.)
- The modal is **non-blocking-safe**: nothing loads until the user chooses, so a hang-causing board never reloads automatically.

Suppress the prompt when `entries` is empty or the key is absent.

### Update vs. manual reload

Identical. The session is already on disk (continuous persistence), independent of *why* the page reloaded. After a self-update, the existing `<UpdateProgressOverlay/>` runs its course; once the app is back up the restore prompt appears like any other reload. No coupling to the update restart-flag is needed.

### New/changed units

- **`store/session-store.ts`** (new): subscribe + debounce + persist; `readSession()`, `clearSession()`, `restoreSession()` (the resolver + active-tab focus + summary toast). One clear responsibility: own `boardripper-session`.
- **`components/SessionRestorePrompt.tsx`** (new): the modal; reads `readSession()`, calls `restoreSession()` / `clearSession()`.
- **`store/board-store.ts`**: expose the per-tab cache-key triple for capture; add **`loadFromCache(fileName, fileSize, fileLastModified, board)`** — open a tab directly from a cached `BoardData` (no `_openFiles` entry). Emit on tab open/close/activate (it already does).
- **`store/databank-store.ts`**: add **`findFileByName(fileName, fileSize?) → DatabankFile | null`** over the loaded file list.
- **`App.tsx`**: mount `<SessionRestorePrompt/>`; ensure `session-store` is initialized (subscriptions wired) at boot.

## Edge cases

- **Hang on a board:** prompt-first means no board loads until the user picks; Discard avoids the re-hang loop entirely.
- **Electron drop / upload failed / aged out of cache:** entry resolves to *unavailable* → reported in the summary toast; the rest still reopen. Boards still try the IndexedDB cache; PDFs have no binary fallback.
- **File deleted from the library since last session:** databank lookup misses → board falls back to cache, PDF is unavailable.
- **Stale cache (parser bumped):** `boardCache.get` returns `null` for an old `parserVersion` → that board falls back to databank re-fetch (re-parse) or unavailable.
- **Duplicate filenames in the databank:** `findFileByName` disambiguates by `fileSize`; if still ambiguous, pick the first and proceed (acceptable for v1).
- **Reopen re-triggers persistence:** expected — the reopened set becomes the current session.
- **Empty session:** no prompt.

## Testing

- **Unit (session-store):** capture produces the right `entries` from a fake board/PDF store; debounce coalesces rapid changes; `beforeunload` flush writes; empty set → `entries: []`. Resolver: databank-hit path, name-match path, cache-fallback path, and unavailable path each produce the expected calls (with fakes for `databankStore`/`boardCache`/`pdfStore`).
- **Playwright (web):** open two library boards + one library PDF → reload → prompt shows the right counts → **Reopen** → both boards + the PDF are back and the previously-active board is focused. Separately: **Discard** → nothing reopens and the key is cleared. Geometry-assert the modal (in-viewport), per the project's floating-UI rule.
- **Manual/dev note:** drop-then-reload (incoming round-trip) and post-update reload are validated on the dev instance, since they depend on a live backend + library.

## Rollout

- Frontend-only; additive. New `localStorage` key `boardripper-session`. No schema migration, no backend change (reuses `/api/upload`, `/api/files/path`, the databank list, and the board cache). Version bump at release time (out of scope here).
