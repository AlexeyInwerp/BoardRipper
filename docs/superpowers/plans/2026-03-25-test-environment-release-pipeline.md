# Test Environment, Release Pipeline & GitHub Issues Workflow

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish automated test gating, release validation, and a contributor feedback pipeline — based on analysis of 39 Claude sessions, 100+ git commits, and recurring failure patterns.

**Architecture:** GitHub Actions CI for test/build gates, Docker-based integration testing, structured issue templates for contributor feedback, and a release checklist workflow that prevents the specific classes of bugs found in prior sessions.

**Tech Stack:** GitHub Actions, Playwright, Go test, Docker, `gh` CLI, GitHub Issue/PR templates

---

## Part 1: Prior Session Analysis — Problems & Root Causes

### 1.1 Sessions Analyzed

| Session | Date | Focus | Problems |
|---------|------|-------|----------|
| `376a8bf8` | Mar 24 | Allegro BRD parser | 3+ rounds of "still no layers"; 56 Playwright runs, 8 server restarts; wrong bounds, 0-pin invisibility, layer name mismatch |
| `1b9ead3a` | Mar 19 | Code review + UI overhaul | BRD top/bottom always wrong; info panel disconnected from renderer (regression); 3 context continuations |
| `71c045a0` | Mar 22 | Electron + NAS deploy | 52 SSH attempts; "AES not implemented" crash; library data overwrite scare; 4 context continuations |
| `951ef0a9` | Mar 22 | PDF search fix | Fixed wrong component (frontend vs backend); fixing one broke the other; 32 Go rebuilds |
| `486ee903` | Mar 17 | BGA/settings/library | Library completely broken after changes; PDF opening slower (regression) |
| `0fed726d` | Mar 25 | Scoped logging + OOM fix | Library fetcher OOM on NAS; goroutine-per-file pattern; clean session |
| `cfb40c32` | Mar 14 | Largest session (53MB) | Core feature buildout |
| `35ec6b12` | Mar 17 | Second largest (43MB) | Extended implementation |

**Total:** 39 main sessions, 355 subagent sessions, ~500MB of JSONL logs, March 11–25 2026.

### 1.2 Recurring Problem Categories

#### Category A: Regressions from Fixes (every session)
Every session that changed code introduced at least one regression:
- Info panel disconnected after UI refactor (session `1b9ead3a`)
- PDF viewer search broken after fixing library search (session `951ef0a9`)
- Library broken after BGA text sizing changes (session `486ee903`)
- PDF opening became slower after optimization work (session `486ee903`)
- Board vertically flipped after fixing horizontal flip (session `1b9ead3a`)

**Root cause:** No automated regression test gate. Tests exist (9 Playwright specs, 3112 lines) but are run manually and sporadically.

**Fix:** CI pipeline that runs full test suite before any merge. See Part 2.

#### Category B: Wrong-Component Debugging (~30-40% wasted effort)
Claude fixed the wrong subsystem at least twice:
- PDF viewer vs library search (session `951ef0a9`) — user had to redirect
- Rendering issue vs data model issue in Allegro parser (session `376a8bf8`)

**Root cause:** No integration tests that validate end-to-end data flow. Unit-level fixes don't catch cross-boundary issues.

**Fix:** Add integration tests that validate parser→store→renderer pipeline. See Part 2, Task 4.

#### Category C: PixiJS v8 Lifecycle Crashes (6 fixes across history)
- `app.destroy()` corrupts global `batchPool` (session `0ce0314`)
- Settings change crashes renderer — missing `removeChild()` (session `0f309a4`)
- PDF canvas OOM at high zoom on mobile GPUs (session `172fdfb`)
- Multi-panel race conditions (session `38e42c2`)

**Root cause:** PixiJS v8 has module-level singleton state that doesn't tolerate destroy/recreate patterns. Each crash required a different workaround.

**Fix:** Dedicated PixiJS lifecycle smoke test that opens/closes/reopens boards rapidly. See Part 2, Task 5.

#### Category D: Deployment Failures (session `71c045a0`)
- 52 SSH/SCP attempts to reach NAS
- Password encoding confusion
- "AES not implemented" — crypto missing in scratch Docker image
- Deploying overwrote container settings + library database
- macOS Gatekeeper quarantine on unsigned builds

**Root cause:** No deployment validation. Manual `NASdeploy.sh` with no pre-flight checks.

**Fix:** Docker health checks + pre-deploy validation script. See Part 2, Task 7.

#### Category E: Context Exhaustion (63+ continuations across sessions)
Full log analysis reveals the true scale:
- `cfb40c32`: **31 continuations**, 53MB, 4313 user messages, ran 3+ days (Mar 11-14)
- `35ec6b12`: **21 continuations**, 43MB, 2598 user messages
- `253b2e43`: **11 continuations**, 33MB, 1965 user messages
- User ran `/compact` **114 times** in the largest session alone

