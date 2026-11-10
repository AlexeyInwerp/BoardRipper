# Worklist storage: review and redesign

2026-11-10, revised the same day after review. Asked for:

- Worklists stored on the server, with a story for the desktop app.
- A worklist attributed to a **board name**, editable in the worklist
  navigator (Tools ▸ Worklists).
- A worklist can be **loaded** into any open board without binding it
  there, or **auto-matched** to a board by name, partial names included.
- Matching by **tag**, after checking what the board database stores
  and whether a tag system exists.

## Today

### Worklists

`store/worklist-store.ts` keeps everything in browser IndexedDB
(`boardripper-worklist`, object store `boards`), **one record per board
file**:

```
BoardWorklistes { key, fileName, activeWorklistId, worklistes: Worklist[], updatedAt, schemaVersion }
```

- `key` is the board-cache key `fileName:size:lastModified`, or
  `noCache:fileName` when the tab has none.
- A `Worklist` (name, part entries, net entries, note, readings, AI
  messages) only exists inside that record, and every operation goes through
  the active tab's key.
- Part entries persist `partIndex` and `unresolved`, which describe one parse
  of one board rather than the worklist.
- The Tools ▸ Worklists catalog and the panel's finder can list another
  board's worklists but cannot open them: "open that board to use it".

### What the board data already knows

There is **no tag system** anywhere in the code base. What exists:

- **Library rows** (`databank.db`, table `files`): `board_number`,
  `manufacturer`, `model`, `board_manufacturer` (ODM), `board_uuid` (link
  into the board database), `board_color`, `resolution_status`, `donor_pool`.
  Filled by the scanner and the resolver; the frontend reads them through
  `databankStore.fileById` (`obdBoardNumberFor` already prefers
  `board_number` over the file name).
- **Reference board database** (`boards.db`, shipped read-only):
  - an entity hierarchy: `brands → families → models → boards`;
  - `board_number`, `board_name`, `odm`;
  - `board_aliases` and `model_aliases`, e.g. alternate numbers and EMC
    numbers;
  - `entity_color` and `board_openboarddata`.

  About 4,000 boards.
- **Without a server** (the lite web build, and the desktop app with MCP
  off): only what the file name gives, through `apple-boards.ts` and
  `extractBoardNumberFromFilename`.

These facets already work as tags in all but name: a resolved board
"is" Apple, MacBook Air, A2337, 820-02016, and any aliases. The design uses
them as the board's side of tag matching (below).

### Where data lives, per install

| Install | Server | Worklists today |
|---|---|---|
| Docker / NAS | Go backend, `<DATA_DIR>` volume | each browser's own IndexedDB |
| Desktop, MCP off | none | IndexedDB of the `file://` page |
| Desktop, MCP on | the same Go backend as a sidecar, `DATA_DIR` = Electron `userData` | IndexedDB of the `http://127.0.0.1:<port>` page |
| Lite web | none | IndexedDB of that site |

Two bench machines on one NAS do not share worklists. On the desktop app,
switching MCP **on or off makes every worklist disappear**. The window
then loads from a different origin (`file://` or `http://127.0.0.1:<port>`,
`desktop/main.js:247–249`), and an origin cannot see another origin's
IndexedDB.

### Problems found

1. A worklist cannot be used, created or edited without its board file open
   as the active tab.
2. The key is the file, not the board. A re-downloaded or renamed copy, or a
   newer revision of the same 820-number, starts with no worklists.
3. **Every board panel draws the active tab's worklist.** The renderer's
   outline pass, shared-net glow and tooltip read
   `worklistStore.activeWorklist` (`BoardRenderer.ts` ~6553, ~7701,
   ~8098). A second visible board shows the first board's outlines and notes,
   matched by refdes onto parts that happen to share a name.
4. A tab's key can change mid-session. `evictCacheForBoard` clears
   `tab.cacheKey` after a failed scene build; the tab's worklists vanish
   and new edits go to a second record.
5. Two tabs on one file share one active-worklist pointer.
6. The cross-tab reload re-resolves a record against the *active* board,
   whatever board it belongs to, and persists the wrong `unresolved` flags.
7. "Clear all entries" clears parts and leaves nets and their readings.
8. Worklists are per browser, and on the desktop per origin (above).

## Design

### 1. A worklist is a document

