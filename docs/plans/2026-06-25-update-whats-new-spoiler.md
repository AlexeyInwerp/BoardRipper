# Update "What's New" Spoiler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show an available update's release notes inline, under a collapsible "What's new" spoiler in the toolbar update dropdown, sourced from a new `notes` field embedded in the signed manifest.

**Architecture:** `release.sh` slices the `## vX.Y.Z` section out of `CHANGELOG.md` (it already does, for the GitHub release) and injects it into the manifest's new `notes` field *before signing* — so the notes travel inside the signed, offline manifest. The frontend wires the dropdown's existing (currently-dead) `bodyLines` line-renderer to `manifest.notes` and wraps it in a `<details>` spoiler.

**Tech Stack:** Go (manifest + minisign), Bash (`release.sh`, `jq`), React + TypeScript, Playwright.

Spec: [docs/specs/2026-06-25-update-whats-new-spoiler-design.md](../specs/2026-06-25-update-whats-new-spoiler-design.md)

## Global Constraints

- **No new markdown library** — the frontend reuses the dropdown's existing line renderer (`## `/`### `/`- ` → `<h3>`/`<h4>`/`<li>`, else `<p>`).
- **No signature/verification change** — the minisign signature already covers the whole manifest JSON, so `notes` is protected automatically. `json:"notes,omitempty"` keeps older manifests/tests unaffected.
- **Notes are embedded in the signed manifest** (trusted, offline) — never fetched client-side. Appears for releases cut *after* this ships; older manifests fall back to the existing "Release notes ↗" link.
- TypeScript strict (no `any`); scoped loggers only; Go: gofmt-clean.
- Frontend testing is **Playwright-only** (no vitest) — frontend tasks verify with `tsc --noEmit` + `npm run build`, behaviour proven by the Playwright task.

## File Structure

- `src/backend/updater/manifest.go` — *modify*: add `Notes` field.
- `src/backend/updater/manifest_test.go` — *modify*: test notes round-trips + is signature-covered.
- `scripts/release.sh` — *modify*: slice the changelog early, inject `notes` into the manifest pre-sign, reuse the slice for the GitHub release.
- `docs/RELEASE_RUNBOOK.md` — *modify*: note the new `notes` field (folded into the release.sh task).
- `src/frontend/src/store/update-store.ts` — *modify*: `Manifest.notes?: string`.
- `src/frontend/src/components/Toolbar.tsx` — *modify*: wire `bodyLines` from `manifest.notes` + wrap in a `<details>` spoiler.
- `src/frontend/src/index.css` — *modify*: small spoiler styles.
- `src/frontend/tests/update-whats-new.spec.ts` — *create*: Playwright e2e (mock `/api/update/status`).

---

## Task 1: Manifest `notes` field (backend)

**Files:**
- Modify: `src/backend/updater/manifest.go` (the `Manifest` struct, ~line 16-30)
- Test: `src/backend/updater/manifest_test.go`

**Interfaces:**
- Produces: `Manifest.Notes string` (JSON `notes,omitempty`).

- [ ] **Step 1: Write the failing test**

Append to `src/backend/updater/manifest_test.go`:

```go
func TestManifest_NotesRoundTripsAndIsSigned(t *testing.T) {
	pub, priv, err := minisign.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	m := freshManifest("v0.8.0", 1)
	m.Notes = "## v0.8.0\n\n### Features\n- Something new"

	manifestBytes, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	// notes must be present in the serialized JSON that gets signed.
	if !strings.Contains(string(manifestBytes), `"notes":"## v0.8.0`) {
		t.Fatalf("serialized manifest missing notes field: %s", manifestBytes)
	}

	// Round-trips back into the struct.
	var back Manifest
	if err := json.Unmarshal(manifestBytes, &back); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if back.Notes != m.Notes {
		t.Errorf("notes round-trip mismatch: got %q want %q", back.Notes, m.Notes)
	}

	// The signature covers the bytes that include notes.
	sig := minisign.Sign(priv, manifestBytes)
	if err := VerifyManifest(manifestBytes, sig, pub.String()); err != nil {
		t.Errorf("VerifyManifest rejected a notes-bearing manifest: %v", err)
	}
}
```

Add `"encoding/json"` and `"strings"` to the test file's imports.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && go test ./updater/ -run TestManifest_NotesRoundTrips -v`
Expected: FAIL — `m.Notes undefined (type *Manifest has no field or method Notes)`.

- [ ] **Step 3: Add the field**

In `src/backend/updater/manifest.go`, add to the `Manifest` struct (e.g. right after the `NotesURL` field):

```go
	Notes               string          `json:"notes,omitempty"`
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/backend && go test ./updater/ -run TestManifest_NotesRoundTrips -v && go vet ./updater/`
Expected: PASS, vet clean.