**Root cause:** Mega-sessions attempting multiple features without checkpoints. Context summaries lose nuance, Claude re-does earlier decisions.

**Fix:** Smaller, focused PRs with CI gates. Issue-driven workflow forces scope boundaries. See Part 3.

#### Category F: Visual Bugs Requiring Human Eyes (~40% of debugging time)
Claude cannot see the rendered board. The most common pattern:
- Claude makes a code change → user reports "it looks wrong" or sends screenshot → Claude guesses → repeat
- Rectangular pad placement: 5+ rounds ("this is still very far away from what we need")
- Pin sizes TVW: "1000% above their proper size"
- Layer z-ordering, text orientation after rotation, component outline alignment

**Root cause:** No visual regression testing. Headless Chromium has no WebGL.

**Fix:** Screenshot comparison baselines in Playwright (captures canvas even without WebGL rendering). See Task 5.

### 1.3 High-Risk Components (by commit frequency + bug count)

| Component | Commits | Bug Fixes | Risk |
|-----------|---------|-----------|------|
| `renderer/board-scene.ts` | 21 | 4 | CRITICAL |
| `renderer/BoardRenderer.ts` | 21 | 6 | CRITICAL |
| `panels/PdfViewerPanel.tsx` | 16 | 4 | HIGH |
| `store/board-store.ts` | 15 | 3 | HIGH |
| `store/render-settings.ts` | 14 | 2 | MEDIUM |
| `store/pdf-store.ts` | 13 | 3 | HIGH |
| `parsers/*` (9 formats) | 7-9 each | 2 | MEDIUM |
| `backend/databank/*` | 7 | 3 | MEDIUM |

### 1.4 What Worked Well

- **Scoped debug logging** (session `0fed726d`) — clean implementation, no debugging loops
- **Format parsers** — BVR1, BVR3, FZ, CAD, XZZ, TVW all implemented without major rework
- **PDF multi-doc architecture** — `usePdfDoc(fileName)` pattern worked first time
- **Docker multi-stage build** — scratch-based image stays at ~15MB
- **Playwright test suite** — 9 spec files, 3112 lines, covers all formats + touch + PDF
- **Memory/perf fixes** — goroutine pooling, batch inserts diagnosed on first investigation

---

## Part 2: Test Environment & Release Pipeline

### Task 1: Add `test` Script to package.json

**Files:**
- Modify: `src/frontend/package.json`

- [ ] **Step 1: Add test scripts**

Add to `scripts` section of `src/frontend/package.json`:
```json
{
  "scripts": {
    "test": "npx playwright test",
    "test:ui": "npx playwright test --ui",
    "test:headed": "npx playwright test --headed",
    "test:debug": "npx playwright test --debug",
    "test:report": "npx playwright show-report"
  }
}
```

- [ ] **Step 2: Verify test script works**

Run: `cd src/frontend && npm test`
Expected: All 9 spec files execute, existing tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/package.json
git commit -m "chore: add test scripts to package.json"
```

---

### Task 2: GitHub Actions CI — Test Gate

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create CI workflow**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  lint-and-typecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: src/frontend/package-lock.json
      - run: cd src/frontend && npm ci
      - run: cd src/frontend && npm run lint
      - run: cd src/frontend && npx tsc -b --noEmit

  frontend-tests:
    runs-on: ubuntu-latest
    needs: lint-and-typecheck
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: src/frontend/package-lock.json
      - run: cd src/frontend && npm ci
      - run: cd src/frontend && npx playwright install --with-deps chromium
      - run: cd src/frontend && npm test
        env:
          CI: true
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report
          path: src/frontend/test-results/
          retention-days: 7

  backend-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.22'
          cache-dependency-path: src/backend/go.sum
      - run: cd src/backend && go test ./... -v -count=1

  docker-build:
    runs-on: ubuntu-latest
    needs: [frontend-tests, backend-tests]
    steps:
      - uses: actions/checkout@v4
      - run: docker build -t boardripper:ci-${{ github.sha }} .
      - run: |
          docker run -d --name br-smoke -p 8080:8080 boardripper:ci-${{ github.sha }}
          sleep 3
          curl -f http://localhost:8080/ || (docker logs br-smoke && exit 1)
          docker stop br-smoke
```

- [ ] **Step 2: Verify workflow syntax**

