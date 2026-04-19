# Getting started

Welcome to **BoardRipper** — a browser-based viewer for PCB boardview files.

## Open a file

- Drop a board file (`.bvr`, `.brd`, `.bdv`, `.fz`, `.cad`, `.xzz`, `.tvw`, or Allegro `.brd`) anywhere on this window.
- Or drop a PDF schematic next to it — PDFs open in a side panel and stay linked to the board.
- You can also press **⌘O** to pick a board, or **⌘P** to pick a PDF.

## Toolbar buttons (top bar)

- **☰** — toggle the sidebar (Library / Settings / Debug tabs).
- **Open Board / Open PDF** — file pickers for boards and schematics.
- **Top / Bottom** — choose which layer is facing you. The small arrow between them flips the mirror axis. Shift-click either to show both sides at once.
- **↺ / ↻** — rotate the board 90° counter-clockwise / clockwise.
- **⇔ / ⇕** — mirror the board horizontally / vertically.
- **Traces** — toggle PCB trace rendering (only appears when the file contains trace data).
- **Butterfly** — show top and bottom side-by-side (only for single-layer boards).
- **Search** — global fuzzy search across parts, pins, nets, and PDF text.
- **Version badge** (right side) — click to view the changelog and check for updates.

## Navigate the board

- **Drag** or **scroll** to pan and zoom — change the assignment in *Quick settings* below.
- **Pinch-to-zoom** works on any trackpad and always zooms, regardless of the scroll-wheel settings.
- **Two-finger scroll** on a trackpad is the same event as a mouse wheel — whatever you bind the scroll wheel to, two-finger scroll does the same.
- **Space** flips between top and bottom layers.
- Click a pin or component to highlight its net and (if a PDF is linked) jump to the matching schematic location.

## Tips

- Open multiple boards at once — each gets its own tab.
- The **Library** tab in the sidebar shows every board in your loaded repository and lets you match against the reference database.
- Parsed boards are cached locally, so re-opening the same file is instant.

## Feedback / issues

Found a parser quirk or a rendering glitch? File an issue on [GitHub](https://github.com/inwerp/Boardviewer/issues) — sample files help a lot.