- [ ] **Step 5: Commit**

```bash
git add src/backend/updater/manifest.go src/backend/updater/manifest_test.go
git commit -m "feat(updater): manifest notes field (signature-covered, omitempty)"
```

---

## Task 2: `release.sh` — embed the changelog notes in the manifest

The changelog slice currently happens in the GitHub-release step (~line 616), *after* the manifest is built and signed (~line 344). Move the slice earlier so it can be injected into the manifest pre-sign, and reuse it for the GitHub release.

**Files:**
- Modify: `scripts/release.sh` (manifest heredoc ~line 344-371; GH-release slice ~line 616-632)
- Modify: `docs/RELEASE_RUNBOOK.md` (one-line note)

**Interfaces:**
- Consumes: `Manifest.Notes` (Task 1) — the JSON key `notes`.
- Produces: `out/manifest.json` now contains a `notes` string (the CHANGELOG section), signed.

- [ ] **Step 1: Slice the changelog early into `NOTES_FILE`**

Locate the manifest-build block (the `cat > out/manifest.json <<EOF` heredoc). **Immediately before** it, insert the changelog slice (moved from the GH-release step), producing `NOTES_FILE`:

```bash
  # Slice the v$VERSION section out of CHANGELOG.md once, here — it feeds BOTH
  # the manifest's `notes` field (signed, shown in-app) and the GitHub Release
  # body below, so the two are identical by construction.
  NOTES_FILE="$(mktemp -t boardripper-release-notes)"
  awk -v v="$VERSION" '
    BEGIN { in_section = 0 }
    /^## v/ {
      if (in_section) exit
      if ($0 ~ "^## " v "( |$|—| —)") { in_section = 1; print; next }
    }
    in_section { print }
  ' "$REPO_ROOT/CHANGELOG.md" > "$NOTES_FILE"
  if [ ! -s "$NOTES_FILE" ]; then
    echo "WARN: extracted CHANGELOG section is empty; using generic body" >&2
    printf "Release %s\n\nSee https://www.ripperdoc.de/boardripper/changelog.html#%s\n" \
      "$VERSION" "$VERSION" > "$NOTES_FILE"
  fi
```

- [ ] **Step 2: Inject `notes` into the manifest JSON**

In the `cat > out/manifest.json <<EOF` heredoc, add a `notes` line right after the `"notes_url": ...,` line (mirror the `important_reason` pattern that uses `jq` to produce a JSON-safe string; `jq -Rs` reads the whole file as one raw string and JSON-encodes it):

```
  "notes_url": "https://www.ripperdoc.de/boardripper/changelog.html#$VERSION",
  "notes": $(jq -Rs . < "$NOTES_FILE"),
```

(The existing `jq . out/manifest.json >/dev/null` validity check right after the heredoc will catch any escaping error.)

- [ ] **Step 3: Reuse `NOTES_FILE` for the GitHub release (remove the duplicate slice)**

In the GitHub-release step (~line 616), DELETE the now-duplicated slice + empty-fallback block (the `NOTES_FILE="$(mktemp …)"` through the `if [ ! -s … ] … fi`), since `NOTES_FILE` already exists from Step 1. Keep the `GH_ARGS=(--title … --notes-file "$NOTES_FILE")` usage and the `gh release create` call as-is. Move the `rm -f "$NOTES_FILE"` cleanup to the very end of the script (after the GitHub-release block) so the file survives whether or not the GH release runs, and is always cleaned up.

- [ ] **Step 4: Add the runbook note**