```
Worklist {
  id, rev, createdAt, updatedAt,
  name,                       // "No power — ticket 4411"
  board,                      // the board name it is attributed to: "820-02016"; editable
  tags: string[],             // free text: "A2337", "MacBook Air M1", "water", "no power"
  parts: { refdes, mark, note, waterdamage?, at }[]
  nets:  { netName, mark, note, surge?, measurements?, at }[]
  note?, messages?, aiOrigin?,
  origin?: { fileName, boardNumber?, fileId? }   // where it was started; shown, never matched on its own
  deleted?: number            // tombstone time
}
```

- Only what the user wrote is stored. "Is this part on this board" is
  answered at display time, per board, and never persisted. That fixes
  problems 4 and 6.
- `board` defaults, at creation, to the most specific identity the tab has.
  That is the library `board_number`, else the number in the file name, else
  the file name without its extension. The user can change it in the
  navigator to anything: "820-02016", "MacBook Air M1", "J140 power board".
- `at` on every entry and `rev` on the document make two benches editing one
  worklist mergeable (see §5).

### 2. One storage format, three writers

One JSON file per worklist, `<dataDir>/worklists/<id>.json`, written
atomically (temp file + rename). A delete is a tombstone. The file is moved
to `worklists/.trash/` after 30 days.

| Install | Who reads and writes `worklists/` |
|---|---|
| Docker / NAS | Go backend, `/api/worklists`. Every browser and device shares it. |
| Desktop, MCP on | the same Go backend (its `DATA_DIR` is Electron `userData`) |
| Desktop, MCP off | Electron main, same directory, over IPC (`worklist:list/get/put/delete`) |
| Lite web | IndexedDB in the same document format; export/import as a file |

Why files and not a table in `databank.db`:

- The desktop main process can write a JSON file with no native module.
  Writing SQLite would mean shipping `better-sqlite3` for three platforms.
- Desktop with MCP off and desktop with MCP on then read **the same
  directory**, so the origin split (problem 8) cannot happen.
- Only one writer is ever active. The renderer uses HTTP when a backend
  answers and IPC otherwise.

A few hundred small files load into memory in milliseconds, and the
backend keeps that index in memory. A worklist can be copied, backed up or
mailed as one file.

The frontend store talks to one interface (`list / get / put / delete`) with
three adapters: HTTP, IPC and IndexedDB. Nothing above the store knows
which one is in use.

### 3. Loading a worklist into a board, without binding it

- **Load** puts a worklist on one tab. It is stored with the tab in the
  session, not in the worklist, and changes nothing about the worklist's
  `board`. Any worklist loads onto any open tab. Two tabs can show the same
  worklist (the same board twice, or a donor beside the patient); a mark set on
  one shows on the other at once.
- **Attribute to this board** is a separate, explicit action, from the panel's
  ⋯ menu or from the navigator. It sets the worklist's `board` to this tab's
  identity, so it auto-matches here next time.
- **Unload** leaves the tab with no worklist. **Duplicate** starts a fresh
  copy.
- Each renderer resolves its own tab's worklist against its own board, which
  fixes problem 3. The panel, the context menu, Shift-click and MCP default to
  the active tab's loaded worklist.
- A row whose part or net is not on this board reads "not on this board",
  not "(missing)".

### 4. Matching a board to worklists, including partial names and tags

When a board opens, the store builds the board's **keys**:

| Key | Source | Weight |
|---|---|---|
| board number | library `board_number`, else the file name | strong |
| board aliases | `board_aliases` (resolved boards only) | strong |
| file name stem | the tab | medium |
| model number, model aliases | `models`, `model_aliases` (e.g. A2337) | medium |
| model name, family, brand | `models.display_name`, `families`, `brands` | weak |

It then compares them with each worklist's `board` and `tags`. Both sides
go through `looseKey` from `store/loose-match.ts`, which drops case and
separators. A pair matches when one contains the other and the shorter side
is at least 5 characters (`82002016` and `02016` match
`820-02016-07_MacBook Air (M1, A2337)`; `M1` alone does not match
anything). A match takes the weight of the board key it hit.

- **Auto-load** happens when the tab has no worklist and there is **exactly
  one** strong match. It is a load, not a binding. An info toast says which
  worklist and offers Unload.
- **Several strong matches, or only medium/weak ones:** the Worklist tab shows
  a chip, "3 worklists for 820-02016". The chip opens the finder filtered to
  them, strongest first and most recent first within a weight.
- A setting turns auto-load off; the chip remains.
- Without a server only the file name keys exist: board number and stem.
  Matching still works on them.

