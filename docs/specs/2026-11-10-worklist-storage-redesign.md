# Worklist storage: review and redesign

2026-11-10. Asked for: worklists should not need their board open, the same
board opened twice (or a second copy of it) should be able to use the same
worklist, and any worklist should be attachable to any open board.

## How it works today

`store/worklist-store.ts`, IndexedDB `boardripper-worklist`, one object store
`boards`, **one record per board file**:

```
BoardWorklistes { key, fileName, activeWorklistId, worklistes: Worklist[], updatedAt, schemaVersion }
```

- `key` is the board-cache key `fileName:size:lastModified`, or
  `noCache:fileName` when the tab has no cache key (`activeKey`).
- A `Worklist` (name, part entries, net entries, note, readings, AI
  messages) only exists inside that record. There is no worklist id space of
  its own.
- Everything goes through the **active tab**: `activeKey` reads
  `boardStore.activeTabId`; `getOrInit`, `pushParts`, `createWorklist`,
  `resolveEntries` and every MCP worklist tool act on it.
- Part entries persist `partIndex` and `unresolved`, which describe one
  board's parse, not the worklist.
- The Tools ▸ Worklists catalog and the panel's finder read every record
  (`listAllStored`) but can only *name* another board's worklist: "open
  that board to use it".
- Clipboard export/import (`worklist-clipboard.ts`) is the only way to move
  a worklist to another board, and it makes a copy.

## What is wrong with it

The two problems reported, and what causes them:

1. **No board, no worklist.** A worklist lives inside a board-file record, so
   it cannot be created, read or edited without that file open as the active
   tab.
2. **The key is the file, not the board.** `name:size:mtime` changes when
   the same board arrives as another copy — re-downloaded, synced from the
   NAS mirror, renamed, or a newer revision of the same 820-number. Each copy
   starts empty and its worklists are unreachable from the others.

Found while reading, not reported yet:

3. **Every board panel draws the active tab's worklist.** The renderer's
   outline pass, shared-net glow and hover tooltip all read
   `worklistStore.activeWorklist` (`BoardRenderer.ts` ~6553, ~7701, ~8098).
   With two boards side by side, the one that is not the active tab shows the
   other board's worklist outlines and notes, matched by refdes onto parts
   that happen to share a name.
4. **A key can change mid-session.** `evictCacheForBoard` (called when a
   scene build fails) clears `tab.cacheKey`; `activeKey` then falls back to
   `noCache:fileName`, so the tab's worklists vanish and new edits go to a
   second record. The same file opened through a path that sets no cache key
   gets that second record from the start.
5. **One active-worklist pointer per file.** Two tabs on the same file share
   `activeWorklistId`; switching the list in one switches the other.
6. **Cross-tab reload resolves against the wrong board.** `onBroadcast`
   re-resolves a reloaded record with `boardStore.board` (the active tab),
   whichever board the record belongs to, and the resulting `unresolved`
   flags are persisted on that record's next save.
7. **"Clear all entries" clears only parts.** `wipeWorklist` empties
   `entries` and leaves `netEntries` and their readings.
8. **This browser only.** On a NAS install used from two benches, or from a
   laptop and an iPad, each device has its own worklists. Clipboard is the
   only backup.

## Design

### A worklist is a document of its own

A new object store `worklists`, keyPath `id`:

```
Worklist {
  id, name, createdAt, updatedAt,
  parts: { refdes, mark, note, waterdamage? }[]          // no partIndex, no unresolved
  nets:  { netName, mark, note, surge?, measurements? }[]
  note?, messages?, aiOrigin?,
  origin?: BoardRef      // the board it was started on: shown, used for suggestions
  lastUsed?: BoardRef    // the board it was last attached to
}
BoardRef { fileName, fileKey?, fileId?, boardNumber? }
```

Only what the user wrote is stored. "Is this part on the board" is answered
per board at display time, never persisted. That removes problems 4 and 6:
there is nothing board-specific left in the record to go stale.

### A board tab *attaches* a worklist

The binding moves from the file to the tab: `BoardTab.worklistId`, saved
with the session like the rest of the tab. A tab shows one worklist or
none. Any worklist can be attached to any open tab. That is the requested
"pin to any opened board", and it is also how the same board opened twice
gets the same list.

- Two tabs may attach the same worklist. It is one document, so a mark set on
  one board shows on the other at once. That is the same board twice, or a
  donor board beside the patient.
