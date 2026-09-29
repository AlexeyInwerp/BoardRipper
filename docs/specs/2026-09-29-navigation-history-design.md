# Navigation history — design

**Date:** 2026-09-29
**Status:** shipped on main 2026-09-29 (phases 1–4; not yet in a release).
Left out of the phase 4 as built: the Library search surface and the MCP
`history_*` tools — see §11.
**Scope:** a multi-layer history of where the user has been — part clicks,
PDF lookups, searches, viewpoints — walkable with Preview's ⌘[ / ⌘] and
browsable in a History tab with each layer switchable on and off.

---

## 1. The problem

A repair session is a walk: click U1700, follow pin C4 to `PP3V3_S2_SMC`,
jump to the schematic page the lookup found, click a net name there, land on
the board again, search for a refdes, pick a result, zoom into a corner.
Twenty steps later the tech wants to be back at step six. Today nothing in
BoardRipper records where the user was. There is no back, no forward, no list
of recent places, and the only camera pose ever saved is a manual PDF bookmark
(`pdf-store.ts` `PdfBookmark`). Every "where was I" costs the user another
search.

The comparison the user made is macOS Preview: **Go ▸ Back / Forward
(⌘[ / ⌘])** step through the pages you visited — whether you got there by
scrolling, by a search hit or by the thumbnail sidebar — and the find field
keeps its recent searches. That is the model here, extended to a workspace
where a "page" can be a part on a board, a match in a PDF, a query, or a
region of the board.

Groundwork (2026-09-29) settled these facts about the code the feature has to
hook into:

- Selection is per tab and mutated by exactly seven public store methods plus a
  handful of direct `tab.selection = emptySelection` resets
  (`board-store.ts` `selectPart`, `selectPin`, `highlightNet`,
  `selectPinInTab`, `focusPart`, `promotePartOnNet`, `focusNet`).
  `partIndex` is **not stable** across fold-mode, revision, ghost-hide and BOM
  changes; refdes and net name are, which is why `partOverrides`,
  `bomClusterSelections` and the worklist all key by name.
- PDF position moves in four places only: `_runSearch`, `_stepMatchInDoc`,
  `setActiveMatchIndex`, `goToPage`. `crossProbe` and `navigateToText` sit on
  top of them. A match is `(pageIndex, itemIndex, charStart, charEnd)`.
- The board camera lives only in the renderer (`viewportStates`, a `WeakMap`
  keyed by `BoardData` identity); the PDF camera lives in
  `PdfViewerPanel` refs. Neither store knows the camera. `FocusRequest` is the
  one-shot mailbox stores use to move the board camera.
- Five search surfaces, no shared query model: toolbar global search
  (`Toolbar.tsx` `GlobalSearch` → `cross-target-search.ts`), the board
  sidebar Search tab (`boardStore.setSearch` + `focusPart`/`focusNet`), the
  ribbon parts/nets `FilterDropdown`, PDF find (`pdfStore.searchText`), and
  the context menu.
- ⌘[ and ⌘] are unbound (`store/keyboard-shortcuts.ts`); Alt+arrows are pan.
  Shortcuts are a static registry plus a `switch` in
  `hooks/useKeyboardShortcuts.ts`; they are not user-rebindable.
- Precedents: Library ▸ Recent (`databankStore.addToHistory`, localStorage
  `boardripper-history`, depth-capped, dedupe by path, favourites survive the
  trim) is the closest existing shape for a persisted, capped recall list.
  `session-store.ts` restores which files are open, never where you were.

---

## 2. What is a history entry — variants reviewed

The user named four layers: part clicks, PDF lookups, explicit searches,
navigational points. The question is how they relate. Four structures were
considered.

### A. One flat log, tagged by kind, layers are filters

