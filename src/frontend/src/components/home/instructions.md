# Getting started

Welcome to **BoardRipper** — a browser-based viewer for PCB boardview files.

## Open a file

- Drop a board file (`.bvr`, `.brd`, `.bdv`, `.fz`, `.cad`, `.xzz`, `.tvw`, or Allegro `.brd`) anywhere on this window.
- Or drop a PDF schematic next to it — PDFs open in a side panel and stay linked to the board.
- You can also press **⌘O** to pick a board, or **⌘P** to pick a PDF.

## Navigate the board

- **Drag** or **scroll** to pan and zoom (change the assignment in *Quick settings* below).
- **Space** flips between top and bottom layers.
- **⌘ + arrow keys** rotate and mirror the board.
- Click a pin or component to highlight its net and linked schematic location.

## Tips

- Open multiple boards at once — each gets its own tab.
- The **Library** tab in the sidebar shows every board in your loaded repository and lets you match against the reference database.
- Parsed boards are cached locally, so re-opening the same file is instant.

## Feedback / issues

Found a parser quirk or a rendering glitch? File an issue on [GitHub](https://github.com/inwerp/Boardviewer/issues) — sample files help a lot.
