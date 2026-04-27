# Library History — Favorites & Click-Behavior Fix

**Date:** 2026-04-27
**Scope:** `src/frontend/src/panels/LibraryPanel.tsx` (`HistoryView`) and `src/frontend/src/store/databank-store.ts`.

## Goal

Two related improvements to the Library panel's History tab:

1. **Favorites** — let users pin selected history entries to the top of the list. Pinned entries are visually distinguished and survive history-cap trimming.
2. **Click-behavior consistency** — History rows currently open on single-click, while every other view tab uses single-click to select and double-click to open. Align History with the rest.

## Non-Goals

- No favorites for files outside History (Metadata / Model / Folders tabs already use a different interaction model and are out of scope).
- No drag-to-reorder. Pin order follows the same `openedAt` recency rule as the rest of the list.
- No syncing of favorites between devices or to the backend. Persistence is localStorage-only, matching the existing history.
- No keyboard shortcut for toggling pin. Mouse-only for v1.

## User Stories

- *As a repair tech, I want to pin the boards I work on every day to the top of my history so I don't have to scroll past one-off opens to reach them.*
- *As a user, I want clicking a history entry to behave the same as clicking a file in any other Library tab — show me details, then double-click to open — so I don't accidentally load a 200 MB Allegro file just by clicking the wrong row.*

## Design

### Click-behavior fix

`HistoryView` currently wires `onClick={() => onOpenFile(...)}` directly. Replace with the same pattern `FileRow` uses:

- **Single-click on a row with a resolvable `dbFile`:** call `databankStore.selectFile(dbFile.id)` + `databankStore.fetchFileDetail(dbFile.id)` so the `FileDetailPane` appears at the bottom of the panel. Add a `selected` class when `selectedFileId === dbFile.id`.
- **Double-click on a row with a resolvable `dbFile`:** call `onOpenFile(dbFile)` — same path as today.
- **Rows with no `dbFile` (missing-from-library):** click and double-click are inert. Keep the existing `library-file-missing` styling.

Wire it through the existing `handleSelectFile` callback in `LibraryPanel` so the History view receives both `onSelectFile` and `onOpenFile`. No new store APIs needed.

### Favorites — data model

New persisted field on `databankStore`:

```ts
private _favoritePaths: Set<string> = (() => {
  try {
    const raw = localStorage.getItem('boardripper-favorites');
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch { return new Set(); }
})();

get favoritePaths() { return this._favoritePaths; }

isFavorite(path: string): boolean {
  return this._favoritePaths.has(path);
}

toggleFavorite(path: string): void {
  const next = new Set(this._favoritePaths);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  this._favoritePaths = next;
  try { localStorage.setItem('boardripper-favorites', JSON.stringify([...next])); } catch { /* ignore */ }
  this.notify();
}
```

Storage key: `boardripper-favorites`. Separate from `boardripper-history` so favorites survive a history clear. Identity is by `path` (matching the existing `RecentItem` identity) — robust to file-id changes if the databank is rescanned.

### Favorites — exemption from history-depth cap

In `addToHistory`:

- Today: trims `_recentItems` to `_historyDepth` indiscriminately.
- New: when trimming, drop the oldest **non-favorite** entries first. Favorite entries are exempt and never trimmed by the cap. The cap continues to apply to the count of non-favorite entries only.

In `setHistoryDepth`: same semantics — apply the cap to non-favorite entries only when shrinking.

In `clearHistory`: continues to wipe `_recentItems` entirely. Favorites in `_favoritePaths` are untouched (separate store). A pinned entry that is no longer in `_recentItems` simply doesn't render until the user opens that file again, at which point `addToHistory` re-adds it and it lands in the pinned section.

### Favorites — sort & rendering

In `HistoryView`, partition `filteredItems` into two arrays:

```ts
const pinned: RecentItem[] = [];
const recent: RecentItem[] = [];
for (const item of filteredItems) {
  (databankStore.isFavorite(item.path) ? pinned : recent).push(item);
}
// Both arrays are already sorted most-recent-first because addToHistory unshifts.
```

Render:

1. Pinned rows.
2. A 1px divider element (`<div className="library-history-divider" />`) — only when both arrays are non-empty.
3. Non-pinned rows.

The divider is a 1px horizontal line in `--color-border-subtle` with ~6px vertical margin. No header label; the visible pin icons on rows above are the affordance.

### Favorites — toggle UI

Each history row gets a pin button on the right edge, after the timestamp:

- **Pinned row:** `<IconPinFilled size={14} />` — always visible. Clicking toggles off.
- **Non-pinned row:** `<IconPin size={14} />` — hidden by default, revealed on row hover. Clicking toggles on.