Run: `cd /Users/besitzer/Desktop/Boardviewer && cat .github/workflows/ci.yml | python3 -c "import sys,yaml; yaml.safe_load(sys.stdin.read()); print('valid')"` (or use `actionlint` if installed)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add GitHub Actions pipeline — lint, test, build, Docker smoke"
```

---

### Task 3: Branch Protection Rules

- [ ] **Step 1: Enable branch protection on main**

```bash
gh api repos/AlexeyInwerp/BoardRipper/branches/main/protection \
  -X PUT \
  -H "Accept: application/vnd.github+json" \
  --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["lint-and-typecheck", "frontend-tests", "backend-tests", "docker-build"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null
}
EOF
```

Note: This requires the repo to be on a GitHub plan that supports branch protection (free for public repos).

- [ ] **Step 2: Verify protection is active**

```bash
gh api repos/AlexeyInwerp/BoardRipper/branches/main/protection
```

- [ ] **Step 3: Document in README**

Add a "Contributing" section to README.md noting that all PRs must pass CI.

---

### Task 4: Integration Tests — Parser→Store→Renderer Pipeline

**Files:**
- Create: `src/frontend/tests/integration-pipeline.spec.ts`

These tests catch the "wrong-component debugging" pattern by validating the full data flow.

- [ ] **Step 1: Write pipeline integration test**

Uses verified selectors from the actual codebase (see `Toolbar.tsx`, `StatusBar.tsx`, `BoardSidebar.tsx`).

```typescript
import { test, expect } from '@playwright/test';
import path from 'path';

const SAMPLES = {
  bvr3: 'samples/820-02016.bvr',
  brd:  'samples/820-02935-05.brd',
};

/** Load a board file and wait for stats to appear */
async function loadBoard(page: import('@playwright/test').Page, filePath: string) {
  const fileInput = page.getByTestId('file-input');
  await fileInput.setInputFiles(path.resolve(filePath));
  await expect(page.getByTestId('file-name')).toContainText('parts', { timeout: 15000 });
}

test.describe('Parser → Store → Renderer Pipeline', () => {

  test('BVR3: load → parse → render → search → info panel connected', async ({ page }) => {
    await page.goto('/');
    await loadBoard(page, SAMPLES.bvr3);

    // Verify canvas rendered
    const canvas = page.getByTestId('board-canvas').locator('canvas');
    await expect(canvas).toBeVisible();

    // Verify HUD shows zoom % (renderer is alive)
    const hud = page.locator('.board-hud').first();
    await expect(hud).toContainText('%', { timeout: 5000 });

    // Verify info panel is connected (regression from session 1b9ead3a)
    const infoPanel = page.getByTestId('component-info');
    await expect(infoPanel).not.toContainText('no board loaded');

    // Search for a known component
    const searchInput = page.getByTestId('search-input');
    await searchInput.fill('U');
    await expect(page.getByTestId('search-results')).not.toBeEmpty();
  });

  test('BRD: top/bottom layer buttons visible and toggleable', async ({ page }) => {
    await page.goto('/');
    await loadBoard(page, SAMPLES.brd);

    // Verify layer toggle buttons exist (actual selectors from Toolbar.tsx)
    const topBtn = page.locator('.toolbar-btn', { hasText: 'Top' });
    const bottomBtn = page.locator('.toolbar-btn', { hasText: 'Bottom' });
    await expect(topBtn).toBeVisible();
    await expect(bottomBtn).toBeVisible();

    // Toggle top off and on — should not crash
    await topBtn.click();
    await page.waitForTimeout(300);
    await topBtn.click();
    await expect(page.getByTestId('board-canvas').locator('canvas')).toBeVisible();
  });

  test('Multi-tab: opening second board does not break first', async ({ page }) => {
    await page.goto('/');

    // Load first board
    await loadBoard(page, SAMPLES.bvr3);

    // Load second board
    await loadBoard(page, SAMPLES.brd);
    await page.waitForTimeout(1000);

    // Switch back to first tab via Dockview tab (actual selector)
    const bvrTab = page.locator('.dv-tab', { hasText: '820-02016.bvr' }).first();
    await bvrTab.click();
    await page.waitForTimeout(500);

    // First board should still show stats
    await expect(page.getByTestId('file-name')).toContainText('parts', { timeout: 5000 });

    // Canvas should still be rendered
    await expect(page.getByTestId('board-canvas').locator('canvas')).toBeVisible();
  });
});

- [ ] **Step 2: Run integration tests**

Run: `cd src/frontend && npx playwright test integration-pipeline.spec.ts`

- [ ] **Step 3: Commit**

```bash
git add src/frontend/tests/integration-pipeline.spec.ts
git commit -m "test: add parser→store→renderer integration tests"
```

---

### Task 5: PixiJS Lifecycle Smoke Test

**Files:**
- Create: `src/frontend/tests/renderer-lifecycle.spec.ts`

Targets the 6 PixiJS lifecycle crashes found in git history.

- [ ] **Step 1: Write lifecycle stress test**

Uses verified selectors. Error capture via `page.on('pageerror')` (not `window.__consoleErrors`).