**Tags.** A worklist's tags are matched like its board name. A tag "A2337"
reaches every board of that model and "MacBook Air" reaches the family, both
as weak or medium matches that are offered rather than auto-loaded. Tags
also filter the navigator: "water", "no power". Boards get no tag editor in
this design; their side of the match is the board database facets above.
User-defined tags on library boards are a possible later step (§7).

### 5. Two benches, one worklist

- `PUT /api/worklists/<id>` carries the `rev` it started from. If the
  server has moved on, it answers 409 with its copy.
- The client then merges entry by entry, newest `at` wins (notes, marks and
  readings each carry their own `at`), and puts again.
- A removed entry is kept as a tombstone with its `at`, so a merge cannot
  bring it back.
- While a worklist is on screen the client asks
  `GET /api/worklists?since=<updatedAt>` every 10 s and on window focus.
- No websocket: two benches editing one ticket do not need sub-second sync.

### 6. Navigator (Tools ▸ Worklists)

The navigator becomes the home of worklists, board open or not. It shows a
list grouped by board name, with search over name, board and tags (loose
rule) and tag chips to filter. Each row offers:

- edit the name, the **board name** and the tags;
- **Load into…** any open tab;
- Duplicate, Export, Delete.

Selecting a worklist opens it for editing. Marks, notes and readings are
all editable without a board; only highlighting needs one.

The panel's finder lists every worklist: matches for this board first, then
the rest. Picking one loads it onto this tab. The header shows the
worklist's board name when it differs from this tab's board, and says when
another open tab has the same worklist loaded.

### 7. Optional later: tags on library boards

A `tags(entity_type, entity_key, tag)` table in `databank.db` would let a
user tag library boards and files ("customer stock", "bad BGA"). The
Library could filter on them, and worklist matching would treat them as
medium keys. It is not needed for the request as stated, because worklist
tags against board-database facets cover "matchable by tag".

### MCP

The backend can now answer worklist tools itself (`worklist_list`,
`worklist_get`), without a browser open. The live tools act on the active
tab's loaded worklist by default and take an optional worklist `id`.
`board_sessions` reports which worklist each tab has loaded.

### Migration

On first start of the new version, each client imports what it has locally:
the old IndexedDB `boards` records of its own origin. Every `Worklist`
becomes a document:

- `board` is the record's board number if its file name has one, else the
  file name stem;
- `origin` is the record's file;
- tags start empty.

Documents go to whichever storage the install now uses: the server, or
Electron main. Ids are random, so imports from several browsers cannot
collide.

On the desktop app the `file://` page and the `http://127.0.0.1` page each
import their own IndexedDB the first time they run. Both land in the same
`userData/worklists/`, which is how the split worklists come back together.
Each origin records that it has imported. The old records are kept for one
release and then deleted.

The clipboard format does not change.

## Plan

1. **Fixes that stand alone, now:** "Clear all entries" also clears nets
   (7); a board panel that is not the active tab draws no worklist instead
   of another board's (minimal 3).
2. **Storage:**
   - the document type;
   - the backend `worklists/` directory, `/api/worklists` (list with
     `since`, get, put with `rev`, delete) and the in-memory index;
   - Electron IPC on the same directory;
   - the IndexedDB adapter for lite;
   - migration.

   Go tests: atomic write, 409 on a stale `rev`, tombstones, `since`.
   Frontend unit tests: entry merge, migration of a v1 record.
3. **Per-tab load:**
   - the tab's worklist in the session;
   - renderer, tooltip, glow, context menu and Shift-click read it;
   - Load, Unload, Attribute to this board, Duplicate.

   E2E: two tabs with different worklists each draw their own; one worklist
   on two tabs shows a mark on both.
4. **Matching:**
   - board keys from the library row and the board database;
   - the containment rule and weights;
   - auto-load of a single strong match, and the chip.

   Unit tests on the rule (partial numbers, `M1` not matching, weights). E2E
   on the public KiCad sample with a worklist whose board name is part of the
   file name.
5. **Navigator:** grouping, search, tag chips, board-free editing, Load
   into…, Export/Import.
6. Later: tags on library boards (§7).

## Decisions for you

1. **Auto-load threshold.** Only a single strong (board-number-level) match
   loads by itself; everything else is offered. Agree, or should a tag match
   ever auto-load?
2. **Files in `<dataDir>/worklists/`** rather than a table, for the desktop
   reasons above. Fine for the NAS backup you run?
3. **Board tags (§7):** wanted now, later, or not at all?
