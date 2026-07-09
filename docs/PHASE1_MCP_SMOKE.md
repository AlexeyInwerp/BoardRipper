# Phase 1 manual smoke — MCP visual/text/download tools

> Note: this note was meant to live as a "## Phase 1 manual smoke" section
> appended to `docs/specs/2026-07-09-mcp-visual-knowledge-expansion-design.md`
> (Task 12 of `docs/plans/2026-07-09-mcp-phase1-access.md`). That spec doc
> exists in the main checkout but is not present in this worktree (it was
> authored on a different branch/session), so per the task brief's fallback
> this note lives here instead. Fold it into the design doc's own "Phase 1
> manual smoke" section when the branches converge.

Manual procedure for exercising the Phase 1 access tools (`board_overview`,
`pdf_page_text`, `pdf_search`, `file_download`, `board_snapshot`, `pdf_page_image`,
`pdf_download`) end-to-end through a real MCP client, once this branch is
running with a real backend (not the Playwright/vitest hermetic proofs).

## 1. Enable MCP

Settings ▸ Integrations ▸ enable "MCP server". This turns on `mcp_enabled`
and generates/persists the per-install bearer secret at
`<dataDir>/.mcp-secret`. Optionally enable "Drive UI" (`mcp_drive_ui`) if you
also want to smoke-test `highlight_net` / `select_part` / `set_side` /
`pdf_goto` (not required for the read-only tools this note covers).

## 2. Connect an external client

```bash
claude mcp add --transport http boardripper http://localhost:1336/api/mcp \
  --header "Authorization: Bearer <token>"
```

(`<token>` is shown in Settings ▸ Integrations next to the MCP toggle.)

## 3. Load a board + PDF in the browser tab

Open a board file and its matching schematic PDF in the BoardRipper tab you
want the agent to inspect — the live-board tools answer from that tab's
in-memory state over the WS bridge (`/api/mcp/bridge`), proxied by the
backend; they need a focused, board-loaded tab to answer non-null.

## 4. Call each tool and confirm

From the connected client (e.g. `claude` in a chat session with the
`boardripper` MCP server attached):

- `board_overview` — expect a non-null `board` object (`parts`, `nets`,
  `side`), the `pdfs[]` list showing the open PDF, and a `worklist` summary.
- `pdf_page_text` — expect the extracted text of the open PDF's current page
  (or the requested `page`).
- `pdf_search` (library-wide, backend-native — works even with no board/PDF
  open) — expect ranked hits with `file_id` + snippet across the indexed PDF
  library; optionally pass `file_id` to scope to one document.
- `file_download` (by a `file_id` from `file_list`/`file_get`/a `pdf_search`
  hit) — expect the tool result to render as a downloadable/embedded PDF
  (or other file type) in the client, capped at 50 MiB.
- `board_snapshot` — expect a PNG image block that renders inline in the
  client, showing the board exactly as the user currently sees it (side,
  zoom, highlight state). Requires the tab's PixiJS renderer to have a live
  WebGL context — this is the one tool the headless Playwright proof cannot
  fully exercise (see `tests/mcp-bridge.spec.ts`), so this manual pass is its
  real coverage.
- `pdf_page_image` — expect a rendered PNG of the open PDF's current (or
  requested) page, honoring the document's rotation/mirror state.
- `pdf_download` — expect the currently-open PDF's raw bytes, rendering as a
  readable PDF in the client.

## Pass criteria

All seven calls return non-error results; both image-producing tools
(`board_snapshot`, `pdf_page_image`) render as actual images (not blank/broken)
in the client UI; both download tools (`file_download`, `pdf_download`)
produce a PDF the client can open/preview. Record the client + version used
and any deviations here if this is re-run before the branches converge.