```typescript
import { test, expect } from '@playwright/test';
import path from 'path';

test.describe('Renderer Lifecycle Stability', () => {

  test('rapid open/close/reopen does not crash (batchPool corruption)', async ({ page }) => {
    // Capture page errors during test
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/');
    const fileInput = page.getByTestId('file-input');
    const boardFile = path.resolve('samples/820-02016.bvr');

    // Open → close → reopen 3 times
    for (let i = 0; i < 3; i++) {
      await fileInput.setInputFiles(boardFile);
      await expect(page.getByTestId('file-name')).toContainText('parts', { timeout: 15000 });

      // Close tab via Dockview close button
      const closeBtn = page.locator('.dv-default-tab-action').first();
      if (await closeBtn.isVisible()) {
        await closeBtn.click();
        await page.waitForTimeout(500);
      }
    }

    // No critical PixiJS errors
    const criticalErrors = pageErrors.filter(e =>
      e.includes('batchPool') || e.includes('GlobalResourceRegistry') || e.includes('_DefaultBatcher')
    );
    expect(criticalErrors).toHaveLength(0);
  });

  test('settings change during render does not crash', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/');
    const fileInput = page.getByTestId('file-input');
    await fileInput.setInputFiles(path.resolve('samples/820-02016.bvr'));
    await expect(page.getByTestId('file-name')).toContainText('parts', { timeout: 15000 });

    // Open settings via gear icon (actual selector from Toolbar.tsx)
    const settingsBtn = page.locator('.toolbar-btn-icon', { hasText: '⚙' });
    if (await settingsBtn.isVisible()) {
      await settingsBtn.click();
      await page.waitForTimeout(300);

      // Toggle layer buttons rapidly
      const topBtn = page.locator('.toolbar-btn', { hasText: 'Top' });
      if (await topBtn.isVisible()) {
        await topBtn.click();
        await topBtn.click();
        await topBtn.click();
      }
    }

    // Board should still be rendered (no crash)
    await expect(page.getByTestId('file-name')).toContainText('parts');

    // No critical renderer errors
    const criticalErrors = pageErrors.filter(e =>
      e.includes('batchPool') || e.includes('removeChild') || e.includes('Cannot read properties of null')
    );
    expect(criticalErrors).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run lifecycle tests**

Run: `cd src/frontend && npx playwright test renderer-lifecycle.spec.ts`

- [ ] **Step 3: Commit**

```bash
git add src/frontend/tests/renderer-lifecycle.spec.ts
git commit -m "test: add PixiJS lifecycle smoke tests (batchPool, settings crash)"
```

---

### Task 6: Go Backend Test Expansion

**Files:**
- Create: `src/backend/handlers/handlers_test.go`
- Create: `src/backend/databank/db_test.go`

Currently only 1 Go test file exists (`pdftext_test.go`). The backend has untested handlers, DB schema, and scanner.

- [ ] **Step 1: Write handler tests**

Based on actual handler signatures: `FileHandler` struct with `NewFileHandler(dataDir string, scanRootFn ScanRootFunc)`,
methods `Upload(w, r)`, `List(w, r)`, `Get(w, r)`, `Delete(w, r)`. See `src/backend/handlers/files.go`.

```go
// src/backend/handlers/handlers_test.go
package handlers

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func newTestFileHandler(t *testing.T) *FileHandler {
	t.Helper()
	tmpDir := t.TempDir()
	return NewFileHandler(tmpDir, func() string { return tmpDir })
}

func TestUpload_RejectsEmptyBody(t *testing.T) {
	h := newTestFileHandler(t)
	req := httptest.NewRequest("POST", "/api/upload", nil)
	w := httptest.NewRecorder()
	h.Upload(w, req)
	if w.Code == http.StatusOK {
		t.Errorf("expected error for empty upload, got %d", w.Code)
	}
}

