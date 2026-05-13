# Getting started

Welcome to **BoardRipper** — a browser-based viewer for PCB boardview files. Each section below expands when you click it.

## Run it in Docker (recommended)

BoardRipper is designed to live in a **Docker container** on your NAS or workstation. In that mode it can auto-scan one or more mounted *boards folders* and build a **browsable, automatically organised library** of every board and linked PDF it finds — searchable from the sidebar without dragging files one at a time.

Two separate volumes, different jobs:

- **`/library`** — mount your boards folder(s) here (usually read-only). Each subfolder under `/library` shows up as a top-level group in the Library panel. Mount several folders as subdirectories to keep repositories separate, e.g. `/path/to/MacBooks:/library/MacBooks:ro` and `/path/to/iPhones:/library/iPhones:ro`.
- **`/data`** — writable upload storage. Any file you **drag-and-drop onto the app** lands here and persists across restarts. This is independent of `/library`.
- Point a browser at the host on the configured port; the Library tab picks up new files automatically — no imports, no indexing dance.

Running from source locally also works, but the auto-scan library is the killer feature — use the Docker image if you have more than a handful of files.

## Open a file

- Drop a board file (`.bvr`, `.brd`, `.bdv` — both plain-text and Honhan/Tebo-ICT obfuscated, `.fz`, `.cad` — GenCAD or Mentor Boardstation Neutral, `.xzz`, `.tvw`, or Allegro `.brd`) anywhere on this window.
- Or drop a PDF schematic next to it — PDFs open in a side panel and stay linked to the board.
- **⌘O** / **⌘P** open the same unified file picker (boards + PDFs are routed by extension).
- In Docker mode: open the **Library** tab in the sidebar and pick any board from the auto-scanned folder.

## Top toolbar

The bar above this screen is mostly self-explanatory. In short:

- **☰** opens the sidebar (Library / Settings / Debug).
- **Open** (desktop build) / **Upload** (web build) is a single file picker that accepts boards and PDFs in the same dialog.
- **Top / Bottom** pick the layer; Shift-click shows both; the small arrow between them flips the mirror axis.
- **↺ ↻ ⇔ ⇕** rotate and mirror the board.
- **Traces** toggles PCB traces when the file has them.
- **Search** runs a global fuzzy search across parts, pins, nets, and PDF text.
- The **version badge** on the right shows the changelog and checks for updates.

## BoardViewer tab controls

Inside every board tab there is a small cluster of overlay buttons. They act only on the active board, not the app as a whole.

### Top-left corner

- **☰** — toggle the floating *BoardSidebar* inside the tab (Layers / Info / Search). Click again to close; click once more to re-show and reveal the opacity slider next to it.

### Bottom-right status group

First row — view controls:

- **⇶** — **PDF follow**. When ON, clicking a component here jumps the linked PDF panel to its schematic location. Disabled until a PDF is bound.
- :icon-hand-move: / :icon-zoom-in: — **Quick scroll swap**. Shows the current bare-scroll action (pan or zoom). Click to swap bare and Shift+scroll. Equivalent to flipping *Board — scroll* in Quick settings below.
- :icon-object-scan: — **Zoom to fit**. Frames the full board in the viewport.

Second row — overlay toggles:

- :icon-tooltip: — **Hover info**. Shows a tooltip with component / pin details under the cursor.
- **◐** — **Selection dim**. When a net is selected, fade everything that is not on that net.
- :icon-hierarchy: — **Net lines**. Draw connection lines between pins on the selected net.
- :icon-ghost: — **Hidden-side ghosts**. Overlay components from the back side faintly onto the front (and vice versa) so through-hole alignment is visible.

## Navigate the board

- **Drag** or **scroll** to pan and zoom — change the assignment in *Quick settings* below.
- **Pinch-to-zoom** works on any trackpad and always zooms, regardless of the scroll-wheel settings.
- **Two-finger scroll** on a trackpad is the same event as a mouse wheel — whatever you bind the scroll wheel to, two-finger scroll does the same.
- **Space** flips between top and bottom layers.
- Click a pin or component to highlight its net and (if a PDF is linked) jump to the matching schematic location.

### Game-style shortcuts

- **W / A / S / D** pan the board (and the PDF, when its panel is active).
- **Q / E** rotate the board 90° CCW / CW.
- **Shift + W / Shift + S** zoom in / out at the canvas center.
- **`~`** toggles the Library sidebar — the key left of `1` (layout-independent: works as `~` on US, `°` on DE, etc.).

> AZERTY note: today these shortcuts follow the printed letters on your keyboard, so on AZERTY layouts the keys are Z/Q/S/D rather than the physical W/A/S/D positions. Layout-aware remapping is on the roadmap.

## Tips

- Open multiple boards at once — each gets its own tab.
- The **Library** tab in the sidebar shows every board in your loaded repository and lets you match against the reference database.
- Parsed boards are cached locally in IndexedDB, so re-opening the same file is instant.

## Feedback / issues

Found a parser quirk or a rendering glitch? File an issue on [GitHub](https://github.com/alexeyinwerp/boardripper/issues) — sample files help a lot.
