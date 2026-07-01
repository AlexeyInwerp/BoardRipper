# Library / Bench / Folders Restructure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorder the Library filter above its stats, turn the "Donor boards" tab into an extensible "Bench" tab (Donor boards / Worklists / Device DB), and make Folders DB-only with a per-branch filesystem rescan button.

**Architecture:** Three localized changes. Backend gains a subtree-scoped scan (`Scanner.ScanFolderAsync` + `POST /api/databank/scan/folder`). Frontend adds `databankStore.benchView` + `databankStore.scanFolder`, a `worklistStore.listAllStored()` IndexedDB catalog read, a shared `ensureDatabaseEditorPanel()` helper, and reworks `LibraryPanel` render order + Bench switcher + Folders tree. The live-filesystem browser is removed.

**Tech Stack:** Go (net/http stdlib, database/sql, SQLite) backend; React 19 + TypeScript + Vite frontend; `useSyncExternalStore` stores; `@tabler/icons-react`; Playwright E2E; Go `testing`.

## Global Constraints

- TypeScript strict mode; PascalCase React components, camelCase functions/vars.
- Logging: use scoped loggers from `store/log-store.ts` (`log.ui.*`, `log.scan.*`, `log.cache.*`) — never raw `console.log`. Backend: `log.Printf` as existing scanner code does.
- No decorative UI: no emojis/invented glyphs/decorative colors/bold in functional UI. Reuse existing CSS tokens (`var(--accent)`, `var(--border)`, `var(--bg-*)`, `var(--text-*)`). Keep new CSS minimal; survey `index.css` before adding.
- Coordinates/units unchanged; no parser changes → do NOT bump `PARSER_VERSION`.
- Commit before deleting any significant code block (the `LiveBrowser` deletion in Task 9 has its own pre-commit).
- Scans are a **singleton** (one global `Scanner.status`/`activeOp`); the subtree scan reuses that singleton — never add a second concurrent scan path.
- Frontend E2E lives in `src/frontend/tests/`; run with `cd src/frontend && npx playwright test <spec>`. Backend tests: `cd src/backend && go test ./databank/... ./handlers/...`.

---

## Task 1: Backend — subtree-scoped scan (`Scanner.ScanFolderAsync`)

**Files:**
- Modify: `src/backend/databank/scanner.go` (`scanWorker` signature + walk root + scoped delete; add `ScanFolderAsync`, `pathUnderScope`, `safeResolve`; update `Scan`/`ScanAsync` callers)
- Test: `src/backend/databank/scanner_folder_test.go` (create)

**Interfaces:**
- Produces: `func (s *Scanner) ScanFolderAsync(rel string) (ScanStatus, error)` — starts a background scan scoped to the library-relative folder `rel`; returns `409`-style error (`operation … already running`) if a scan is active, or an error if `rel` escapes the scan root.
- Produces: helper `func pathUnderScope(path, scope string) bool` (scope `""` ⇒ all).
- Consumes: existing `Scanner` internals (`scanWorker`, `ScanRoot`, `db.AllFilePaths`, `db.DeleteFile`, `finishScan`).

- [ ] **Step 1: Write the failing test**

Create `src/backend/databank/scanner_folder_test.go`:

```go
package databank

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// waitScanIdle polls until no scan op is active (or the deadline passes).
func waitScanIdle(t *testing.T, s *Scanner) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if !s.Status().Running {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("scan did not finish within 5s")
}

func writeFile(t *testing.T, root, rel string) {
	t.Helper()
	p := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
}

// A scoped scan must only touch rows under the scoped prefix: it picks up a new
// file inside the branch and deletes a removed file inside the branch, while a
// file OUTSIDE the branch that is missing from disk-under-scope must NOT be
// deleted.
func TestScanFolderAsyncScopesInsertsAndDeletes(t *testing.T) {
	dir := t.TempDir()
	db := openTestDB(t) // see note below
	s := NewScanner(db, dir, dir)

	// Seed disk: alpha/ has one file, beta/ has one file.
	writeFile(t, dir, "alpha/a1.brd")
	writeFile(t, dir, "beta/b1.brd")

	// Full scan to populate DB with both.
	s.Scan()
	if got := countFiles(t, db); got != 2 {
		t.Fatalf("after full scan: want 2 files, got %d", got)
	}

	// Mutate disk under alpha/ only: add a2, remove a1. beta/ untouched.
	writeFile(t, dir, "alpha/a2.brd")
	if err := os.Remove(filepath.Join(dir, "alpha/a1.brd")); err != nil {
		t.Fatal(err)
	}

	if _, err := s.ScanFolderAsync("alpha"); err != nil {
		t.Fatalf("ScanFolderAsync: %v", err)
	}
	waitScanIdle(t, s)

	paths := allPaths(t, db)
	if paths["alpha/a1.brd"] {
		t.Error("alpha/a1.brd should have been deleted by the scoped scan")
	}
	if !paths["alpha/a2.brd"] {
		t.Error("alpha/a2.brd should have been inserted by the scoped scan")
	}
	if !paths["beta/b1.brd"] {
		t.Error("beta/b1.brd is outside the scope and must NOT be deleted")
	}
}

func TestScanFolderAsyncRejectsEscape(t *testing.T) {
	dir := t.TempDir()
	db := openTestDB(t)
	s := NewScanner(db, dir, dir)
	if _, err := s.ScanFolderAsync("../../etc"); err == nil {
		t.Fatal("expected escape rejection, got nil error")
	}
}
```

Note on helpers: check `scanner_test.go` (or sibling `*_test.go` in this package) for an existing DB-open test helper. If `openTestDB`, `countFiles`, `allPaths` do not already exist, add them to this file:

```go
func openTestDB(t *testing.T) *DB {
	t.Helper()
	db, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func countFiles(t *testing.T, db *DB) int {
	t.Helper()
	m, err := db.AllFilePaths()
	if err != nil {
		t.Fatal(err)
	}
	return len(m)
}

func allPaths(t *testing.T, db *DB) map[string]bool {
	t.Helper()
	m, err := db.AllFilePaths()
	if err != nil {
		t.Fatal(err)
	}
	out := make(map[string]bool, len(m))
	for p := range m {
		out[p] = true
	}
	return out
}
```