In `docs/RELEASE_RUNBOOK.md`, add a one-line note in the manifest section: that `manifest.json` now carries a `notes` field = the `## vX.Y.Z` CHANGELOG section (shown in-app under the update dropdown's "What's new" spoiler), populated from the same slice as the GitHub Release body.

- [ ] **Step 5: Verify (syntax + the slice→inject mechanism, without a full release)**

A full release can't run here, so verify the script parses and the slice+inject mechanism is correct in isolation:

```bash
cd /Users/besitzer/Desktop/Boardviewer
bash -n scripts/release.sh && echo "SYNTAX OK"
# Mechanism check: slice a sample changelog, inject via jq, read it back.
TMP=$(mktemp -d); printf '## v9.9.9 — test\n\n### Features\n- A "quoted" line\n- second\n\n## v9.9.8 — old\n- ignored\n' > "$TMP/CHANGELOG.md"
NF="$TMP/notes"; awk -v v="v9.9.9" 'BEGIN{s=0} /^## v/{ if(s)exit; if($0 ~ "^## " v "( |$|—| —)"){s=1;print;next} } s{print}' "$TMP/CHANGELOG.md" > "$NF"
printf '{ "notes": %s }\n' "$(jq -Rs . < "$NF")" > "$TMP/m.json"
jq . "$TMP/m.json" >/dev/null && echo "VALID JSON"
jq -r .notes "$TMP/m.json" | head -1   # expect: ## v9.9.9 — test
jq -r .notes "$TMP/m.json" | grep -q 'A "quoted" line' && echo "QUOTES PRESERVED"
rm -rf "$TMP"
```
Expected: `SYNTAX OK`, `VALID JSON`, the first notes line is `## v9.9.9 — test`, and `QUOTES PRESERVED`. (The real end-to-end validation is the actual release run.)

- [ ] **Step 6: Commit**

```bash
git add scripts/release.sh docs/RELEASE_RUNBOOK.md
git commit -m "feat(release): embed CHANGELOG notes in the signed manifest (notes field)"
```

---

## Task 3: Frontend — wire the spoiler

**Files:**
- Modify: `src/frontend/src/store/update-store.ts` (the `Manifest` interface, ~line 41-52)
- Modify: `src/frontend/src/components/Toolbar.tsx` (`bodyLines` ~line 50; the render block ~line 82-94)
- Modify: `src/frontend/src/index.css` (small spoiler styles)

**Interfaces:**
- Consumes: `manifest.notes` (Task 1/2).
- Produces UI testids: `update-whats-new` (the `<details>`), reuse of the existing dropdown.

- [ ] **Step 1: Add `notes` to the frontend Manifest type**

In `update-store.ts`, in the `Manifest` interface, after `notes_url?: string;`:

```typescript
  notes?: string;
```

- [ ] **Step 2: Wire `bodyLines` from the manifest notes**

In `Toolbar.tsx`, replace `const bodyLines: string[] = [];` (~line 50) with:

```typescript
  // Release notes for an available update, embedded in the signed manifest.
  // Empty (→ spoiler not shown) when the manifest carries no notes.
  const bodyLines: string[] = (state.has_update && manifest?.notes)
    ? manifest.notes.split('\n')
    : [];
```

- [ ] **Step 3: Wrap the render block in a "What's new" spoiler**

Replace the existing block (currently `{bodyLines.length > 0 && ( <div className="update-dropdown-body"> … </div> )}`, ~line 82-94) with a `<details>` spoiler. Drop the obsolete `{!state.has_update && !updating && <h4>What's in this version</h4>}` sub-header (it only applied to a never-reached not-`has_update` case):

```tsx
          {bodyLines.length > 0 && (
            <details className="update-dropdown-notes" data-testid="update-whats-new">
              <summary>What&apos;s new</summary>
              <div className="update-dropdown-body">
                {bodyLines.map((line, i) => {
                  if (line.startsWith('## ')) return <h3 key={i}>{line.slice(3)}</h3>;
                  if (line.startsWith('### ')) return <h4 key={i}>{line.slice(4)}</h4>;
                  if (line.startsWith('- ')) return <li key={i}>{line.slice(2)}</li>;
                  if (line.startsWith('| ') || line.startsWith('---')) return null;
                  return <p key={i}>{line}</p>;
                })}
              </div>
            </details>
          )}
```

(The `{!state.has_update && !updating && bodyLines.length === 0 && ( … "You are on the latest version." … )}` block right below stays unchanged.)

- [ ] **Step 4: Add spoiler styles**

Append to `src/frontend/src/index.css` (≤ ~12 lines; reuse existing vars — grep for `--border`/`--text-secondary`/`--accent` and substitute if a name differs):

```css
.update-dropdown-notes { border-top: 1px solid var(--border); }
.update-dropdown-notes > summary { cursor: pointer; padding: 6px 12px; font-size: 12px; font-weight: 600; color: var(--text-secondary); user-select: none; }
.update-dropdown-notes > summary:hover { color: var(--text-primary); }
.update-dropdown-notes[open] > summary { color: var(--accent); }
.update-dropdown-notes > .update-dropdown-body { max-height: 240px; overflow-y: auto; }
```

- [ ] **Step 5: Verify build**

Run: `cd src/frontend && npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/store/update-store.ts src/frontend/src/components/Toolbar.tsx src/frontend/src/index.css
git commit -m "feat(update): What's-new spoiler in the update dropdown (wired to manifest.notes)"
```

---

## Task 4: Playwright e2e

**Files:**
- Create: `src/frontend/tests/update-whats-new.spec.ts`

**Interfaces:** consumes testid `update-whats-new` + the existing update badge.

- [ ] **Step 1: Identify the update-badge testid + status route**

Run: `grep -n "toolbar-update-badge\|data-testid\|update-badge\|/api/update/status" src/frontend/src/components/Toolbar.tsx | head` and `grep -rn "page.route\|/api/" src/frontend/tests/*.spec.ts | head`
Note the badge's selector (class `toolbar-update-badge`; add a `data-testid="update-badge"` to it in Toolbar.tsx if no stable testid exists — that's a one-line change you may include in this task's commit) and how other specs intercept `/api/*` routes.

- [ ] **Step 2: Write the spec**

Create `src/frontend/tests/update-whats-new.spec.ts`. Mock the update status so the test is backend-independent:

```typescript
import { test, expect } from '@playwright/test';

const STATUS_WITH_NOTES = {
  current_version: 'v0.31.26',
  latest_version: 'v0.31.27',
  has_update: true,
  docker_available: true,
  manifest: {
    version: 'v0.31.27', counter: 61, released_at: '', not_after: '', important: false,
    notes_url: 'https://www.ripperdoc.de/boardripper/changelog.html#v0.31.27',
    notes: '## v0.31.27\n\n### Features\n- Shiny new thing\n- Another thing',
    tarball: { url_primary: '', sha256: '', size_bytes: 0 },
    image: { registry: '', tag: 'v0.31.27', digest: '' },
  },
};

async function openUpdateDropdown(page) {
  // The badge toggles the dropdown. Use the badge testid (Step 1) or the class.
  await page.locator('.toolbar-update-badge').click();
}

test('update dropdown shows a What\'s new spoiler with the manifest notes', async ({ page }) => {
  await page.route('**/api/update/status', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(STATUS_WITH_NOTES) }));
  await page.goto('/');
  await openUpdateDropdown(page);

  const spoiler = page.getByTestId('update-whats-new');
  await expect(spoiler).toBeVisible();
  const box = await spoiler.boundingBox();
  expect(box).not.toBeNull();
  const vp = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width + 1);

  // Collapsed by default — expand and assert the notes render.
  await spoiler.locator('summary').click();
  await expect(spoiler).toContainText('Shiny new thing');
  await expect(spoiler).toContainText('Another thing');
});

test('no spoiler when the manifest has no notes', async ({ page }) => {
  const noNotes = { ...STATUS_WITH_NOTES, manifest: { ...STATUS_WITH_NOTES.manifest, notes: undefined } };
  await page.route('**/api/update/status', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(noNotes) }));
  await page.goto('/');
  await openUpdateDropdown(page);
  await expect(page.getByTestId('update-whats-new')).toHaveCount(0);
});
```

> If the update badge isn't visible/clickable in the test environment, or the dropdown needs another trigger, adapt the open step to the real UI you found in Step 1 — but keep the route-mock approach so the test is deterministic and backend-independent. If a genuine harness limitation blocks even the mocked path, scope down with a top-of-file comment naming the gap (don't fake a pass).

