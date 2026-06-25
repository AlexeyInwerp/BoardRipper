# Update "What's New" Spoiler — Design

- **Date:** 2026-06-25
- **Status:** Approved (design); implementation plan to follow
- **Scope:** Show the release notes for an available update inline, under a collapsible "What's new" spoiler in the toolbar update dropdown — sourced from a new `notes` field embedded in the signed update manifest.

## Problem

When an update is available, the toolbar update badge → dropdown ([Toolbar.tsx](../../src/frontend/src/components/Toolbar.tsx)) shows the version, an "Update Now" button, and a **"Release notes ↗" link** to `manifest.notes_url` (an HTML changelog page on ripperdoc.de). The user wants to read *what's new* **inline** — without leaving the app — before deciding to update.

## Current state (verified)

- The signed `Manifest` ([src/backend/updater/manifest.go](../../src/backend/updater/manifest.go)) carries `notes_url` (= `https://www.ripperdoc.de/boardripper/changelog.html#<version>`) but **no note text**.
- The update badge dropdown ([Toolbar.tsx:74-150](../../src/frontend/src/components/Toolbar.tsx)) renders the version tag, `important_reason` (when important), the Update-Now button, and the external "Release notes ↗" link.
- **A dead notes renderer already exists in the dropdown:** `const bodyLines: string[] = []` (Toolbar.tsx:50) is never populated, but a full line-renderer gated on `bodyLines.length > 0` (Toolbar.tsx:82-94) turns `## `/`### `/`- ` prefixes into `<h3>`/`<h4>`/`<li>` and other lines into `<p>`. It is an un-wired stub for exactly this feature — wiring it to the manifest notes gives light-markdown formatting for free.
- `release.sh` already **slices the `## vX.Y.Z` section out of `CHANGELOG.md`** into a temp `NOTES_FILE` and passes it to `gh release create --notes-file` (release.sh ~line 616-633). It builds the manifest JSON (where `notes_url` is set, ~line 352) and signs it (Ed25519/minisign). The whole manifest JSON is covered by the signature.

## Goals

- A collapsible **"What's new"** spoiler in the update dropdown that shows the release notes **inline** for an available update.
- Notes travel **inside the signed manifest** (trusted, offline) — no cross-origin fetch or HTML scraping.
- Graceful fallback: when a manifest has no `notes` (older releases, or a release where the slice was empty), the spoiler is **not rendered** and the existing "Release notes ↗" link remains.

## Non-goals

- Retroactive notes for already-published manifests (the current v0.31.26 manifest has no `notes`). The feature appears for releases cut **after** this change ships.
- A **new** markdown library — none is added. The notes reuse the dropdown's **existing** line renderer (`## `/`### `/`- ` → `<h3>`/`<h4>`/`<li>`), which is already in the code. (This supersedes the original "plain preformatted" rendering choice: since a light-markdown renderer already exists as a dead stub, reusing it is DRY and nicer at zero extra cost — the reason plain-text was preferred, "avoid adding a renderer," no longer applies.)
- Changing `notes_url` (the external link stays as a "full changelog" affordance).
- Fetching `notes_url` client-side (rejected: cross-origin/CORS, HTML parsing, breaks offline).

## Design

### Backend — manifest schema

Add one field to `Manifest` ([manifest.go](../../src/backend/updater/manifest.go)):

```go
Notes string `json:"notes,omitempty"`
```

No verification change is needed: the minisign signature covers the entire manifest JSON, so `notes` is automatically protected, and `omitempty` keeps older-style manifests (and tests) unaffected.

### Release pipeline — populate `notes`

`release.sh` already extracts the `## $VERSION` changelog section into `NOTES_FILE`. When it builds the manifest JSON, inject that file's contents into the `notes` field **as a JSON-safe string** before signing — reuse the same slice that feeds the GitHub release so the in-app notes and the GH release body are identical by construction. Use `jq --rawfile notes "$NOTES_FILE" '.notes = $notes'` (or equivalent) so multi-line markdown with quotes/newlines is correctly escaped. If the slice is empty, leave `notes` unset (the `omitempty` + frontend fallback handle it). The `RELEASE_RUNBOOK` note for the manifest is updated to mention the field.

### Frontend — type + spoiler (reuse the existing renderer)

- Add `notes?: string` to the `Manifest` interface ([update-store.ts](../../src/frontend/src/store/update-store.ts)).
- In the update dropdown ([Toolbar.tsx](../../src/frontend/src/components/Toolbar.tsx)), **wire the existing `bodyLines` stub** to the manifest notes for the available-update case:
  - `const bodyLines: string[] = (state.has_update && manifest?.notes) ? manifest.notes.split('\n') : [];`
  - Wrap the existing `bodyLines.length > 0` render block in a collapsible **`<details>`** with `<summary>What's new</summary>`, **collapsed by default** (the user opts in to reading). The block's existing line-rendering map (the `## `/`### `/`- `/`<p>` logic) is reused unchanged inside the spoiler.
  - The body scrolls (`max-height` + `overflow-y: auto`) so a long changelog doesn't blow out the dropdown.
- Drop the now-obsolete `{!state.has_update && <h4>What's in this version</h4>}` sub-header inside that block (it only made sense for a never-reached not-`has_update` case). The "You are on the latest version." fallback for not-`has_update` (Toolbar.tsx:95-99) is unchanged.
- When `manifest.notes` is absent/empty, `bodyLines` is `[]` → the spoiler is not rendered; the existing "Release notes ↗" link remains the only notes affordance.

New CSS is small (≤ ~12 lines) for the `<details>`/`<summary>` + scroll, reusing existing dropdown variables.

## Edge cases

- **No notes in manifest** → spoiler omitted; "Release notes ↗" link unchanged.
- **Very long notes** → spoiler body is scrollable (capped height); the dropdown stays usable.
- **Notes present but `notes_url` absent** → spoiler shows; the link is independently conditional (unchanged).
- **Important update** → `important_reason` line stays above the spoiler; both can show.

## Testing

- **Backend (Go):** a `Manifest` with `Notes` set round-trips through JSON marshal/unmarshal, and a manifest carrying `notes` still verifies against a signature computed over the full JSON (the existing sign/verify test extended with a `notes` value).
- **Frontend (Playwright):** mock `GET /api/update/status` via `page.route` to return `has_update: true` with a `manifest.notes` string; open the update badge dropdown; assert the "What's new" `<details>` is present and, when expanded, its body contains the seeded notes text. A second case with `manifest.notes` absent asserts the spoiler is **not** rendered (link-only). Geometry-assert the dropdown per the project's floating-UI rule.
- **Release pipeline:** a `--dry-run`/manual check that the generated `manifest.json` contains a non-empty `notes` matching the CHANGELOG section (documented in the runbook).

## Rollout

- Additive: one new optional manifest field, one `release.sh` injection step, one frontend type field + a conditional spoiler. No signature/verification change, no schema migration. Appears for the next release onward; older manifests fall back to the link.
