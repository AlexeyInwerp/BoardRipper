# Getting started

BoardRipper shows a boardview and its schematic PDF side by side. Click a
section to open it. Press **?** for the keyboard shortcuts.

<!-- docker-only -->
## Run it in Docker (recommended)

BoardRipper is made to run in a Docker container on a NAS or a workstation. It
scans the mounted board folders and builds a library of every board and PDF it
finds. Nothing has to be imported by hand.

- **`/library`** — mount your board folders here, read-only is fine. Every
  subfolder becomes a group in the Library. You can mount several folders, for
  example `/path/MacBooks:/library/MacBooks:ro`.
- **`/data`** — writable. Files you drop onto the app are stored here and
  survive a restart.
- Open the host port in a browser. New files in the library are picked up
  automatically.
- The Library can also mirror a remote WebDAV or CopyParty share on a schedule
  (Settings ▸ Library), and the container updates itself from a signed release.

You can also run it from source, but the scanned library is the reason to use
the container.

<!-- /docker-only -->

## Open a file

- Drop a board file anywhere on this window. Supported: `.bvr` / `.bv`, `.brd`
  (OpenBoardView, Cadence Allegro or EAGLE), `.bdv` / `.asc`, `.fz`, `.cae`,
  `.cad` (GenCAD or Mentor Neutral), `.pcb` (XZZ), `.tvw`, `.pcbdoc` (Altium)
  and `.kicad_pcb`.
- Drop a PDF schematic too. It opens in a side panel and links to the board.
- No drag and drop (tablet, phone)? Use the **Upload** button in the toolbar.
  Select a board and its PDF together and both open.
- **⌘O** / **⌘P** open the same picker.
<!-- docker-only -->
- In Docker, open the **Library** tab and click any board.
<!-- /docker-only -->

<!-- docker-only -->
## The Library

The **Library** tab in the sidebar is where the Docker setup pays off.

- **Board #** groups everything by board number and model. Byte-identical
  copies in different folders are shown once.
- **PDF** searches the full text of every indexed schematic. Type a part or a
  value and jump to the page. Mark PDFs as **donors** to keep a reference set.
- **Folders** browses the indexed database or the live filesystem.

<!-- /docker-only -->

## Link board and PDF

- Click the **∞** button on a board tab or a PDF tab to link them. Once
  linked, clicking a component on the board jumps the schematic to it.
  **⇶ PDF follow** on the board turns this on and off.
- Two PDFs can be linked the same way to jump between sheets by designator.

## Inside a board tab

The small overlay buttons act on the active board:

- **☰** opens the in-tab panel: **Info**, **Layers**, **Search**,
  **Revisions** and **Worklist**. Single-layer boards start on Info,
  multi-layer boards on Layers.
- **⇶** PDF follow, pan/zoom swap, zoom to fit, hover info, **◐** selection
  dim, net lines, hidden-side ghosts.
- Right-click a component: hide, send to back, copy, search in PDF, add to
  worklist. **OpenBoardData** diode and voltage readings show up here when
  available.
- **Shift-click** a component to add it to the **Worklist**. The worklist keeps
  marks and notes for a repair and can be exported.

## Navigation

- **Drag** and **scroll** pan and zoom. Change the bindings in *Quick settings*
  below, or click **Set up by gesture** and show the gesture you want.
- **Pinch** always zooms. **Two-finger scroll** does the same as the mouse wheel.
- **Space** flips top and bottom. Click a pin or a component to highlight its
  net.
- In a **PDF**, the buttons right of the page arrows rotate the page, mirror it
  and switch between single-page and continuous scrolling. With the PDF
  focused, **Q / E** rotate and **⌘↑** mirrors.

### Game-style keys

- **W / A / S / D** pan, **Q / E** rotate 90°, **Shift+W / Shift+S** zoom,
  **`~`** (the key left of `1`) toggles the Library sidebar.
- **?** opens the full shortcut list.

**AZERTY:** shortcuts follow the key position, not the letter. Pan with
Z/Q/S/D, rotate with A/E.

## Tips

- Open several boards. Each gets its own tab. Drag tabs to split the view.
- Boards are matched against the built-in reference database (brand, family,
  model) and cached in IndexedDB, so opening them again is instant.
- Shop watermarks in schematic PDFs can be filtered out (Settings ▸ PDF).

## Feedback

Found a parser problem or a rendering glitch? Open an issue on
[GitHub](https://github.com/alexeyinwerp/boardripper/issues). Sample files
help a lot.