(If `DB` has no `Close()`, drop the `t.Cleanup`. Verify `Open`'s signature in `databank/db.go` and adjust the helper to match — it is `Open(dataDir string) (*DB, error)`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src/backend && go test ./databank/ -run TestScanFolderAsync -v`
Expected: FAIL — `s.ScanFolderAsync undefined` (compile error).

- [ ] **Step 3: Change `scanWorker` to accept a scope**

In `src/backend/databank/scanner.go`, change the signature:

```go
func (s *Scanner) scanWorker(cancel <-chan struct{}, scope string) {
```

Immediately after `scanRoot := s.ScanRoot()` (~L346), compute the walk root:

```go
	scanRoot := s.ScanRoot()
	walkRoot := scanRoot
	if scope != "" {
		walkRoot = filepath.Join(scanRoot, scope)
	}
	log.Printf("Scanner: scanning %s (scope=%q)", walkRoot, scope)
```

Change the walk call from `filepath.Walk(scanRoot, …)` to `filepath.Walk(walkRoot, …)` (the `relPath` inside still uses `filepath.Rel(scanRoot, path)`, so paths remain library-relative — do NOT change that line).

- [ ] **Step 4: Scope the delete-reconcile loop (critical)**

In Phase 4 (~L564), gate deletions to the scope so a scoped scan never deletes rows outside its branch:

```go
		for path, rec := range existing {
			if !seen[path] {
				if !pathUnderScope(path, scope) {
					continue
				}
				if err := s.db.DeleteFile(rec.ID); err != nil {
					log.Printf("Scanner: delete error for %s: %v", path, err)
					atomic.AddInt64(&errors, 1)
					continue
				}
				atomic.AddInt64(&deleted, 1)
			}
		}
```

Skip the global dedup + auto-bind phases for a scoped refresh (they operate library-wide and defeat the "fast targeted refresh" intent). Wrap Phase 5 + Phase 6 in `if scope == "" {`:

```go
		if scope == "" {
			// Phase 5: Hash size-colliding files … (existing dedup block)
			s.mu.Lock()
			s.status.Phase = "Finding duplicates"
			s.mu.Unlock()
			s.dedupSizeCollisions(cancelled)

			// Phase 6: Auto-match … (existing auto_bind block)
			if !cancelled() {
				if v, _ := s.db.GetConfig("auto_bind"); v == "true" {
					s.mu.Lock()
					s.status.Phase = "Auto-matching bindings"
					s.mu.Unlock()
					s.autoMatchBindings()
				}
			}
		}
```

- [ ] **Step 5: Add the scope helper + `ScanFolderAsync` + `safeResolve`**

Add near `ScanAsync` (after `Scan`, ~L319):

```go
// pathUnderScope reports whether a library-relative path lives within scope.
// scope "" means the whole library (every path qualifies).
func pathUnderScope(path, scope string) bool {
	if scope == "" {
		return true
	}
	return path == scope || strings.HasPrefix(path, scope+"/")
}

// safeResolve validates a library-relative path and returns its cleaned,
// forward-slash form. Rejects paths that escape the scan root (symlink-aware,
// mirrors BrowseDir's guard).
func (s *Scanner) safeResolve(relPath string) (string, error) {
	root := s.ScanRoot()
	clean := filepath.Clean(relPath)
	if clean == "." {
		clean = ""
	}
	abs := filepath.Join(root, clean)
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", fmt.Errorf("resolve path: %w", err)
	}
	resolvedRoot, _ := filepath.EvalSymlinks(root)
	rel, err := filepath.Rel(resolvedRoot, resolved)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path escapes scan root")
	}
	return filepath.ToSlash(clean), nil
}

// ScanFolderAsync starts a background scan scoped to one library-relative
// folder subtree. Reuses the singleton scan status, so it conflicts with any
// other running scan.
func (s *Scanner) ScanFolderAsync(rel string) (ScanStatus, error) {
	scope, err := s.safeResolve(rel)
	if err != nil {
		return ScanStatus{}, err
	}
	if scope == "" {
		// Empty scope would be a full scan; callers must target a real branch.
		return ScanStatus{}, fmt.Errorf("empty folder scope")
	}
	s.mu.Lock()
	if s.activeOp != "" {
		st := s.status
		s.mu.Unlock()
		return st, fmt.Errorf("operation %q already running", s.activeOp)
	}
	s.activeOp = "file"
	s.status = ScanStatus{Running: true}
	done := make(chan struct{})
	s.cancelCh = done
	s.cancelFn = func() { close(done) }
	s.mu.Unlock()

	go func() { s.scanWorker(done, scope) }()
	return s.Status(), nil
}
```

- [ ] **Step 6: Update the two existing `scanWorker` callers**

`ScanAsync` (~L289): `go func() { s.scanWorker(done) }()` → `go func() { s.scanWorker(done, "") }()`
`Scan` (~L317): `s.scanWorker(nil)` → `s.scanWorker(nil, "")`

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd src/backend && go test ./databank/ -run TestScanFolder -v`
Expected: PASS (both `TestScanFolderAsyncScopesInsertsAndDeletes` and `TestScanFolderAsyncRejectsEscape`).
Then `go build ./...` — Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/backend/databank/scanner.go src/backend/databank/scanner_folder_test.go
git commit -m "feat(scanner): subtree-scoped ScanFolderAsync (per-branch refresh)"
```

---

## Task 2: Backend — `POST /api/databank/scan/folder` handler

**Files:**
- Modify: `src/backend/handlers/databank.go` (add `ScanFolder` method)
- Modify: `src/backend/main.go` (register the route)
- Test: `src/backend/handlers/databank_scanfolder_test.go` (create)

**Interfaces:**
- Consumes: `Scanner.ScanFolderAsync(rel string) (ScanStatus, error)` (Task 1).
- Produces: `POST /api/databank/scan/folder` with JSON body `{"path":"alpha/beta"}` → `200` + `ScanStatus` JSON; `409` if a scan is running; `400` on empty/escaping path.

- [ ] **Step 1: Write the failing test**

Create `src/backend/handlers/databank_scanfolder_test.go`. Model the setup on the existing `databank_donors_test.go` (same package, same handler construction). Minimal shape:

```go
package handlers

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestScanFolderEmptyPath400(t *testing.T) {
	h := newTestDatabankHandler(t) // reuse the helper used by databank_donors_test.go
	rec := httptest.NewRecorder()
	h.ScanFolder(rec, httptest.NewRequest("POST", "/api/databank/scan/folder", strings.NewReader(`{"path":""}`)))
	if rec.Code != 400 {
		t.Fatalf("empty path: want 400, got %d", rec.Code)
	}
}
```

Check `databank_donors_test.go` for the exact handler-construction helper name (e.g. a local `newTestDatabankHandler` or inline `&DatabankHandler{…}`). If none is factored out, construct the handler inline exactly as that test does and call `h.ScanFolder(...)`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src/backend && go test ./handlers/ -run TestScanFolderEmptyPath400 -v`
Expected: FAIL — `h.ScanFolder undefined`.

- [ ] **Step 3: Add the handler**

In `src/backend/handlers/databank.go`, after `Scan` (~L83), add:

```go
// ScanFolder starts a filesystem rescan scoped to one library-relative folder
// subtree (POST body {"path":"…"}). Reuses the singleton scan status.
func (h *DatabankHandler) ScanFolder(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "Invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(body.Path) == "" {
		http.Error(w, "path is required", http.StatusBadRequest)
		return
	}
	status, err := h.scanner.ScanFolderAsync(body.Path)
	if err != nil {
		if strings.Contains(err.Error(), "already running") {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(status)
}
```

Confirm `strings` is already imported in `databank.go` (it is used elsewhere in the file; if not, add it).

- [ ] **Step 4: Register the route**

In `src/backend/main.go`, next to the existing scan routes (~L149):

```go
	mux.HandleFunc("POST /api/databank/scan/folder", dbHandler.ScanFolder)
```

- [ ] **Step 5: Run the test + build**

Run: `cd src/backend && go test ./handlers/ -run TestScanFolderEmptyPath400 -v` → PASS
Run: `cd src/backend && go build ./...` → no errors

- [ ] **Step 6: Commit**

```bash
git add src/backend/handlers/databank.go src/backend/main.go src/backend/handlers/databank_scanfolder_test.go
git commit -m "feat(api): POST /api/databank/scan/folder — per-branch rescan endpoint"
```

---

## Task 3: Frontend — `databankStore.benchView` state

**Files:**
- Modify: `src/frontend/src/store/databank-store.ts` (field, getter, setter)
- Modify: `src/frontend/src/hooks/useDatabank.ts` (snapshot field)

**Interfaces:**
- Produces: `type BenchViewId = 'donors' | 'worklists' | 'devicedb'`; `databankStore.benchView: BenchViewId`; `databankStore.setBenchView(v: BenchViewId): void` (persisted to `localStorage['boardripper-library-bench-view']`); snapshot key `benchView`.

- [ ] **Step 1: Add the type + field + getter**

In `databank-store.ts`, near the top-level exported types (next to `ViewMode`, L202) add:

```ts
export type BenchViewId = 'donors' | 'worklists' | 'devicedb';
```

Add the private field next to `_browseMode` (~L385):

```ts
  private _benchView: BenchViewId = (() => {
    try { return (localStorage.getItem('boardripper-library-bench-view') as BenchViewId) || 'donors'; }
    catch { return 'donors' as const; }
  })();
```

Add the getter next to `get browseMode()` (~L443):

```ts
  get benchView() { return this._benchView; }
```

- [ ] **Step 2: Add the setter**

Next to `setBrowseMode` (~L1734):

```ts
  setBenchView(v: BenchViewId) {
    this._benchView = v;
    try { localStorage.setItem('boardripper-library-bench-view', v); } catch { /* ignore */ }
    this.notify();
  }
```

- [ ] **Step 3: Add to the reactive snapshot**

In `src/frontend/src/hooks/useDatabank.ts`, add to the `DatabankSnapshot` interface (near `browseMode`, L31):

```ts
  benchView: import('../store/databank-store').BenchViewId;
```

(Or add `BenchViewId` to the existing type import on L3 and use it bare.) Then add to the snapshot factory (near L66):

```ts
  benchView: databankStore.benchView,
```

- [ ] **Step 4: Verify it type-checks**

Run: `cd src/frontend && npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/store/databank-store.ts src/frontend/src/hooks/useDatabank.ts
git commit -m "feat(library): benchView store state for the Bench tab switcher"
```

---

## Task 4: Frontend — `worklistStore.listAllStored()` catalog read

**Files:**
- Modify: `src/frontend/src/store/worklist-store.ts` (add `listAllStored`)
- Test: `src/frontend/tests/worklist-list-all.spec.ts` (create — Playwright, runs in a real browser with IndexedDB)

**Interfaces:**
- Produces: `worklistStore.listAllStored(): Promise<BoardWorklistes[]>` — every persisted per-board record (IndexedDB `boardripper-worklist` → `boards` store), unsorted.

- [ ] **Step 1: Write the failing test**

Create `src/frontend/tests/worklist-list-all.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

// listAllStored returns every persisted per-board worklist record.
test('worklistStore.listAllStored returns all seeded records', async ({ page }) => {
  // Seed the worklist IndexedDB before app code runs.
  await page.addInitScript(() => {
    const req = indexedDB.open('boardripper-worklist', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('boards')) db.createObjectStore('boards', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('boards', 'readwrite');
      const store = tx.objectStore('boards');
      store.put({ key: 'boardA:1:1', fileName: 'A.brd', activeWorklistId: null,
        worklistes: [{ id: 'w1', name: 'Case 1', createdAt: 1, updatedAt: 2, entries: [], netEntries: [] }],
        updatedAt: 2, schemaVersion: 1 });
      store.put({ key: 'boardB:1:1', fileName: 'B.brd', activeWorklistId: null,
        worklistes: [], updatedAt: 3, schemaVersion: 1 });
    };
  });

  await page.goto('/');
  const count = await page.evaluate(async () => {
    const s = (window as unknown as { __worklistStore: { listAllStored: () => Promise<unknown[]> } }).__worklistStore;
    const all = await s.listAllStored();
    return all.length;
  });
  expect(count).toBe(2);
});
```

(The store is exposed as `window.__worklistStore` in dev — see `worklist-store.ts` L1057.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src/frontend && npx playwright test worklist-list-all.spec.ts --reporter=list`
Expected: FAIL — `s.listAllStored is not a function`.

- [ ] **Step 3: Implement `listAllStored`**

In `worklist-store.ts`, next to `loadFromDb` (~L216) add:

```ts
  /** All persisted per-board worklist records (the Bench "Worklists" catalog).
   *  Read-only snapshot straight from IndexedDB; does not touch the live cache. */
  async listAllStored(): Promise<BoardWorklistes[]> {
    try {
      const db = await this.openDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = () => resolve((req.result as BoardWorklistes[] | undefined) ?? []);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      log.cache?.warn('worklist: listAllStored failed', e);
      return [];
    }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src/frontend && npx playwright test worklist-list-all.spec.ts --reporter=list`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/store/worklist-store.ts src/frontend/tests/worklist-list-all.spec.ts
git commit -m "feat(worklist): listAllStored() — catalog of every locally-stored worklist"
```

---

## Task 5: Frontend — shared `ensureDatabaseEditorPanel()` helper

**Files:**
- Modify: `src/frontend/src/store/dockview-api.ts` (add exported helper)
- Modify: `src/frontend/src/panels/SettingsPanel.tsx` (call the shared helper; drop the local copy)

**Interfaces:**
- Produces: `export function ensureDatabaseEditorPanel(): void` in `dockview-api.ts` — opens or focuses the singleton `database-editor` panel.
- Consumes: existing `getDockviewApi()` in `dockview-api.ts`.

- [ ] **Step 1: Add the helper to `dockview-api.ts`**

Append near the other `ensure*Panel` helpers:

```ts
/** Open (or focus, if already open) the read-only Database Editor panel.
 *  Stable id so repeated calls reactivate instead of stacking duplicates. */
export function ensureDatabaseEditorPanel(): void {
  try {
    const api = getDockviewApi();
    if (!api) return;
    const id = 'database-editor';
    const existing = api.getPanel(id);
    if (existing) { existing.api.setActive(); return; }
    api.addPanel({ id, component: 'databaseEditor', title: 'Database Editor' });
  } catch (err) {
    log.ui.error('Failed to open Database Editor panel:', err);
  }
}
```

Confirm `log` is imported in `dockview-api.ts`; if not, add `import { log } from './log-store';`.

- [ ] **Step 2: Point `SettingsPanel` at the shared helper**

In `src/frontend/src/panels/SettingsPanel.tsx`: delete the local `openDatabaseEditor` function (L846-866). Add `ensureDatabaseEditorPanel` to the existing `dockview-api` import (L27). Replace the call site (the Database Editor button `onClick`) `openDatabaseEditor()` → `ensureDatabaseEditorPanel()`.

- [ ] **Step 3: Verify type-check + no dead references**

Run: `cd src/frontend && npx tsc -b --noEmit`
Expected: no errors (no remaining `openDatabaseEditor` references).

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/store/dockview-api.ts src/frontend/src/panels/SettingsPanel.tsx
git commit -m "refactor(dockview): share ensureDatabaseEditorPanel() between Settings and Bench"
```

---

## Task 6: Frontend — `databankStore.scanFolder()` + remove Live browse

**Files:**
- Modify: `src/frontend/src/store/databank-store.ts` (add `scanFolder`; remove `_browseMode`/`_browseResult`/`_browsing`, `browse`, `setBrowseMode` and their getters)
- Modify: `src/frontend/src/hooks/useDatabank.ts` (remove `browseMode`/`browseResult`/`browsing` from the snapshot)

**Interfaces:**
- Produces: `databankStore.scanFolder(path: string): Promise<void>` — POSTs `/api/databank/scan/folder`, starts scan-status polling, then refreshes the folder tree on completion. On `409` it logs and no-ops (a scan is already running).
- Removes: `browseMode`, `browseResult`, `browsing`, `setBrowseMode`, `browse`.

- [ ] **Step 1: Add `scanFolder`**

In `databank-store.ts`, near `setBrowseMode` / the scan methods. Reuse the existing scan-status polling method the store already uses after a full scan (find it: `grep -n "scan/status\|startScanPolling\|pollScan" databank-store.ts`; the full-scan trigger method calls it — reuse the same one, referred to below as `startScanPolling()`; if the method has a different name, use that name):

```ts
  /** Rescan a single library-relative folder subtree on the backend, then
   *  refresh the folder tree so the DB view reflects added/removed files.
   *  No-ops (logs) if a scan is already running (backend returns 409). */
  async scanFolder(path: string): Promise<void> {
    try {
      const res = await fetch('/api/databank/scan/folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      if (res.status === 409) {
        log.scan.warn('scanFolder: a scan is already running', path);
        return;
      }
      if (!res.ok) {
        log.scan.warn('scanFolder failed', path, res.status);
        return;
      }
      this.startScanPolling(); // reuse the existing full-scan status poller
    } catch (e) {
      log.scan.warn('scanFolder error', path, e);
    }
  }
```

After the poller observes the scan finished, the store already refreshes the tree the same way a full scan does — confirm by reading the poller; if the poller does NOT refresh `fetchTree` on completion, add a `void this.fetchTree({ force: true });` call in the poller's terminal branch (guard so it only fires when a scan actually ran). Use the tree-fetch method name the store already exposes (`grep -n "fetchTree\|folderTree" databank-store.ts`).

- [ ] **Step 2: Remove the Live-browse surface**

Delete from `databank-store.ts`: `_browseMode` (L385-388), `_browseResult` (L389), `_browsing` (L390), the getters `browseMode`/`browseResult`/`browsing` (L443-445), `setBrowseMode` (L1729-1734), and the `browse(...)` method (`grep -n "browse(" databank-store.ts` to find it). Remove any now-unused `BrowseResult` import if nothing else references it (leave it if `BrowseEntry`/`BrowseResult` types are still used elsewhere).

- [ ] **Step 3: Remove from the snapshot**

In `useDatabank.ts` delete the `browseMode`, `browseResult`, `browsing` entries from both the `DatabankSnapshot` interface (L31-33) and the factory (L66-68).

- [ ] **Step 4: Verify type-check**

Run: `cd src/frontend && npx tsc -b --noEmit`
Expected: errors ONLY in `LibraryPanel.tsx` (it still destructures `browseMode`/`browseResult`/`browsing` and references `LiveBrowser`). Those are fixed in Tasks 8–9. To keep this commit green, do Step 5 first if you are committing per-task; otherwise proceed and let Task 9 restore green. **Recommended:** land Tasks 6, 8, 9 before the next `tsc` gate, or temporarily leave `browseMode` reads until Task 9. To keep each commit compiling, KEEP `setBrowseMode`/`browse` deletion for Task 9 and in THIS task only ADD `scanFolder` + the snapshot `benchView` already added; move the Live removal (Step 2/3) into Task 9.

> **Decision (locks the split):** `scanFolder` is added here (Task 6); ALL Live-removal (store fields, getters, `setBrowseMode`, `browse`, snapshot keys, panel pill, `LiveBrowser`) happens atomically in **Task 9** so no intermediate commit fails `tsc`. Do only Step 1 in Task 6.

- [ ] **Step 5 (Task 6 scope = Step 1 only): Verify + commit**

Run: `cd src/frontend && npx tsc -b --noEmit` → no errors.

```bash
git add src/frontend/src/store/databank-store.ts
git commit -m "feat(library): databankStore.scanFolder() — trigger per-branch rescan"
```

---

## Task 7: Frontend — Part 1: search above stats + accent

**Files:**
- Modify: `src/frontend/src/panels/LibraryPanel.tsx` (reorder blocks; add `IconSearch`)
- Modify: `src/frontend/src/index.css` (`.library-search`, `.library-search-input`)
- Test: `src/frontend/tests/library-search-order.spec.ts` (create)

**Interfaces:** none exported.

- [ ] **Step 1: Write the failing test**

Create `src/frontend/tests/library-search-order.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

// On a filter-bearing tab, the search input must appear ABOVE the stats bar.
test('library filter input precedes the stats bar in DOM order', async ({ page }) => {
  await page.goto('/');
  // The Library panel is in the sidebar; the filter renders on default (history) tab.
  const search = page.locator('.library-search-input').first();
  const stats = page.locator('.library-statsbar').first();
  await expect(search).toBeVisible();
  await expect(stats).toBeVisible();
  const order = await page.evaluate(() => {
    const s = document.querySelector('.library-search');
    const st = document.querySelector('.library-statsbar');
    if (!s || !st) return 'missing';
    // Node.DOCUMENT_POSITION_FOLLOWING (4) set on st means st comes AFTER s.
    return (s.compareDocumentPosition(st) & Node.DOCUMENT_POSITION_FOLLOWING) ? 'search-first' : 'stats-first';
  });
  expect(order).toBe('search-first');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src/frontend && npx playwright test library-search-order.spec.ts --reporter=list`
Expected: FAIL — currently `stats-first`.

- [ ] **Step 3: Reorder the blocks**

In `LibraryPanel.tsx`, move the `{/* Filter … */}` block (L890-914) to directly ABOVE the `{/* Stats … */}` block, so the order becomes: tabs-row → filter → `{statsBar}`. Concretely: cut the whole `{viewMode !== 'search' && viewMode !== 'bench' && ( … )}` filter block and paste it immediately after the tabs-row closing `</div>` (before the stats comment + `{statsBar}`).

- [ ] **Step 4: Add the search icon**

Add `IconSearch` to the tabler import (L12): `import { IconStack2, IconHistory, IconFolder, IconPin, IconPinFilled, IconSettings, IconChevronsUp, IconSearch } from '@tabler/icons-react';`

Inside `.library-search`, before the `<input>`, add:

```tsx
          <IconSearch size={13} className="library-search-icon" aria-hidden />
```

- [ ] **Step 5: Update the CSS (accent-tinted resting border + icon)**

In `index.css`, replace the `.library-search-input` + `:focus` rules (L5261-5274) with:

```css
.library-search-input {
  flex: 1;
  background: var(--bg-secondary);
  border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border));
  border-radius: 3px;
  color: var(--text-primary);
  padding: 3px 6px;
  font-size: 11px;
  outline: none;
}

.library-search-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
}

.library-search-icon {
  flex-shrink: 0;
  color: color-mix(in srgb, var(--accent) 70%, var(--text-secondary));
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd src/frontend && npx playwright test library-search-order.spec.ts --reporter=list`
Expected: PASS.
Run: `cd src/frontend && npx tsc -b --noEmit` → no errors.

- [ ] **Step 7: Commit**

```bash
git add src/frontend/src/panels/LibraryPanel.tsx src/frontend/src/index.css src/frontend/tests/library-search-order.spec.ts
git commit -m "feat(library): filter above stats + accent-visible search field"
```

---

## Task 8: Frontend — Part 2: Bench tab (rename + variant switcher)

**Files:**
- Modify: `src/frontend/src/panels/LibraryPanel.tsx` (tab label; `BENCH_VIEWS`; switcher; wrap donor list as `donors`; add `worklists` + `devicedb` variants)
- Modify: `src/frontend/src/index.css` (Bench switcher + worklist catalog rows)
- Test: `src/frontend/tests/bench-tab.spec.ts` (create)

**Interfaces:**
- Consumes: `databankStore.benchView` / `setBenchView` (Task 3); `worklistStore.listAllStored()` (Task 4); `ensureDatabaseEditorPanel()` (Task 5).

- [ ] **Step 1: Write the failing test**

Create `src/frontend/tests/bench-tab.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

test('Bench tab is labelled "Bench" and switches variants', async ({ page }) => {
  await page.addInitScript(() => {
    // Seed one worklist so the Worklists catalog is non-empty.
    const req = indexedDB.open('boardripper-worklist', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('boards')) db.createObjectStore('boards', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('boards', 'readwrite');
      tx.objectStore('boards').put({ key: 'k1', fileName: 'Seed.brd', activeWorklistId: null,
        worklistes: [{ id: 'w1', name: 'Case 1', createdAt: 1, updatedAt: 2, entries: [], netEntries: [] }],
        updatedAt: 2, schemaVersion: 1 });
    };
  });
  await page.goto('/');
  const benchTab = page.getByTestId('bench-tab');
  await expect(benchTab).toHaveText('Bench');
  await benchTab.click();

  // Default variant is Donor boards.
  await expect(page.getByTestId('bench-variant-donors')).toHaveClass(/active/);

  // Switch to Worklists → seeded worklist name shows.
  await page.getByTestId('bench-variant-worklists').click();
  await expect(page.getByText('Case 1')).toBeVisible();

  // Device DB variant opens the Database Editor dockview panel.
  await page.getByTestId('bench-variant-devicedb').click();
  await expect(page.locator('.dv-tab', { hasText: 'Database Editor' })).toBeVisible();
});
```

(Confirm the Dockview tab selector — inspect an existing panel-open test in `src/frontend/tests/` for the tab class; adjust `.dv-tab` if the project uses a different class.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src/frontend && npx playwright test bench-tab.spec.ts --reporter=list`
Expected: FAIL — tab text is "Donor boards"; no variant testids.

- [ ] **Step 3: Rename the tab label**

In `LibraryPanel.tsx` (L849) change the tab button text `Donor boards` → `Bench`, and update its `title` (L847) to `"Bench — donor boards, worklists, device database"`. Keep `data-testid="bench-tab"`.

- [ ] **Step 4: Add the `BENCH_VIEWS` model + imports**

Near the top of the file (module scope, after imports) add:

```tsx
import { worklistStore } from '../store/worklist-store';
import { ensureDatabaseEditorPanel } from '../store/dockview-api';
import type { BoardWorklistes } from '../store/worklist-store';

type BenchViewDef = { id: 'donors' | 'worklists' | 'devicedb'; label: string };
// Extensible: append future Bench views here (they auto-render in the switcher).
const BENCH_VIEWS: BenchViewDef[] = [
  { id: 'donors',    label: 'Donor boards' },
  { id: 'worklists', label: 'Worklists' },
  { id: 'devicedb',  label: 'Device DB' },
];
```

(`ensureBoardPanel`/`ensurePdfPanel` are already imported from `../store/dockview-api` on L10 — extend that import instead of adding a new line if you prefer.)

- [ ] **Step 5: Pull `benchView` from the hook + add worklist catalog state**

In the destructure of `useDatabank()` (~L134), add `benchView`. In the component body near the other `useState` calls (~L294 where `donorList` lives) add:

```tsx
  const [worklistCatalog, setWorklistCatalog] = useState<BoardWorklistes[]>([]);
  useEffect(() => {
    if (viewMode === 'bench' && benchView === 'worklists') {
      worklistStore.listAllStored().then(setWorklistCatalog);
    }
  }, [viewMode, benchView]);
  // Opening the Device DB variant launches its full Dockview panel.
  useEffect(() => {
    if (viewMode === 'bench' && benchView === 'devicedb') ensureDatabaseEditorPanel();
  }, [viewMode, benchView]);
```

- [ ] **Step 6: Render the switcher + route variants**

Replace the bench block opener (L942-944):

```tsx
        {viewMode === 'bench' ? (
          <div className="library-bench">
            <div className="library-bench-header">Donor boards ({donorList.length})</div>
```

with:

```tsx
        {viewMode === 'bench' ? (
          <div className="library-bench">
            <div className="library-bench-switch" role="tablist" aria-label="Bench view">
              {BENCH_VIEWS.map(v => (
                <button
                  key={v.id}
                  className={`library-bench-switch-btn ${benchView === v.id ? 'active' : ''}`}
                  data-testid={`bench-variant-${v.id}`}
                  role="tab"
                  aria-selected={benchView === v.id}
                  onClick={() => databankStore.setBenchView(v.id)}
                >
                  {v.label}
                </button>
              ))}
            </div>
            {benchView === 'devicedb' ? (
              <div className="library-bench-launch">
                <div className="library-empty">The device database opens in its own panel.</div>
                <button className="library-bench-btn" onClick={() => ensureDatabaseEditorPanel()}>
                  Open Device Database ↗
                </button>
              </div>
            ) : benchView === 'worklists' ? (
              <div className="library-worklist-catalog" data-testid="bench-worklists">
                <div className="library-bench-header">
                  Worklists ({worklistCatalog.reduce((n, b) => n + b.worklistes.length, 0)})
                </div>
                <div className="library-empty" style={{ fontSize: 11 }}>
                  Every worklist stored on this device. A shared knowledge database is coming.
                </div>
                {worklistCatalog.flatMap(b =>
                  b.worklistes.map(w => (
                    <div key={`${b.key}:${w.id}`} className="library-worklist-row" data-testid="worklist-catalog-row">
                      <span className="library-worklist-name" title={w.name}>{w.name}</span>
                      <span className="library-worklist-board" title={b.fileName}>{b.fileName}</span>
                      <span className="library-worklist-counts">
                        {w.entries.length}p · {w.netEntries.length}n
                      </span>
                    </div>
                  )),
                )}
                {worklistCatalog.every(b => b.worklistes.length === 0) && (
                  <div className="library-empty">No worklists stored yet.</div>
                )}
              </div>
            ) : (
              <>
            <div className="library-bench-header">Donor boards ({donorList.length})</div>
```

Then find the matching close of the donor block. The donor content ends at L1020-1021 (`</div>` closing `.library-bench-actions`, then `</div>` closing `.library-bench`). Close the new `<>` fragment right BEFORE the `.library-bench` close. Concretely, change L1020-1021 region:

```tsx
            </div>
          </div>
        ) : viewMode === 'search' ? (
```

to:

```tsx
            </div>
              </>
            )}
          </div>
        ) : viewMode === 'search' ? (
```

(Net effect: the existing donor list/actions become the `donors` variant inside the `<> … </>`; the switcher sits above all three variants.)

- [ ] **Step 7: Add the CSS**

In `index.css`, after the `.library-browse-pill*` rules (~L4667) add:

```css
/* ── Bench variant switcher + worklist catalog ─────────────────────────── */
.library-bench-switch { display: flex; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--border); }
.library-bench-switch-btn {
  background: transparent; border: 1px solid var(--border); color: var(--text-secondary);
  font-size: 11px; padding: 3px 9px; border-radius: 3px; cursor: pointer;
}
.library-bench-switch-btn:hover:not(.active) { color: var(--text-primary); background: color-mix(in srgb, var(--accent) 12%, transparent); }
.library-bench-switch-btn.active { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); font-weight: 600; }
.library-bench-launch { padding: 12px 10px; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.library-worklist-catalog { display: flex; flex-direction: column; }
.library-worklist-row { display: flex; align-items: baseline; gap: 8px; padding: 4px 10px; font-size: 12px; border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent); }
.library-worklist-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.library-worklist-board { color: var(--text-secondary); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40%; }
.library-worklist-counts { flex: none; color: var(--text-secondary); font-size: 10px; }
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd src/frontend && npx playwright test bench-tab.spec.ts --reporter=list`
Expected: PASS.
Run: `cd src/frontend && npx tsc -b --noEmit` → no errors.

- [ ] **Step 9: Commit**

```bash
git add src/frontend/src/panels/LibraryPanel.tsx src/frontend/src/index.css src/frontend/tests/bench-tab.spec.ts
git commit -m "feat(library): Bench tab with Donor boards / Worklists / Device DB variants"
```

---

## Task 9: Frontend — Part 3: DB-only folders + per-branch rescan button

**Files:**
- Modify: `src/frontend/src/store/databank-store.ts` (remove Live surface — see Task 6 decision)
- Modify: `src/frontend/src/hooks/useDatabank.ts` (remove Live snapshot keys)
- Modify: `src/frontend/src/panels/LibraryPanel.tsx` (remove DB/Live pill; always `FolderView`; delete `LiveBrowser`; add per-branch scan button + busy state; thread `onScanFolder`/`scanningFolder`)
- Modify: `src/frontend/src/index.css` (`.library-scan-branch-btn` + spinner)
- Test: `src/frontend/tests/folder-branch-scan.spec.ts` (create)

**Interfaces:**
- Consumes: `databankStore.scanFolder(path)` (Task 6).

- [ ] **Step 1: Pre-commit the current state (safety rule — deleting `LiveBrowser`)**

```bash
git add -A && git commit -m "chore: checkpoint before removing LiveBrowser" --allow-empty
```

- [ ] **Step 2: Write the failing test**

Create `src/frontend/tests/folder-branch-scan.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

// The Folders tab shows a per-branch update button next to "idx"; the DB/Live
// pill is gone.
test('folders tab: no DB/Live pill, per-branch update button present', async ({ page }) => {
  await page.goto('/');
  // Open the Folders tab (last library tab, folder icon).
  await page.locator('.library-tab', { has: page.locator('svg') }).last().click();
  // The DB/Live pill must be gone.
  await expect(page.locator('.library-browse-pill')).toHaveCount(0);
  // At least the tree container renders (folder rows require a scanned library;
  // assert the pill removal + that the scan-branch button class exists in DOM
  // when a non-root folder is present).
  // Structural check only — full folder rows need a seeded backend.
});
```

(This spec asserts the pill removal deterministically. The button-presence/`disabled`-while-running assertions require a seeded backend library; keep them in the backend-gated section if the harness has no backend, mirroring `session-restore.spec.ts`'s split.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd src/frontend && npx playwright test folder-branch-scan.spec.ts --reporter=list`
Expected: FAIL — `.library-browse-pill` still present.

- [ ] **Step 4: Remove the Live surface from the store + snapshot**

Apply Task 6 Steps 2–3 now (delete `_browseMode`/`_browseResult`/`_browsing`, getters, `setBrowseMode`, `browse`; remove the three snapshot keys from `useDatabank.ts`).

- [ ] **Step 5: Remove the DB/Live pill + Live routing in `LibraryPanel`**

- Delete the pill block (L859-880: `{viewMode === 'folders' && ( <div className="library-browse-pill" …> … )}`).
- In the folders routing (L1140-1154), delete the `browseMode === 'live'` branch so it is unconditionally `FolderView`:

```tsx
        ) : viewMode === 'folders' ? (
          <FolderView
            tree={folderTree}
            treeLoading={folderTreeLoading}
            selectedFileId={selectedFileId}
            filterFile={filterFile}
            searchFilter={debouncedSearch}
            onSelectFile={handleSelectFile}
            onOpenFile={handleOpenFile}
            onIndexFolder={handleIndexFolder}
            onScanFolder={handleScanFolder}
            registerCollapseAll={registerTreeCollapseAll}
          />
        ) : (
```

- Remove the `browseMode`, `browseResult`, `browsing` names from the `useDatabank()` destructure (~L134) and delete the `<LiveBrowser … />` element (was L1141).
- Delete the entire `LiveBrowser` function component (L1176-1317).

- [ ] **Step 6: Add `handleScanFolder` + per-branch busy state**

Near `handleIndexFolder` (L568-582) add:

```tsx
  // Folder paths currently being rescanned (disables their button + shows a
  // spinner). Scans are singleton on the backend, so at most one is active.
  const [scanningFolder, setScanningFolder] = useState<string | null>(null);
  const handleScanFolder = useCallback(async (folderPath: string) => {
    setScanningFolder(folderPath);
    try { await databankStore.scanFolder(folderPath); }
    finally { setScanningFolder(null); }
  }, []);
```

Thread the two new props through `FolderView` → `FolderNodeView`. In `FolderView`'s prop type (L2505-2517) add:

```tsx
  onScanFolder?: (folderPath: string) => void;
  scanningFolder?: string | null;
```

Pass them down to the root `FolderNodeView` (L2557-2567) and into each recursive child (L2617-2629): add `onScanFolder={onScanFolder}` and `scanningFolder={scanningFolder}` in both the parent render and the `.map` child render. Also add them to `FolderView`'s destructure and forward `scanningFolder` from the panel:

In the panel's `<FolderView …>` (Step 5 block) `scanningFolder={scanningFolder}` is passed. Add `onScanFolder`, `scanningFolder` to `FolderView`'s destructured params and to the `FolderNodeView` prop type (L2572-2582):

```tsx
  onScanFolder?: (folderPath: string) => void;
  scanningFolder?: string | null;
```

- [ ] **Step 7: Render the button next to "idx"**

In `FolderNodeView`, after the `idx` button (L2613) add:

```tsx
        {showIdxBtn && onScanFolder && (
          <button
            className="library-scan-branch-btn"
            data-testid="scan-branch-btn"
            title={`Rescan files in "${node.path}" from disk`}
            disabled={scanningFolder === node.path}
            onClick={(e) => { e.stopPropagation(); onScanFolder(node.path); }}
          >
            {scanningFolder === node.path ? '…' : <IconRefresh size={11} />}
          </button>
        )}
```

Add `IconRefresh` to the tabler import (L12).

- [ ] **Step 8: Add the CSS**

In `index.css`, after `.library-live-index-btn` rules (~L4895) add:

```css
.library-scan-branch-btn {
  visibility: hidden;
  background: none;
  border: 1px solid var(--border);
  color: var(--text-secondary);
  padding: 0 4px;
  margin-left: 4px;
  border-radius: 3px;
  font-size: 9px;
  line-height: 14px;
  cursor: pointer;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
}
.library-tree-node:hover .library-scan-branch-btn { visibility: visible; }
.library-scan-branch-btn:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
.library-scan-branch-btn:disabled { opacity: 0.6; cursor: default; }
```

(Note: `.library-live-index-btn` uses `margin-left: auto`, pushing "idx" to the right edge; the branch button sits just after it with `margin-left: 4px`. Verify visually — if the two crowd, wrap both in a flex `<span className="library-tree-node-actions">` and move `margin-left: auto` to that span. Ship the wrapper only if needed.)

- [ ] **Step 9: Run the test + type-check + full suite sanity**

Run: `cd src/frontend && npx tsc -b --noEmit` → no errors (all `browseMode`/`LiveBrowser` refs gone).
Run: `cd src/frontend && npx playwright test folder-branch-scan.spec.ts library-search-order.spec.ts bench-tab.spec.ts --reporter=list` → PASS.

- [ ] **Step 10: Commit**

```bash
git add src/frontend/src/panels/LibraryPanel.tsx src/frontend/src/store/databank-store.ts src/frontend/src/hooks/useDatabank.ts src/frontend/src/index.css src/frontend/tests/folder-branch-scan.spec.ts
git commit -m "feat(library): DB-only folders + per-branch filesystem rescan button; remove Live browser"
```

---

## Task 10: Docs — CHANGELOG entry (deferred to release)

**Files:**
- Modify: `CHANGELOG.md` (add a `## vX.Y.Z` section at release time)

This is folded into the release step, not a standalone commit here. When cutting the release, add a section summarizing: filter-above-stats + accent; Bench tab (Donor boards / Worklists catalog / Device DB launcher); DB-only Folders with per-branch rescan; removed Live browser. The `release` skill gates on this entry.

---

## Self-Review

**Spec coverage:**
- Part 1 (search above stats + accent) → Task 7. ✓
- Part 2 (rename Bench; extensible switcher; Donor boards inline; Worklists catalog placeholder; Device DB launcher) → Tasks 3, 4, 5, 8. ✓
- Part 3 (remove Live; DB-only folders; per-branch subtree rescan; perf via singleton reuse) → Tasks 1, 2, 6, 9. ✓
- `benchView` persistence → Task 3. `listAllStored` → Task 4. Shared editor helper → Task 5. ✓

**Type consistency:**
- `ScanFolderAsync(rel string)` (Task 1) matches handler call (Task 2) and endpoint `POST /api/databank/scan/folder` matches `databankStore.scanFolder` (Task 6). ✓
- `BenchViewId`/`benchView`/`setBenchView` consistent across Tasks 3 and 8. ✓
- `ensureDatabaseEditorPanel()` defined in Task 5, consumed in Task 8. ✓
- `worklistStore.listAllStored(): Promise<BoardWorklistes[]>` defined Task 4, consumed Task 8; `BoardWorklistes.worklistes`/`.fileName`/`.key` fields match `worklist-store.ts`. ✓
- `onScanFolder`/`scanningFolder` prop names identical across `FolderView` and `FolderNodeView` (Task 9). ✓

**Split-order note:** The Live-removal is intentionally atomic in Task 9 (with the store/snapshot deletions moved there from Task 6) so no intermediate commit fails `tsc`. Tasks 7 and 8 do not touch `browseMode`, so they compile before Task 9.

**Placeholder scan:** No TBD/TODO. Two verify-then-adjust notes remain (the `startScanPolling`/`fetchTree` method-name confirmation in Task 6, and the Dockview tab selector in Task 8) — both give an exact grep to resolve locally and a concrete fallback. These are lookups against existing code, not unspecified requirements.
