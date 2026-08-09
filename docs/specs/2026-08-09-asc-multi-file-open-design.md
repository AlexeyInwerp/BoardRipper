# Opening a split `.asc` boardview as one board

**Date:** 2026-08-09
**Status:** design approved, ready to implement
**Related:** issue #26, `docs/formats/BDV_ASC_FORMAT.md`

---

## Problem

The Tebo-ICT / eM-Test toolchain ships a boardview as a folder of plain-text
section files. BoardRipper can already merge them — `boardStore.loadFiles()`
calls `mergeAscFiles` → `bundleAscFiles` when several `.asc` files arrive
together — but that only ever happens if the user knows to ⌘-click all of them
in the OS picker or drag the whole set onto the window. Every other entry point
opens exactly one file:

| Entry point | Call |
|---|---|
| Library, DB index | `LibraryPanel.handleOpenFile` → `loadFiles([one])` |
| Library, Live browse | `LibraryPanel.handleOpenLiveFile` → `loadFiles([one])` |
| MCP `open_file` | `file-actions.openLibraryFileById` → `loadFiles([one])` |

So clicking a section file in the Library gives a partial board with nothing
explaining why. Observed on `ASUS x555ld rev 2.0/…/`:

- `Pins.asc` → parts, pins and nets, **no outline**
- `Format.asc` → the outline alone, "just a square"
- `Nails.asc` → **empty screen** (see bug 2 below)
- `Nets.asc`, `Parts.asc` → **parse error**, "no recognisable section"

The last one is the bigger find: this delivery has **five** sections, not the
three the `.bdv` bundle carries. `Parts.asc` and `Nets.asc` are formats the
parser has never seen.

### The five files (X555LD R36, dated 2015)

| File | Header title | Content |
|---|---|---|
| `Format.asc` | `Board Outline Contour` | `X Y Radius` contour, inches |
| `Nails.asc` | `Test Fixture Nails` | `$id X Y type grid (T/B) #num netname … ` |
| `Pins.asc` | `Part Pins List` | `Part <name> (T)` + `num name X Y layer net nail` |
| `Parts.asc` | `Parts List` | `name X Y rot grid (T/B) 'device', 'outline'` |
| `Nets.asc` | `Net Listing` | `#num (S) netname` + `PART.PIN` member lines |

Measured cross-consistency on that board: `Parts.asc` and `Pins.asc` name the
same 1986 parts; `Nets.asc` holds 1993 nets whose 8319 members are exactly the
8319 pins in `Pins.asc`. So `Nets.asc` is near-redundant, while `Parts.asc`
carries two things no other section has: **rotation** and the **device /
outline (package) name**.

### Two latent bugs found while measuring

1. **Net names may contain spaces** (`3D VISION`). Both the pin parser
   (`tokens[5]`) and the nail parser (the token after `#num`) take a single
   token, so such nets are truncated to `3D` and split off their real net.
2. **Nails are absent from the bounding box.** `allPoints` is outline + pin
   positions only, so a nails-only board gets a degenerate bbox and renders as
   an empty screen even though the nails parsed fine.

---

## Design

### 1. Parser: two new sections

`SECTION_TITLES` gains `Parts List` → `parts.asc` and `Net Listing` →
`nets.asc`, plus shape fallbacks for header-stripped files (a
`name X Y rot grid (T/B) 'dev', 'out'` line is parts; a `#<num> (S) <name>`
line is nets). Both flow through the existing marker/bundle machinery, so the
`.bdv` bundled form would pick them up for free if a future bundle carries them.

**Merge authority** — `Pins.asc` owns geometry; the new sections only add:

- `Parts.asc` → `angleDeg` (degrees as printed; mostly 90° multiples, one 150°
  in the sample) and `meta.package` (the `'device'` field; `'outline'` is
  identical in every row of the sample, so it is not stored twice). Parts
  present in `Parts.asc` but absent from `Pins.asc` are emitted at their
  printed origin with no pins, so the part list stays complete.
- `Nets.asc` → nets whose members resolve to parsed pins but that the pin pass
  did not produce. Pinless nets (`NC_1999`, …) are dropped — they would be
  noise in the net list.

`Nets.asc` alone has no geometry at all, so it cannot render; see §4.

### 2. Fix the two bugs

- Pin lines: net = tokens from index 5 with **trailing all-numeric tokens**
  (the nail-id column) removed and the rest joined by a single space, falling
  back to `tokens[5]` if that leaves nothing.
- Nail lines: net = the tokens after `#num` up to the first `VIA` / `PIN` /
  bare `T` / `B` / `.` marker, joined the same way.
- `allPoints` gains nail positions.

### 3. Auto-open siblings when one section is clicked

New `parsers/asc-siblings.ts`, pure and unit-tested:

```ts
ascSectionFromName(name): 'format'|'nails'|'pins'|'parts'|'nets'|null
groupAscSiblings(clickedName, candidateNames): string[]
```

Rule: strip the section keyword and its adjacent separators from the stem to
get a **base** (`LA-L031P_pins.asc` → `la-l031p`; a bare `Pins.asc` → `""`).
Siblings are the same-folder `.asc` files with an equal base, deduped by
section, capped at one per section. A name with no keyword never groups — so a
PADS job's `PART.ASC` / `CONN.ASC` in the same folder is never even fetched,
and two boards' exports in one folder stay apart.

New `store/asc-open.ts` exposes

```ts
expandAscFile(clicked: File, src: { siblingNames(): Promise<string[]>;
                                    read(name: string): Promise<File> }): Promise<File[]>
```

and the three call sites supply the two-method source: the DB library lists
names from the databank index by dirname and reads via `fetchFileBuffer`
(works in Electron too); Live browse already holds the directory listing and
reads by path; MCP reuses the DB source. The result goes to the existing
`loadFiles(files)`, so all deliveries stay on one code path. One info toast
names what happened: *"Opened 5 .asc sections as one board: X555LD"*.

### 4. Fallback where siblings are unreachable

A file dropped on the window or picked from the OS picker is a sandboxed
`File` with no folder access, so the siblings cannot be found. There:

- A lone section that **can** render (`pins`, `format`, `nails`, `parts`)
  opens as it does today, plus an info toast naming the sections that are
  missing and offering an **"Add sections…"** action. The action opens a
  `multiple accept=".asc"` picker, closes the partial tab, and loads the merged
  board.
- A lone `nets.asc` has nothing to draw; it fails with a message naming its
  siblings instead of the current "no recognisable section".

`Toast.action` already supports a labelled button, so this needs no new UI.

### 5. Docs and tests

- `docs/formats/BDV_ASC_FORMAT.md`: document `Parts.asc` / `Nets.asc`, the
  five-file delivery, the space-bearing net names, and the auto-open rule.
- CLAUDE.md's BDV ASC line: mention the five sections and auto-sibling open.
- Unit tests: `groupAscSiblings` (prefixed names, bare names, two boards in one
  folder, PADS neighbours, case-insensitivity); parts/nets section parsing;
  the space-bearing net name; nails-in-bbox.
- Fixture: `samples/ASUS X555LD asc/` (local-only, gitignored).

## Out of scope

A setting to disable auto-merge, folder-drop traversal via
`webkitGetAsEntry`, and synthesising pin geometry from `Parts.asc` +
`Nets.asc` when `Pins.asc` is absent (it would place every pin of a part at a
single point — misleading, not useful).