- [ ] **Step 3: Run the spec**

Run: `cd src/frontend && npx playwright test tests/update-whats-new.spec.ts`
Expected: PASS (2 tests). The "No available adapters" WebGL warning is expected and unrelated.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/tests/update-whats-new.spec.ts src/frontend/src/components/Toolbar.tsx
git commit -m "test(update): e2e What's-new spoiler shows/omits on manifest notes"
```

---

## Self-Review

**1. Spec coverage**

| Spec requirement | Task |
|---|---|
| `notes` field in signed manifest | 1 (Go field) + 2 (release.sh populates) |
| Notes embedded, signature-covered, omitempty | 1 (test asserts both) |
| release.sh injects from the same CHANGELOG slice as the GH release | 2 |
| Frontend `Manifest.notes?` | 3 (Step 1) |
| "What's new" `<details>` spoiler, collapsed by default | 3 (Step 3) |
| Reuse the existing line renderer (no new markdown lib) | 3 (Step 3 keeps the existing map) |
| Scrollable, capped height | 3 (Step 4 CSS) |
| Absent notes → no spoiler, link remains | 3 (bodyLines empty) + 4 (test 2) |
| Runbook note | 2 (Step 4) |
| Backend round-trip + sign test | 1 |
| Frontend e2e | 4 |

**2. Placeholder scan** — One flagged confirm-and-adjust: the update-badge open selector / optional `data-testid="update-badge"` (Task 4 Step 1) and the route-mock open step. The full release-pipeline run is the integration test for Task 2 (explicitly the "then release" step), with a self-contained mechanism check in Task 2 Step 5. No silent gaps.

**3. Type consistency** — `Manifest.Notes` (Go, Task 1) ↔ `manifest.notes?: string` (TS, Task 3) ↔ JSON key `notes` (release.sh Task 2, e2e mock Task 4) all aligned. `bodyLines: string[]` shape unchanged (Task 3 only changes its source). Testid `update-whats-new` consistent (Task 3 ↔ 4).