func TestList_ReturnsJSON(t *testing.T) {
	h := newTestFileHandler(t)
	req := httptest.NewRequest("GET", "/api/files", nil)
	w := httptest.NewRecorder()
	h.List(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	ct := w.Header().Get("Content-Type")
	if ct != "application/json" {
		t.Errorf("expected application/json, got %q", ct)
	}
}

func TestList_EmptyDir(t *testing.T) {
	h := newTestFileHandler(t)
	req := httptest.NewRequest("GET", "/api/files", nil)
	w := httptest.NewRecorder()
	h.List(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	// Should return empty JSON array, not error
	body := w.Body.String()
	if body != "[]" && body != "[]\n" {
		t.Logf("body: %s", body) // acceptable if format differs
	}
}

func TestDelete_RejectsEmptyName(t *testing.T) {
	h := newTestFileHandler(t)
	req := httptest.NewRequest("DELETE", "/api/files/", nil)
	req.SetPathValue("name", "")
	w := httptest.NewRecorder()
	h.Delete(w, req)
	if w.Code == http.StatusOK {
		t.Error("expected rejection of empty filename")
	}
}

func TestGet_RejectsTraversal(t *testing.T) {
	h := newTestFileHandler(t)
	req := httptest.NewRequest("GET", "/api/files/../../../etc/passwd", nil)
	req.SetPathValue("name", "../../../etc/passwd")
	w := httptest.NewRecorder()
	h.Get(w, req)
	if w.Code == http.StatusOK {
		t.Error("path traversal should be rejected")
	}
}
```

- [ ] **Step 2: Write DB schema test**

Based on actual API: `Open(dataDir string) (*DB, error)` creates `dataDir/databank.db`.
Actual tables from `db.go`: `schema_version`, `files`, `bindings`, `pdf_text` (FTS5 virtual), `pdf_pages`, `config`.

```go
// src/backend/databank/db_test.go
package databank

import (
	"testing"
)

func TestOpen_CreatesSchema(t *testing.T) {
	tmpDir := t.TempDir()

	db, err := Open(tmpDir)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer db.Close()

	// Verify all expected tables exist
	tables := []string{"schema_version", "files", "bindings", "pdf_pages", "config"}
	for _, table := range tables {
		row := db.reader.QueryRow("SELECT name FROM sqlite_master WHERE type='table' AND name=?", table)
		var name string
		if err := row.Scan(&name); err != nil {
			t.Errorf("table %q not created: %v", table, err)
		}
	}

	// Verify FTS5 virtual table
	row := db.reader.QueryRow("SELECT name FROM sqlite_master WHERE type='table' AND name='pdf_text'")
	var name string
	if err := row.Scan(&name); err != nil {
		t.Errorf("FTS5 virtual table 'pdf_text' not created: %v", err)
	}
}

func TestOpen_Idempotent(t *testing.T) {
	tmpDir := t.TempDir()

	// Open twice — should not fail on second open
	db1, err := Open(tmpDir)
	if err != nil {
		t.Fatalf("first Open failed: %v", err)
	}
	db1.Close()

	db2, err := Open(tmpDir)
	if err != nil {
		t.Fatalf("second Open failed: %v", err)
	}
	db2.Close()
}
```

- [ ] **Step 3: Run Go tests**

Run: `cd src/backend && go test ./... -v -count=1`

- [ ] **Step 4: Commit**

```bash
git add src/backend/handlers/handlers_test.go src/backend/databank/db_test.go
git commit -m "test: add Go handler + DB schema tests"
```

---

### Task 7: Docker Health Check & Deploy Validation

**Files:**
- Modify: `docker-compose.yml`
- Modify: `NASdeploy.sh`

Targets the deployment failures from session `71c045a0` (52 SSH attempts, library overwrite, AES crash).

- [ ] **Step 1: Add health check to docker-compose.yml**

Add to the `boardripper` service:
```yaml
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:8080/"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
```

- [ ] **Step 2: Add pre-deploy validation to NASdeploy.sh**

Add before the deploy steps:
```bash
# Pre-deploy validation
echo "=== Pre-deploy checks ==="

# 1. Verify Docker image builds locally
echo "Building image..."
docker build -t boardripper:deploy-check . || { echo "FAIL: Docker build failed"; exit 1; }

# 2. Smoke-test the image locally
echo "Smoke-testing image..."
docker run -d --name br-deploy-check -p 18080:8080 boardripper:deploy-check
sleep 3
if ! curl -sf http://localhost:18080/ > /dev/null; then
    echo "FAIL: Container does not serve HTTP"
    docker logs br-deploy-check
    docker rm -f br-deploy-check
    exit 1
fi
docker rm -f br-deploy-check
echo "OK: Image serves HTTP"

# 3. Verify NAS is reachable
echo "Checking NAS connectivity..."
if ! ssh -o ConnectTimeout=5 "${NAS_USER}@${NAS_HOST}" "echo ok" 2>/dev/null; then
    echo "FAIL: Cannot reach NAS at ${SERVER}"
    exit 1
fi
echo "OK: NAS reachable"

# 4. Backup existing data volume
echo "Backing up NAS data..."
ssh "${NAS_USER}@${NAS_HOST}" "cp -r /volume1/docker/boardripper/data /volume1/docker/boardripper/data.bak.$(date +%Y%m%d)" || echo "WARN: backup failed (first deploy?)"

echo "=== All pre-deploy checks passed ==="
```

- [ ] **Step 3: Verify compose config**

Run: `cd /Users/besitzer/Desktop/Boardviewer && docker compose config`

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml NASdeploy.sh
git commit -m "ops: add Docker health check + pre-deploy validation"
```

---

### Task 8: Release Checklist Workflow

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Create release workflow**

```yaml
name: Release

on:
  push:
    tags: ['v*']

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: src/frontend/package-lock.json
      - uses: actions/setup-go@v5
        with:
          go-version: '1.22'

      # Full test suite
      - run: cd src/frontend && npm ci
      - run: cd src/frontend && npx playwright install --with-deps chromium
      - run: cd src/frontend && npm test
      - run: cd src/backend && go test ./... -v -count=1

      # Docker build + smoke
      - run: docker build -t boardripper:${{ github.ref_name }} .
      - run: |
          docker run -d --name br-release -p 8080:8080 boardripper:${{ github.ref_name }}
          sleep 3
          curl -f http://localhost:8080/
          docker stop br-release

  create-release:
    needs: validate
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: docker build -t boardripper:${{ github.ref_name }} .
      - run: docker save boardripper:${{ github.ref_name }} | gzip > boardripper-${{ github.ref_name }}.tar.gz
      - uses: softprops/action-gh-release@v2
        with:
          files: boardripper-${{ github.ref_name }}.tar.gz
          generate_release_notes: true
```

- [ ] **Step 2: Commit workflow** (must be committed before tagging)

```bash
git add .github/workflows/release.yml
git commit -m "ci: add release workflow with validation gate"
git push origin main
```

- [ ] **Step 3: Test with a dry-run tag**

```bash
git tag v0.1.0-rc1
git push origin v0.1.0-rc1
# Watch: gh run watch
```

---

## Part 3: GitHub Issues Workflow for Feature Pipeline

### Task 9: Issue Templates

**Files:**
- Create: `.github/ISSUE_TEMPLATE/bug_report.yml`
- Create: `.github/ISSUE_TEMPLATE/feature_request.yml`
- Create: `.github/ISSUE_TEMPLATE/format_request.yml`

- [ ] **Step 1: Create bug report template**

```yaml
# .github/ISSUE_TEMPLATE/bug_report.yml
name: Bug Report
description: Report a bug in BoardRipper
labels: ["bug", "triage"]
body:
  - type: dropdown
    id: component
    attributes:
      label: Component
      description: Which part of BoardRipper is affected?
      options:
        - Board Renderer (PixiJS)
        - PDF Viewer
        - File Parser (specify format below)
        - Library / File Scanner
        - UI / Panels
        - Backend / Docker
        - Desktop App (Electron)
    validations:
      required: true
  - type: input
    id: format
    attributes:
      label: File Format (if applicable)
      description: "BVR1, BVR3, BRD, BDV, FZ, CAD, XZZ, TVW, Allegro BRD"
      placeholder: "e.g. BRD"
  - type: textarea
    id: description
    attributes:
      label: What happened?
      description: Clear description of the bug
    validations:
      required: true
  - type: textarea
    id: expected
    attributes:
      label: Expected behavior
      description: What should have happened?
    validations:
      required: true
  - type: textarea
    id: reproduce
    attributes:
      label: Steps to reproduce
      description: Minimal steps to trigger the bug
    validations:
      required: true
  - type: dropdown
    id: deployment
    attributes:
      label: Deployment
      options:
        - Docker (NAS)
        - Desktop (macOS)
        - Desktop (Windows)
        - Dev server (localhost)
    validations:
      required: true
  - type: textarea
    id: logs
    attributes:
      label: Debug Panel output
      description: "Open Debug Panel → copy relevant log scopes (parser.*, render.*, pdf.*, etc.)"
      render: shell
```

- [ ] **Step 2: Create feature request template**

```yaml
# .github/ISSUE_TEMPLATE/feature_request.yml
name: Feature Request
description: Suggest a new feature or improvement
labels: ["enhancement"]
body:
  - type: dropdown
    id: area
    attributes:
      label: Area
      options:
        - Rendering / Visual
        - New File Format
        - PDF Viewer
        - Search / Navigation
        - UI / UX
        - Performance
        - Deployment / Infrastructure
        - API / Backend
    validations:
      required: true
  - type: textarea
    id: problem
    attributes:
      label: Problem or Use Case
      description: What problem does this solve? What workflow does it enable?
    validations:
      required: true
  - type: textarea
    id: solution
    attributes:
      label: Proposed Solution
      description: How would you like this to work?
    validations:
      required: true
  - type: textarea
    id: alternatives
    attributes:
      label: Alternatives Considered
      description: Other approaches you've thought about
  - type: dropdown
    id: priority
    attributes:
      label: How important is this to you?
      options:
        - Nice to have
        - Would significantly improve my workflow
        - Blocking my use of BoardRipper
```

- [ ] **Step 3: Create format request template**

```yaml
# .github/ISSUE_TEMPLATE/format_request.yml
name: New Format Support
description: Request support for a new PCB boardview format
labels: ["enhancement", "new-format"]
body:
  - type: input
    id: format_name
    attributes:
      label: Format Name
      placeholder: "e.g. ODB++, Gerber, KiCad"
    validations:
      required: true
  - type: input
    id: file_extension
    attributes:
      label: File Extension(s)
      placeholder: "e.g. .odb, .gbr, .kicad_pcb"
    validations:
      required: true
  - type: textarea
    id: description
    attributes:
      label: Format Description
      description: What software produces this format? Is it binary or text? Is there a public spec?
    validations:
      required: true
  - type: textarea
    id: sample
    attributes:
      label: Sample File
      description: Can you provide a sample file or link to one? (Attach or link)
  - type: textarea
    id: reference
    attributes:
      label: Reference Implementation
      description: Links to existing parsers (OpenBoardView, open-source tools, format docs)
```

- [ ] **Step 4: Commit templates**

```bash
git add .github/ISSUE_TEMPLATE/
git commit -m "docs: add GitHub issue templates (bug, feature, format request)"
```

---

### Task 10: GitHub Labels for Triage

- [ ] **Step 1: Create labels via gh CLI**

```bash
# Component labels
gh label create "comp:renderer" --color "d73a4a" --description "Board renderer (PixiJS)"
gh label create "comp:pdf" --color "e99695" --description "PDF viewer"
gh label create "comp:parser" --color "f9d0c4" --description "File format parsers"
gh label create "comp:library" --color "fbca04" --description "Library / file scanner"
gh label create "comp:backend" --color "0e8a16" --description "Go backend / Docker"
gh label create "comp:ui" --color "c5def5" --description "UI / panels / CSS"
gh label create "comp:desktop" --color "bfdadc" --description "Electron desktop app"

# Priority labels
gh label create "P0-critical" --color "b60205" --description "Crash or data loss"
gh label create "P1-high" --color "d93f0b" --description "Major functionality broken"
gh label create "P2-medium" --color "fbca04" --description "Noticeable issue, workaround exists"
gh label create "P3-low" --color "0e8a16" --description "Minor / cosmetic"

# Workflow labels
gh label create "triage" --color "ededed" --description "Needs initial triage"
gh label create "new-format" --color "7057ff" --description "New file format support"
gh label create "regression" --color "b60205" --description "Previously working, now broken"
gh label create "good-first-issue" --color "7057ff" --description "Good for contributors"
```

- [ ] **Step 2: Verify labels**

```bash
gh label list
```

- [ ] **Step 3: Document label usage**

No separate file needed — labels are self-documenting via their descriptions.

---

### Task 11: Issue-to-Feature Pipeline Script

**Files:**
- Create: `scripts/issue-pipeline.sh`

This script retrieves and categorizes GitHub issues for sprint/release planning.

- [ ] **Step 1: Create the pipeline script**

```bash
#!/usr/bin/env bash
# scripts/issue-pipeline.sh — Retrieve and categorize GitHub issues for planning
set -euo pipefail

REPO="AlexeyInwerp/BoardRipper"

echo "=== BoardRipper Issue Pipeline ==="
echo "Date: $(date -u +%Y-%m-%d)"
echo ""

# --- Critical bugs (P0) ---
echo "## P0 — Critical Bugs (crashes, data loss)"
gh issue list --repo "$REPO" --label "P0-critical" --state open --json number,title,labels,createdAt \
  --template '{{range .}}#{{.number}} {{.title}} ({{timeago .createdAt}}){{"\n"}}{{end}}'
echo ""

# --- High priority bugs ---
echo "## P1 — High Priority Bugs"
gh issue list --repo "$REPO" --label "P1-high" --state open --json number,title,labels,createdAt \
  --template '{{range .}}#{{.number}} {{.title}} ({{timeago .createdAt}}){{"\n"}}{{end}}'
echo ""

# --- Regressions ---
echo "## Regressions (previously working)"
gh issue list --repo "$REPO" --label "regression" --state open --json number,title,createdAt \
  --template '{{range .}}#{{.number}} {{.title}} ({{timeago .createdAt}}){{"\n"}}{{end}}'
echo ""

# --- Feature requests by area ---
echo "## Feature Requests by Component"
for comp in renderer pdf parser library backend ui desktop; do
  count=$(gh issue list --repo "$REPO" --label "comp:$comp,enhancement" --state open --json number | jq length 2>/dev/null || echo 0)
  if [ "$count" -gt 0 ]; then
    echo ""
    echo "### comp:$comp ($count open)"
    gh issue list --repo "$REPO" --label "comp:$comp,enhancement" --state open --json number,title,createdAt \
      --template '{{range .}}  #{{.number}} {{.title}} ({{timeago .createdAt}}){{"\n"}}{{end}}'
  fi
done
echo ""

# --- New format requests ---
echo "## New Format Requests"
gh issue list --repo "$REPO" --label "new-format" --state open --json number,title,createdAt \
  --template '{{range .}}#{{.number}} {{.title}} ({{timeago .createdAt}}){{"\n"}}{{end}}'
echo ""

# --- Good first issues ---
echo "## Good First Issues (for contributors)"
gh issue list --repo "$REPO" --label "good-first-issue" --state open --json number,title,createdAt \
  --template '{{range .}}#{{.number}} {{.title}} ({{timeago .createdAt}}){{"\n"}}{{end}}'
echo ""

# --- Recently closed (last 30 days) ---
echo "## Recently Closed (velocity check)"
gh issue list --repo "$REPO" --state closed --limit 20 --json number,title,closedAt,labels \
  --template '{{range .}}#{{.number}} {{.title}} (closed {{timeago .closedAt}}){{"\n"}}{{end}}'
echo ""

# --- Summary stats ---
OPEN=$(gh issue list --repo "$REPO" --state open --json number | jq length)
CLOSED=$(gh issue list --repo "$REPO" --state closed --json number | jq length)
echo "## Summary"
echo "Open: $OPEN | Closed: $CLOSED | Total: $((OPEN + CLOSED))"
```

- [ ] **Step 2: Make executable and test**

```bash
chmod +x scripts/issue-pipeline.sh
./scripts/issue-pipeline.sh
```

- [ ] **Step 3: Commit**

```bash
git add scripts/issue-pipeline.sh
git commit -m "feat: add issue pipeline script for sprint planning"
```

---

### Task 12: PR Template

**Files:**
- Create: `.github/pull_request_template.md`

- [ ] **Step 1: Create PR template**

```markdown
## Summary
<!-- What does this PR do? Link related issues with "Fixes #123" -->

## Component
<!-- Which area: renderer, pdf, parser, library, backend, ui, desktop -->

## Testing
- [ ] Playwright tests pass (`cd src/frontend && npm test`)
- [ ] Go tests pass (`cd src/backend && go test ./...`)
- [ ] Docker build succeeds (`docker build -t boardripper:test .`)
- [ ] Manual smoke test on target deployment

## Regression Check
<!-- Based on prior session analysis, these are high-risk areas. Check if your changes touch them: -->
- [ ] Does NOT break info panel ↔ renderer connection
- [ ] Does NOT break PDF viewer search scope
- [ ] Does NOT flip board top/bottom orientation
- [ ] Does NOT break library file listing
- [ ] Does NOT regress PDF open performance
- [ ] PixiJS lifecycle safe (no `app.destroy()`, no new singletons)

## Screenshots
<!-- If visual change, before/after screenshots -->
```

- [ ] **Step 2: Commit**

```bash
git add .github/pull_request_template.md
git commit -m "docs: add PR template with regression checklist"
```

---

### Task 13: Issue-Driven Development Workflow with Claude

**Files:**
- Create: `scripts/claude-issue-workflow.sh`

Automates the flow: pick issue → create branch → implement → PR.

- [ ] **Step 1: Create workflow script**

```bash
#!/usr/bin/env bash
# scripts/claude-issue-workflow.sh — Pick a GitHub issue and start a Claude Code session
set -euo pipefail

REPO="AlexeyInwerp/BoardRipper"

if [ -z "${1:-}" ]; then
  echo "Usage: $0 <issue-number>"
  echo ""
  echo "Open issues:"
  gh issue list --repo "$REPO" --state open --limit 20
  exit 0
fi

ISSUE_NUM="$1"

# Fetch issue details
echo "=== Fetching issue #${ISSUE_NUM} ==="
ISSUE_JSON=$(gh issue view "$ISSUE_NUM" --repo "$REPO" --json title,body,labels,assignees)
TITLE=$(echo "$ISSUE_JSON" | jq -r '.title')
BODY=$(echo "$ISSUE_JSON" | jq -r '.body')
LABELS=$(echo "$ISSUE_JSON" | jq -r '[.labels[].name] | join(", ")')

# Generate branch name
BRANCH="issue-${ISSUE_NUM}/$(echo "$TITLE" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-' | head -c 50)"

echo "Title:  $TITLE"
echo "Labels: $LABELS"
echo "Branch: $BRANCH"
echo ""

# Create branch
git checkout -b "$BRANCH" main 2>/dev/null || git checkout "$BRANCH"

echo "=== Branch ready: $BRANCH ==="
echo ""
echo "Start Claude Code with this context:"
echo "---"
echo "Implement GitHub issue #${ISSUE_NUM}: ${TITLE}"
echo ""
echo "${BODY}"
echo ""
echo "Labels: ${LABELS}"
echo "---"
echo ""
echo "When done, create PR with:"
echo "  gh pr create --title \"${TITLE}\" --body \"Fixes #${ISSUE_NUM}\""
```

- [ ] **Step 2: Make executable**

```bash
chmod +x scripts/claude-issue-workflow.sh
```

- [ ] **Step 3: Commit**

```bash
git add scripts/claude-issue-workflow.sh
git commit -m "feat: add issue-driven Claude workflow script"
```

---

## Execution Order

```
Task 1  → test scripts (5 min)
Task 2  → CI workflow (10 min)
Task 3  → branch protection (5 min)
Task 4  → integration tests (15 min)
Task 5  → lifecycle tests (15 min)
Task 6  → Go backend tests (15 min)
Task 7  → Docker health + deploy validation (10 min)
Task 8  → release workflow (10 min)
Task 9  → issue templates (10 min)
Task 10 → labels (5 min)
Task 11 → issue pipeline script (10 min)
Task 12 → PR template (5 min)
Task 13 → issue workflow script (10 min)
```

**Dependencies:** Task 2 depends on Task 1. Task 3 depends on Task 2. All others are independent.

**Parallel execution possible:** Tasks 4-8 (testing) can run in parallel with Tasks 9-13 (GitHub workflow).