- Two tabs may attach different worklists, as two tickets on two copies.
- Each renderer resolves **its own tab's** worklist against **its own
  board** (fixes 3). The panel, the context menu, Shift-click and MCP
  default to the active tab's attached worklist, as now.
- A row whose part or net is not on this board reads "not on this board".
  It used to say "(missing)", which is the wrong word when the list was
  started on another board.

### Which worklist a board opens with

Matching runs from most to least specific. Only an exact match attaches by
itself; the rest are offered.

1. **Same file** (`fileKey`, or the library `fileId` when there is one):
   reattach the worklist this file last had. This is today's behaviour, and
   it also survives a cache eviction, because `fileId` and `fileName` are
   tried when `fileKey` has changed (problem 4).
2. **Same board number** (`obdBoardNumberFor`: 820-02016 in another
   copy, revision or file name): no auto-attach. The Worklist tab shows a chip,
   "2 worklists from 820-02016", which opens the finder filtered to them
   (problem 2).
3. Otherwise none. The finder lists every worklist.

An attachments index (`attachments` object store, key = file identity,
value = last worklist id and time) keeps rule 1 cheap.

### Without a board

The Tools ▸ Worklists catalog becomes the place to manage worklists:
create, rename, delete, duplicate, import or export through the clipboard,
and edit names, notes, marks and readings with no board open. Each row also
gets an **Attach to…** menu listing the open board tabs, which is pinning
from the other direction. Without a board nothing can be highlighted or
resolved. Everything else works.

### Panel changes

- The finder (`worklist-find`) lists every worklist. The ones whose
  `origin` or `lastUsed` matches this board come first, then the rest. A
  pick from anywhere attaches it to this tab.
- The header says which board a list came from when it is not this one
  ("from 820-02016 · A2337.bvr"). When another open tab has the same list
  attached, it says that too.
- A **Detach** item in the ⋯ menu leaves the tab with no worklist.
  **Duplicate** in the same menu starts a fresh round from the same list.
- Delete warns when the worklist is attached to another open tab.
- "Clear all entries" clears parts *and* nets (fixes 7).

### MCP

The worklist tools keep acting on the active tab's attached worklist by
default, and gain an optional `worklist` id. `board_sessions` reports each
tab's attached worklist, so an agent can tell which list it is writing to.

### Migration

`DB_VERSION` 2 adds `worklists` and `attachments` and keeps `boards`.
On first open:

- each `Worklist` in each `boards` record becomes a document;
- its `origin` and `lastUsed` are the record's `fileName`/`key`;
- the record's `activeWorklistId` becomes the attachment for that key.

`boards` is left untouched for one release as a fallback, then dropped.
The clipboard format does not change.

### Later, not in the first cut

Server storage for NAS installs (problem 8). There would be a `worklists`
table in the backend behind `/api/worklists`, last-writer-wins per worklist
on `updatedAt`. The store reads and writes through the server when
`hasBackend()`, and IndexedDB stays the offline cache. The document model
above is shaped so this is a transport change, not a second redesign.

## Plan

1. **Store**: the document model, IDB v2 with migration,
   `attach/detach/listAll/duplicate`, attachments index. Unit tests for the
   migration (old record → documents and attachments, nothing lost,
   `boards` untouched), for resolution per board and for the matching
   rules.
2. **Per-tab binding**: `BoardTab.worklistId` in the session; renderer,
   tooltip, glow, context menu and Shift-click read the tab's list. E2E:
   two tabs side by side, different lists, each draws its own; same list on
   two tabs, a mark on one shows on the other.
3. **Panel and catalog**: finder over all worklists, Attach to…, Detach,
   Duplicate, origin line, board-number chip, board-free editing in Tools.
   E2E on the public samples, with no proprietary board needed.
4. **Fixes that stand alone** and can ship before 1–3: problem 7 (clear
   nets too), and problem 3 in its minimal form (a renderer whose tab is not
   the active one draws no worklist instead of someone else's).
5. Later: server sync.

## Decisions for you

1. **Attach is share, not copy.** The same document is edited from every
   tab it is on. Duplicate makes a copy. Is that the right default for "same
   worklist on another board", or should attaching to a *different* board
   copy?
2. **Board-number matches are only offered, never auto-attached.**
   Auto-attaching across revisions would put a list on a board where some of
   its refdes mean something else.
3. **Server sync:** is it wanted for the NAS install, and should it wait
   until after 1–3?