Implemented as a `<button>` (not a `<span>`) for proper click-target accessibility. `e.stopPropagation()` on its `onClick` so toggling pin doesn't also fire the row's select handler.

CSS:

```css
.library-history-pin {
  /* baseline: hidden, no layout shift on reveal */
  visibility: hidden;
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 0 4px;
}
.library-file-row:hover .library-history-pin,
.library-history-pin.is-pinned {
  visibility: visible;
}
.library-history-pin.is-pinned {
  color: var(--accent);
}
.library-history-pin:hover { color: var(--text-primary); }

.library-history-divider {
  height: 1px;
  background: var(--border);
  margin: 6px 8px;
}
```

Tokens come from the existing `:root` block in `src/frontend/src/index.css` (`--accent`, `--text-primary`, `--text-secondary`, `--border`).

### Icon choice

`IconPinFilled` (filled state) + `IconPin` (outline state) from `@tabler/icons-react`. The pin metaphor reads universally as "pinned to top of list," and PCB pins are the project's daily vocabulary — the double-meaning is on-brand without being kitsch.

## Affected Files

- `src/frontend/src/store/databank-store.ts` — add `_favoritePaths`, `favoritePaths`, `isFavorite`, `toggleFavorite`; modify `addToHistory` and `setHistoryDepth` to apply the cap to non-favorites only.
- `src/frontend/src/panels/LibraryPanel.tsx` — modify `HistoryView` to render pinned/recent partitions, divider, pin toggle button; rewire row click/double-click to match `FileRow` pattern; pass `onSelectFile` from `LibraryPanel` to `HistoryView`.
- `src/frontend/src/panels/LibraryPanel.tsx` (or sibling stylesheet) — add `.library-history-pin`, `.library-history-divider` rules.
- Imports: add `IconPin`, `IconPinFilled` to the existing `@tabler/icons-react` import in `LibraryPanel.tsx`.

## Edge Cases

- **Pinning a file that has no `dbFile` lookup result.** Allowed — favorites are keyed by path, not id, so a pinned entry whose underlying file has been moved/deleted from the databank still renders, still in the pinned section, with the existing `library-file-missing` styling. Double-click stays inert.
- **Unpinning the last pinned item.** The divider disappears (only rendered when both partitions are non-empty). No re-layout artifact expected.
- **Search filter active.** The partition runs on `filteredItems`, not the full `recentItems`. So a search that matches no pinned entries hides the pinned section entirely (and the divider). Same for the inverse.
- **History-depth shrinkage with many favorites.** If the user sets depth to 5 and has 10 favorites + 50 non-favorites, the 50 non-favorites trim to 5, all 10 favorites remain. Total displayed: 15 rows. This is intentional — favorites express explicit user intent and the cap is meant to bound clutter, not curated entries.
- **`addToHistory` for an already-favorite file.** The existing dedupe (`filter(r => r.path !== file.path)`) runs first, then unshifts. The new entry is *not* automatically marked favorite — but since `_favoritePaths` is keyed by path independently, the new entry is recognized as favorite by `isFavorite(path)` and renders in the pinned section. No special handling needed.
- **Clearing history while items are favorited.** `clearHistory` wipes `_recentItems` only; `_favoritePaths` is untouched. After clear, opening a previously-favorited file re-adds it to history and it appears in the pinned section.

## Testing

- **Manual smoke:** open three files, pin one. Reload. Verify pinned item is at top with filled icon, non-pinned below divider with outline icon (on hover only).
- **Manual click-behavior:** in the History tab, single-click a row → detail pane appears. Double-click → file opens. Confirm parity with the same actions on a Folder-tab `FileRow`.
- **Manual cap exemption:** set `historyDepth` to 5, pin 3 files, open 10 more. Verify all 3 pinned remain plus the 5 most-recent non-pinned (8 total).
- **Manual missing-file path:** pin a file, then rescan a library that no longer contains it. Verify pinned row still appears with `library-file-missing` styling and is click-inert.
- **No new automated tests required** — the existing Playwright suite doesn't cover the History tab in detail, and the changes are localized UI state that's faster to validate by hand. (A follow-up to add Playwright coverage for History interactions could be a separate task.)

## Out of Scope / Follow-Ups

- Drag-to-reorder pinned items.
- Keyboard shortcut for pin toggle.
- Cross-device sync of favorites (would require a backend round-trip and conflict resolution).
- Bulk pin/unpin from a context menu.
- Showing favorite badges on rows in non-History tabs.
