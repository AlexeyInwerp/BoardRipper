# Getting started

**BoardRipper** is one place for the two things you juggle at the bench — the
boardview and the schematic PDF — instead of a separate tool for each. Each
section below expands when you click it. Press **?** any time for the keyboard
shortcut list.

## Run it in Docker (recommended)

BoardRipper is built to live in a **Docker container** on your NAS or
workstation, where it auto-scans one or more mounted *boards folders* into a
**browsable, full-text-searchable library** of every board and PDF it finds —
no manual importing.

- **`/library`** — mount your boards folder(s) here (usually read-only). Each
  subfolder shows up as a top-level group. Mount several to keep repositories
  separate, e.g. `/path/MacBooks:/library/MacBooks:ro`.
- **`/data`** — writable storage. Anything you **drag onto the app** lands here
  and survives restarts. Independent of `/library`.
- Point a browser at the host port; the Library picks up new files
  automatically. It can also **mirror a remote WebDAV/CopyParty share** on a
  schedule (Settings ▸ Library) and **update itself** from a signed release.

Running from source works too, but the auto-scanned library is the reason to
use the container if you have more than a handful of files.

## Open a file

- Drop a board anywhere on this window: `.bvr` / `.bv`, `.brd` (OpenBoardView
  *or* Cadence Allegro binary), `.bdv` (plain-text *or* Honhan / Tebo-ICT
  obfuscated), `.fz`, `.cad` (GenCAD *or* Mentor Boardstation Neutral),
  `.pcb` (XZZ), or `.tvw` — 11 formats in all.
- Drop a PDF schematic too — it opens in a side panel and links to the board.
- **⌘O** / **⌘P** open the same picker (boards + PDFs routed by extension).
- In Docker mode, open the **Library** tab and pick any indexed board.

## The Library

The sidebar **Library** tab is the heart of the Docker setup:

- **Board #** groups everything by board number / model, collapsing
  byte-identical copies across folders automatically.
- **PDF** searches the *full text* of every indexed schematic — type a part or
  value and jump straight to the page. Mark PDFs as **donors** to build a
  reusable reference pool.
- **Folders** browses the indexed DB or the live filesystem.
- Byte-identical duplicates are detected and collapsed; the original is the one
  that gets indexed.

## Link board ↔ PDF (and PDF ↔ PDF)

- Click the **∞** control on a board tab *or* a PDF toolbar to link them — it
  works from either side. Linked, a click on a component jumps the schematic to
  the matching location (toggle **⇶ PDF follow** per board).
- Cross-link two PDFs the same way to hop a designator between sheets.

## Inside a board tab

A small cluster of overlay buttons acts only on the active board:

- **☰** toggles the in-tab panel. It opens on **Info** (component detail) for
  single-layer boards and **Layers** for multi-layer ones; **Search**,
  **Revisions**, and **Worklist** are alongside.
- **⇶** PDF follow · **pan/zoom** quick-swap · **zoom-to-fit** ·
  **hover info** · **◐** selection dim · **net lines** · **hidden-side ghosts**.
- Right-click a component for hide / send-to-back / copy / search-in-PDF /
  add-to-worklist, and **OpenBoardData** diode/voltage readings when available.
- **Shift-click** a component to add it to the active **Worklist** — a
  mark/note/export scratchpad for a repair job.

## Navigate

- **Drag** / **scroll** to pan and zoom — reassign in *Quick settings*, or click
  **Set up by gesture** and just demonstrate the gesture you want.
- **Pinch-to-zoom** always zooms; **two-finger scroll** mirrors the mouse wheel.
- **Space** flips top/bottom. Click a pin/component to highlight its net.

### Game-style shortcuts

- **W / A / S / D** pan · **Q / E** rotate 90° · **Shift+W / Shift+S** zoom ·
  **`~`** toggles the Library sidebar (the key left of `1`).
- **?** opens the full shortcut list over your work.

**AZERTY note:** shortcuts go by key *position*, not the printed letter — pan
with Z/Q/S/D, rotate with A/E. No remapping needed.

## Tips

- Open multiple boards — each gets its own tab; drag tabs to split the view.
- Boards are matched against a built-in **reference database** (brand / family /
  model) and cached in IndexedDB, so re-opening is instant.
- Schematic PDFs can have shop watermarks filtered out (Settings ▸ PDF).

## Feedback / issues

Found a parser quirk or a rendering glitch? File an issue on
[GitHub](https://github.com/alexeyinwerp/boardripper/issues) — sample files help.