Every event appends `{kind, target, time}`; ⌘[ walks the log backwards,
skipping kinds that are switched off. Simple and browser-like. **Fails on
causality:** one click on U1700 with PDF-follow on produces a selection, a PDF
search and a page jump — three rows, three back-stops, for one act. The user
would press ⌘[ three times to undo one click.

### B. One stack per layer, the focused panel picks the stack

Selections, PDF positions, searches and viewpoints each keep their own
back/forward cursor; ⌘[ acts on the stack of the panel that has focus. This
is how Preview separates Go ▸ Back from the find field's recents. **Fails on
the cross-document step**, which is the case the "PDF lookups" layer exists
for: back from a PDF page you reached by a board click should land on that
board click, and no single-panel stack can express it. It also makes the
shortcut modal — the user must know which stack is live.

### C. One timeline of *visits*; the cause is the layer, the place is a facet

A visit is *where the user ended up* and *how they got there*:

```
entry = { cause, place, query?, camera, time }
  cause  ∈ click | lookup | search | view        ← the four layers
  place  = a board place (tab, refdes, pin, net, side)
         | a PDF place (doc, page, match)
         | null (a query with no chosen result)
```

A search that ends in a picked result is **one** entry: cause `search`, query
`"ppbus"`, place `C7001`. A board click with PDF-follow is **one** entry:
cause `click`, place `U1700`, plus an informational `follow` facet naming the
page the follow landed on. A cross-document jump the user made deliberately —
double-click, "Search in PDF", a word click in the PDF — is one entry with
cause `lookup` whose place is the destination. A settled manual camera move
is one entry with cause `view` and a camera-only place.

Layers are then a filter over `cause`: each toggle decides whether entries of
that cause are listed and whether ⌘[ stops on them. One act, one row, one
stop. **Chosen.**

### D. C plus a "workspace snapshot" per entry

Same as C but every entry stores the camera of *every* visible panel, so back
also moves panels the user did not act in. Rejected for now: it makes back
move the PDF when the user only expects the board to move, and doubles the
restore surface. An entry stores the camera of its own panel only; the follow
facet is informational. Revisit if users ask for "put everything back".

---

## 3. Semantics that were worth arguing about

### 3.1 Where does back go — browser truncation or a jumplist?

Timeline `A B C D`, two backs (cursor on B), then a click on E.

| rule | list after | back from E | verdict |
|---|---|---|---|
| browser: truncate forward | `A B E` | B | rows C, D vanish from a tab that is supposed to be a record |
| append only | `A B C D E` | D | the user was on B when they clicked; D is a surprise |
| **Vim jumplist: re-anchor** | `A B C D B′ E` | B, then D, C, B, A | nothing lost, back is where you just were |

The jumplist wins: **a new visit while the cursor is not at the end first
re-appends the entry under the cursor (marked `revisit`), then the new one.**
The tab shows the true sequence of places looked at, including via back, and
back is always "where I just was". Back and forward themselves move the cursor
and never append, so stepping cannot oscillate.

### 3.2 The camera is recorded at departure, like browser scroll restoration

Select U1700 (camera at A), pan by hand to region R, click C2. Back should
show U1700 selected *at R* — that is the state the click left. So **pushing a
non-view entry first writes the current camera into the entry under the
cursor**, then appends. Back then restores exactly the pose the user left,
and forward the pose they left the newer entry in. Back and forward do this
too, so a round trip is exact.

Pushing a `view` entry skips that write: the view entry *is* the departure
record, and writing the settled camera into the previous entry would make
"back, back" show the same region twice.

### 3.3 Collapsing

- **Consecutive same place → replace**, updating time and camera. Pin-walking
  across a BGA (U1700 pin A3, A4, A5…) is one row `U1700 · pin A5` and one
  back-stop; back goes to the previous *part*. Stepping PDF matches of one
  query updates the search entry's match index, not a new entry.
- **Non-consecutive repeats are kept.** `U1 → C5 → U1` is a real path; the
  Library ▸ Recent rule (dedupe by identity) is right for files and wrong for
  a walk.
- **Query growth collapses:** `PPB`, `PPBU`, `PPBUS` typed within one editing
  run replace each other; a query is committed on Enter, on a result pick, or
  1.5 s after the last keystroke, whichever comes first.
- **Deselects are not entries.** Clicking empty canvas is not a navigation
  (Preview does not record a deselect either); the departure rule still
  captures the camera.

### 3.4 Layer toggles: filter for three, record-gate for one

Clicks, lookups and searches are **always recorded** and the toggle only
filters listing and stepping — switching a layer back on shows what happened
while it was off. Viewpoints are **recorded only while the layer is on**: a
settled manual move while it is off is folded into the current entry's camera
(the departure rule), which is the browser behaviour and what most users
expect by default. The user-visible contract is the same for all four ("this
layer is listed and ⌘[ stops there"); the difference in recording is an
implementation choice documented here, not a UI distinction.

Defaults for a fresh install: clicks on, lookups on, searches on, viewpoints
**off** (the noisiest layer, and the departure rule already gives "back to
where I was" without it). Persisted in `boardripper-history-layers`.

### 3.5 What counts as a viewpoint (layer 4)

Brainstormed and ranked:

1. **A settled manual camera move that left the previous view** — the
   viewport's `moved` event with a user `type` (`drag`, `wheel`, `pinch`,
   keyboard pan via `viewCommands`; never `animate`, which is `zoomToBounds`,
   fit and history restore), settled 500 ms (the renderer's existing
   `zoomSettleTimer` cadence), and the new view rectangle overlaps the entry's
   recorded one by less than 30 % or the zoom changed by more than 2×. Smaller
   moves update the camera in place. Named by `findLargestPartNearCenter()`
   ("near U1700 · 3.2×").
2. **A tab switch** (`switchTab` not caused by a restore): a view entry for
   the tab arrived at, with its current camera. Without it the visit to the
   other board is invisible in the list.
3. **A manual PDF page change** (`goToPage`, scroll-flip, arrow keys — not a
   search) settled 500 ms: `doc · p.49`. Pan/zoom within a page updates the
   camera in place.
4. **Fit to board** (button or shortcut): a view entry, because it is a
   deliberate "go to the overview".
5. *Explicit marks* ("pin this view") — same entry type with a `pinned` flag
   that survives the cap, like Library favourites. Not in scope; the PDF
   already has bookmarks and a board version is a later, separate ask.

So the hierarchy the user asked to brainstorm: navigational points are **not a
peer of the other three causes in the user's intent** — they are the return
addresses of everything else (3.2) and only become rows of their own when the
user opts in. That is why the layer is off by default and why its toggle gates
recording.

### 3.6 Global timeline, one cursor, entries carry their panel

One timeline across all boards and PDFs. Restoring an entry on another tab
switches to it (`switchTab` + `activateLinkedPanel`, which already handles
the 2-window popout); restoring a PDF entry runs `ensurePdfPanel` +
`switchTo`. An entry whose file is closed is kept, shown greyed with the file
name, skipped by ⌘[ / ⌘], and (phase 4) reopened on click through
`openLibraryFileById` when it carries a `fileId`.

### 3.7 Cap

300 entries in memory, oldest dropped first. Pinned entries (future) survive
the trim like Library favourites do.

---

## 4. Data model

`src/frontend/src/store/nav-history-store.ts` — an `Emitter` store with the
usual `createStoreHook` adapter (`hooks/useNavHistory.ts`); the reducer is a
pure module (`store/nav-history.ts`) so it unit-tests without the app.

```ts
export type NavCause = 'click' | 'lookup' | 'search' | 'view';

export interface BoardCamera { x: number; y: number; scaleX: number; scaleY: number }
export interface PdfCamera   { zoom: number; panX: number; panY: number }

export type NavPlace =
  | { kind: 'board'; tabId: number; fileKey: string; fileId?: number; fileName: string;
      part?: string;            // refdes — never partIndex
      pin?: string;             // pin number as displayed; the index is re-resolved
      net?: string;
      side?: 'top' | 'bottom' | 'both';
      boardIndex?: number;      // XZZ board packs
      camera?: BoardCamera }
  | { kind: 'pdf'; fileName: string; fileId?: number;
      page: number;             // 1-based, like PdfDocument.currentPage
      match?: { pageIndex: number; itemIndex: number; charStart: number; charEnd: number };
      camera?: PdfCamera };

export interface NavQuery {
  surface: 'board' | 'global' | 'pdf' | 'ribbon-parts' | 'ribbon-nets';
  text: string;
  results?: number;             // for the row: "14 results"
  tabId?: number; pdfFileName?: string;
}

export interface NavEntry {
  id: number;
  cause: NavCause;
  at: number;                   // Date.now()
  place: NavPlace | null;       // null = a query nobody picked from
  query?: NavQuery;
  follow?: { fileName: string; page: number; matchIndex: number }; // auto PDF-follow, informational
  from?: string;                // label of the place the jump started from (lookups)
  revisit?: boolean;            // re-anchor copy (3.1)
  label: string;                // computed once, e.g. "U1700 · A3 · PP3V3_S2_SMC"
}

export interface NavHistoryState {
  entries: NavEntry[];
  cursor: number;               // index into entries; -1 when empty
  layers: Record<NavCause, boolean>;
}
```

Reducer API (pure): `push(state, entry)` (departure write + re-anchor +
collapse + cap), `touchCamera(state, camera)`, `step(state, dir, layers)` →
next index honouring filters, `jumpTo(state, id)`, `setLayer`, `clear`,
`dropTab(tabId)` (marks entries unreachable, keeps them).

Store API: `record(entry)`, `back()`, `forward()`, `jumpTo(id)`,
`canBack` / `canForward` (filter-aware, for button state), `isRestoring`
(re-entrancy guard: while a restore replays through the normal store
methods, `record` is a no-op).

---

## 5. Recording — every site, one table

Cause is decided at the choke points, not sprinkled through components.
The seven selection mutators gain an optional trailing `cause?: NavCause`
with a default per method; the few callers whose intent differs pass it.

| event | site | cause | notes |
|---|---|---|---|
| canvas click / tap on part or pin | `BoardRenderer.handleClick` → `selectPart` / `selectPin` | `click` (default) | null selection is not recorded |
| net highlighted from a pin / Net List | `highlightNet`, `promotePartOnNet` | `click` | place carries `net` |
| sidebar Search result picked | `SearchTab` → `focusPart` / `focusNet` | `search` (default for `focus*`) | completes the pending query entry (3.3) |
| global search row | `cross-target-search.findInBoardTab` / `findInPdf` | `search` | query surface `global` |
| ribbon parts / nets pick | `FilterDropdown.onSelect` | `search` | surface `ribbon-*`; passes cause explicitly since it may call `selectPart` |
| PDF find (⌘F, Enter) | `pdfStore.searchText(q, 'user')` | `search` | surface `pdf`; match stepping updates the entry |
| board query typed (no pick) | `boardStore.setSearch` | `search`, place null | committed by the 1.5 s / Enter / blur rule |
| worklist row click | `WorklistPanel` → `selectPinInTab` | `click` | |
| MCP `select_part` / `highlight_net` | `mcp-bridge.ts` | `click` | tagged `via: 'mcp'` for the row glyph |
| double-click / "Search in PDF" | `triggerFollowPdf(part, force=true)`, `ContextMenu.doPdfSearch` | `lookup` | `from` = current board place |
| PDF word click → board | `PdfViewerPanel.handleTextClick` → `focusPart` / `focusNet` | `lookup` (passed explicitly) | `from` = `doc · p.N` |
| PDF → PDF cross-probe | `pdfStore.crossProbe` | `lookup` | |
| auto PDF-follow | `triggerFollowPdf(part, force=false)` → `lookupEntity` | **no entry** | writes `follow` on the current entry |
| settled manual board move | `viewport.on('moved')` user types + settle | `view` | only while the layer is on (3.4) |
| tab switch | `switchTab` (not from a restore) | `view` | |
| manual PDF page change | `goToPage`, scroll-flip, arrows | `view` | settled 500 ms |
| fit to board | `fitToBoard` from button / shortcut | `view` | |
| `previewPart`, revision / fold / BOM resets, `selectPart(null)` | — | **no entry** | camera moves from `previewPart` are `animate`, so the settle detector ignores them |

Reading the camera at departure: board through `renderer-registry`
(`getActiveApp()` → the renderer's viewport `position` / `scale`; a small
`getViewportState(tabId)` accessor is added), PDF through a new provider the
panel registers on mount — `pdfStore.registerCameraProvider(fileName, fn)` —
mirroring how the panel already hands `addBookmark` its zoom and pan.

---

## 6. Restoring

`restore(entry)` runs with `isRestoring` set and replays through the normal
store methods so every consumer (renderer, sidebar, PDF-follow, MCP bridge)
sees an ordinary selection change:

**Board place.** `switchTab` if needed → `activateLinkedPanel` → resolve the
refdes on `tab.board` (the raw parse; a part missing after a revision switch
is a soft failure: toast "U1700 is not on this revision", cursor moves
anyway) → side via `showTop`/`showBottom` → `selectPinInTab` / `focusPart` /
`highlightNet` with `cause` suppressed → camera: a new renderer method
`animateToViewport(state)` reusing the 400 ms ease of `zoomToBounds`
(exact pose, not a fit; a fit is what the user did *not* want when they
pressed back) → `startSelectionBlink()` so the eye finds the part.

**PDF place.** `ensurePdfPanel` → `switchTo` → if the entry has a query and
the doc's current query differs, `_runSearch` with source `'lookup'` and
`setActiveMatchIndex` to the recorded match; else `goToPage` → camera via a
one-shot mailbox `pdfStore.requestCamera(fileName, camera)` drained by the
panel like `consumeFollowTarget`.

**Query without place.** Board: `openBoardSearch(text, tabId)`. Global:
focus the toolbar field with the text. PDF: `searchText(text, 'user')`.

PDF-follow re-fires on a restored board selection exactly as it does on a
click. That is accepted: the entry's `follow` facet is for the row, not a
promise that the PDF will not move.

---

## 7. Shortcuts

| binding | action | Preview equivalent |
|---|---|---|
| ⌘[ (Ctrl+[ elsewhere) | `historyBack` | Go ▸ Back |
| ⌘] (Ctrl+] elsewhere) | `historyForward` | Go ▸ Forward |

Both are added to `shortcuts[]` in `store/keyboard-shortcuts.ts` (category
`navigation`) and handled in `useKeyboardShortcuts.ts` **before** the
input-field bailout: neither key edits text, and Preview's Go ▸ Back works
with the find field focused. They `preventDefault()` unconditionally —
**⌘[ is the browser's own Back in Chrome and Safari on macOS**, and in the
hosted PWA or a Safari tab that would leave the app. The E2E asserts
`page.url()` and `history.length` are unchanged after ten presses.

Rejected: Alt+←/→ (pan; and the browser's Back on Windows), Backspace (the
Finder-era back; destructive in inputs), ⌘⇧[ / ⌘⇧] (tab switching in every
browser). Two shortcuts are enough — Preview has two.

**Touch has no ⌘.** A new overlay slot `history` (one slot, two segments
‹ › like `sideSwitch`, `data-testid="history-back|history-forward"`,
disabled state from `canBack`/`canForward`) is added to
`DEFAULT_OVERLAY_LAYOUT` right after `transformMenu`, default visible;
`reconcileOverlayLayout` places it there for existing users. A long-press
(500 ms, the context-menu hold) or right-click on either segment opens a
`QuickMenu` with the ten nearest entries in that direction, as browsers do
on their Back button. The iPad's edge-swipe stays the browser's.

---

## 8. The History tab

**Home: a rail destination.** `TABS` in `Sidebar.utils.ts` gains
`{ id: 'history', label: 'History', icon: IconHistory, group: 'top' }`
between Library and Tools, rendered by `panels/HistoryPanel.tsx`. The
timeline is global and crosses boards and PDFs, so it belongs one level
above a board's own sidebar, next to Library ▸ Recent (files) which is the
same idea one granularity up. A sixth `BoardSidebar` tab was considered and
rejected: PDF entries, tab switches and the single cursor do not fit a
per-board surface, and that strip is five hand-written buttons without a
registry. The rail badge stays off — history is not a signal.

Layout, top to bottom, in the panel's own status strip and content area
(the status-message rules of 2026-09-22 apply):

1. **Layer chips** — `Clicks · PDF lookups · Searches · Viewpoints`, click
   to toggle, accent-lit when on, `data-history-layer="click|lookup|search|view"`.
   A chip's count is the number of listed entries of that cause.
2. **Scope** — a `This board` / `Everything` pill (default Everything).
3. **The list**, newest at the top, grouped by board or document with the
   file name as the group header when the scope is Everything. One row:
   cause glyph (pointer / arrows-cross / magnifier / eye), the label,
   a dim secondary line (`from U1700` for lookups, `14 results · Board
   search` for queries, `near U1700 · 3.2×` for viewpoints), relative time.
   The cursor row carries `data-current` and the accent band; rows after it
   (forward) are slightly dimmed. Unreachable rows (closed file) are greyed
   with the file name and a reopen affordance in phase 4. Click → `jumpTo`.
   Keyboard: ↑↓ move, Enter jumps, Delete removes a row.
4. **Foot** — `Clear` (asks through the in-panel confirm strip like the
   worklist wipe, never `window.confirm`), and the layer defaults link into
   Settings ▸ Input.

Empty states by the 2026-09-22 rules: no entries yet → "Nothing visited yet —
click a part, search, or look something up." All layers off → "Every layer is
switched off" with the chips still live.

**Search-field recents (Preview's magnifier menu):** the board sidebar
Search input and the PDF find input show the last eight `search` entries of
their surface in `SuggestionList` while the field is empty. Small, cheap,
and it is the half of Preview's behaviour the user named first.

---

## 9. Persistence (phase 4)

Phase 1–3 keep the timeline in memory for the session, like
`part-compare-store`. Phase 4 writes it to localStorage
`boardripper-nav-history` (capped at the same 300, `version: 1`, debounced
500 ms like `session-store`) with entries keyed by `fileKey`
(`name:size:lastModified`) and `fileId`, never by `tabId` — tab ids do not
survive a reload. On restore the store re-binds entries to open tabs by
`fileKey`; entries whose file is not open are unreachable until the file is
opened again, at which point they light up (the same `fileKey` match). The
session-restore prompt offers the history alongside the tabs; declining
restores neither.

Layer toggles persist from phase 1 (`boardripper-history-layers`).

---

## 10. Tests

- **Unit** `store/nav-history.test.ts` on the pure reducer: push with
  departure write, re-anchor after back (3.1), consecutive collapse and
  non-consecutive keep, query growth, step honouring filters, cursor after
  cap trim, `dropTab` reachability.
- **E2E** `tests/nav-history.spec.ts` on the public KiCad sample (so it runs
  on every machine):
  - click three parts, ⌘[ twice → selection is the first part and the
    viewport pose is within 4 px of the departure pose; ⌘] → third part;
    `page.url()` and `history.length` unchanged.
  - back, then click a new part → back again lands on the re-anchored entry
    (3.1), and the History list shows the `revisit` row.
  - search `"C"` in the sidebar, pick a result, ⌘[ → the previous selection;
    ⌘] → the picked part with the query back in the field.
  - Clicks layer off → ⌘[ skips click entries and stops on the search.
  - `tests/fixtures/two-page-text.pdf`: PDF find → a `search` row; word
    click that resolves to a board part → a `lookup` row with `from`.
  - ribbon ‹ › by test id, tapped with CDP touches (no keyboard on a tablet).
  - viewpoints on: drag the board across the panel, wait for settle → a
    `view` row named `near <part>`; viewpoints off → no row, but ⌘[ after a
    subsequent click restores the dragged pose (departure rule).
- **WebKit** (`npm run test:webkit`): ⌘[ / ⌘] on the iPad descriptor to
  prove Safari's Back is suppressed there too.

---

## 11. Phases

1. **Core + shortcuts.** Reducer, store, recording at the click / search /
   lookup sites, departure camera rule, restore for board and PDF places,
   ⌘[ / ⌘], the ribbon `history` slot. Unit tests, the first E2E cases.
   Ships alone as a usable "Back / Forward" even without the tab.
2. **History tab.** Rail destination, chips, list, jump, clear, `This
   board` scope, QuickMenu on the ribbon slot, search-field recents.
3. **Viewpoints.** Settle detector in `BoardRenderer`, tab switch, manual
   PDF page change, fit-to-board; region naming; layer off by default.
4. **Persistence + reach.** localStorage timeline keyed by `fileKey`,
   session-restore integration, reopen closed files via
   `openLibraryFileById`, the Library search surface, an MCP
   `history_list` / `history_back` pair for the copilot skill.

Each phase is a milestone commit; CLAUDE.md gets its paragraph when phase 1
ships.

**As built (2026-09-29).** Phases 1–3 as written. Phase 4: the timeline
persists (`boardripper-nav-history`, version 1, 500 ms debounce) and is
loaded at store construction with every board `tabId` stripped to −1 — tab
ids restart at 1 on each load — so entries re-find their tab by `fileKey`
(`name:size`, the mtime segment ignored because a library re-fetch may carry
another) or, last, by file name. It does not ride the session-restore prompt:
the timeline simply loads, and rows light up as their files open. A closed
row with a `fileId` reopens the file from the library on click and jumps
after it loads. Not built: the Library search surface as a query entry, and
the MCP `history_*` tools (backend work in `mcpserver`).

Two mechanics settled in the build. The settle detector lives in the
renderer's ticker, not on pixi-viewport's `moved` event: keyboard pans and
several of our own handlers set the position without emitting it, so the
tick compares the transform with the last frame's and classifies a change as
ours (the animated jump, a fit, a restore — `programmaticMove`) or the
user's. And a restore that lands after `isRestoring` was cleared — a panel
that mounts late and consumes a pending pose — runs under `quietly()`, or
the `goToPage` it performs would read as a page the user turned.

---

## 12. Open questions

- Should a **net highlight from the Net List** be `click` or `search`? The
  Net List is a list the user scans, closer to a search result. Proposal:
  `click` — it is a direct pick, not a query — but the row glyph can show a
  list icon. Decide on first use.
- **Departure camera for a PDF entry when the user leaves from the board.**
  An entry stores its own panel's camera only (variant D rejected), so a PDF
  entry followed by board activity keeps the PDF pose from the moment the
  user last touched the PDF, which the settle timer writes in place. Good
  enough; note it in the CLAUDE.md paragraph.
- **Cap per layer or global?** Global 300 is simplest; with viewpoints on, a
  long session could push clicks out. If that shows up in use, cap
  viewpoints separately at 100.
