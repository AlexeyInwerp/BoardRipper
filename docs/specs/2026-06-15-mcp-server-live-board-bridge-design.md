# MCP Server + Live-Board Bridge — Design (Sub-project A)

**Date:** 2026-06-15
**Status:** Approved design, pending implementation plan
**Scope:** Sub-project A only. Sub-project B (in-browser copilot panel) is a separate future spec.

## 1. Goal

Expose BoardRipper as a standards-compliant **MCP (Model Context Protocol) server** so any
MCP client (Claude Code CLI, and later an in-browser panel) can:

- Query backend analytics — PDF full-text search, OBD electrical readings, board reference
  metadata, file inventory.
- Query the **currently-open board's live connectivity** — nets, pins, parts, adjacency —
  which is parsed only in the browser, by proxying to the open tab.
- **Drive the live UI** — highlight a net, select a part, flip the board, navigate a bound PDF.

The agent's working context is "whatever board the user has open." User opens a board, then
asks an agent (over MCP) to analyze or act on it.

## 2. Context & constraints

- **Board connectivity is client-side only.** Per CLAUDE.md, all format parsing happens in
  TypeScript in the browser. The Go backend only persists: PDF text (FTS5 in `pdfindex.db` /
  `databank.db`), OBD cache, board reference DB (`boards.db`), and file inventory
  (`databank.db`). Therefore live-board tools **must** be answered by the browser, not Go.
- **Deployment:** single Go binary in a scratch Docker image on a NAS; users reach the SPA via
  browser at e.g. `http://<host>:1336`. No new port, no new deployable artifact.
- **Transport:** Claude Code and standard clients consume **Streamable HTTP** MCP with a bearer
  token (`claude mcp add --transport http …`). The official Go SDK
  (`github.com/modelcontextprotocol/go-sdk`, Streamable HTTP, 2025-06-18 spec) provides server
  + handler.
- **No existing MCP / JSON-RPC code** in the repo — this is greenfield within the backend.

## 3. Architecture

Three layers, one new Go dependency (the official SDK):

```
MCP client (Claude Code / any)            Browser tab (the open board)
        │  Streamable HTTP                         ▲  WebSocket
        │  Bearer <mcp-secret>                     │  /api/mcp/bridge
        ▼                                          │
┌──────────────────────── Go backend ─────────────────────────┐
│  /api/mcp   (official go-sdk, StreamableHTTPHandler)         │
│      │                                                       │
│      ├─ backend-native tools → databank.db / pdfindex.db /   │
│      │     boards.db / obd cache   (answered in Go)          │
│      └─ live-board tools  → bridge.Request(session,op,params)│
│                              ──► WS to the active tab ──►     │
└──────────────────────────────────────────────────────────────┘
```

Live-board tool call flow: MCP `tools/call` → Go tool handler → `bridge.Request(session, op,
params)` → WS frame to the active tab → frontend answers from in-memory `BoardData` (or runs a
drive-UI action via existing stores) → reply correlated by id → MCP tool result.

### Components & boundaries

| Unit | Responsibility | Depends on |
|------|----------------|-----------|
| `handlers/mcp` (Go) | Mount SDK handler, auth middleware, tool registration, dispatch | go-sdk, databank, pdfindex, boarddb, obd, bridge |
| `mcpbridge` (Go) | WS endpoint, session registry, active-tab tracking, request/response correlation + timeout | `github.com/coder/websocket` (small, cgo-free; no WS lib currently in go.mod) |
| `mcp-bridge.ts` (frontend) | WS client; map ops → board-store reads + existing store actions | board-store, parsers/types utils, selection/overlay/pdf stores |
| Settings ▸ Integrations tab (frontend) | Enable toggle, token display + copy command, drive-UI sub-toggle, status | themeStore-style settings persistence, backend config |

Each unit is independently testable: Go tool dispatch with a mock bridge; the bridge registry
with a mock WS; the frontend client with a fake socket.

## 4. Transport & auth

- Mount `StreamableHTTPHandler` at **`/api/mcp`** in `main.go`, inside the existing middleware
  stack (security headers; MCP auth replaces CSRF for this route since it's token-gated).
- **Bearer token:** new per-install secret at `<DATA_DIR>/.mcp-secret` (mode 0600), generated
  at boot using the same helper pattern as `.update-secret`. Constant-time compare on the
  `Authorization: Bearer <token>` header. Missing/disabled → 404 (not 401) so the endpoint is
  invisible when the feature is off.
- **Cross-origin:** configure the SDK's `CrossOriginProtection` to allow the app origin +
  localhost dev origins.
- **WS bridge auth:** same-origin + existing SPA session only (the trusted frontend talking to
  its own backend). The bridge is **not** reachable by external MCP clients; only the Go tool
  handlers call into it.
- **Enable gating:** the whole MCP server is **off by default**. It is enabled explicitly in
  Settings ▸ Integrations. When disabled, `/api/mcp` returns 404 and no secret is exposed.

## 5. Tool surface

All tools take JSON-schema inputs and return structured outputs. MCP tool annotations
(`readOnlyHint`, `destructiveHint`) are set so clients can distinguish read vs. mutate.

### Backend-native (answered in Go)

| Tool | Input | Output |
|------|-------|--------|
| `pdf_search` | `query`, `scope?` (all\|donor), `limit?` | file/page/snippet/bindings/copies (FTS5) |
| `pdf_page_text` | `file_id`, `page` | raw page text |
| `obd_lookup` | `board_number` \| `uuid` | diagnosis sections + per-net diode/voltage/resistance |
| `board_resolve` | `board_number` | brand/family/model/color/odm/aliases |
| `file_list` | `filter?` | inventory rows + bindings |
| `file_get` | `id` | one file + bindings (both directions) |

### Live-board, read (proxied to active tab)

| Tool | Input | Output |
|------|-------|--------|
| `board_active` | — | open board: name/format/part+net counts/layers/side |
| `board_sessions` | — | list of open tabs/boards (for disambiguation) |
| `list_nets` | `filter?` | net names (+ pin counts) |
| `list_parts` | `filter?` | refdes (+ value/package/side) |
| `net_info` | `net` | pins on net, parts touched |
| `net_neighbors` | `net`, `depth?` | adjacent nets (reuses `computeAdjacentNets`) |
| `pin_connectivity` | `part`, `pin` | net + connected pins |
| `part_info` | `refdes` | pins, value, package, side, bounds |

### Live-board, drive-UI (proxied, mutating, non-destructive)

| Tool | Input | Effect |
|------|-------|--------|
| `highlight_net` / `spotlight_net` | `net`, `mode?` | highlight/spotlight a net |
| `clear_highlight` | — | clear highlight/spotlight |
| `select_part` | `refdes` | select a component |
| `set_side` / `flip_board` | `top\|bottom` / — | change viewed side |
| `pdf_goto` | `file?`, `page`, `term?` | navigate the bound PDF to a page/term |

Drive-UI tools are **gated by a second toggle** (§7). When that toggle is off, they are not
registered/advertised, so the server runs read-only.

## 6. Bridge protocol & "which tab" model

- WS endpoint `/api/mcp/bridge`; the frontend connects on app load (one connection per tab).
- Tab → backend messages: `hello {session, board descriptor}` on connect; `board_changed
  {board descriptor}` when the user switches board/tab; `focus {session}` on
  `visibilitychange`/window focus.
- Backend keeps a **session registry** (sessionId → {conn, board descriptor, lastFocusedAt})
  and tracks the **active tab** = most-recently-focused live connection.
- Live-board tools default to the active tab; every live-board tool accepts an optional
  `session` argument to target a specific one. `board_sessions` lets the agent enumerate and
  disambiguate.
- Request/response: backend sends `{id, op, params}`; tab replies `{id, ok, result|error}`.
  Correlate by `id`; **10s timeout** → clean MCP error.
- **No tab connected** → MCP error: *"No board open in BoardRipper — open a board in the
  browser first."*

## 7. Settings ▸ Integrations (new tab) & safety

A new dedicated Settings tab "Integrations" (sibling of existing settings tabs):

- **Enable MCP server** (master toggle, default **off**). When turned on: generate/show the
  bearer token, show the ready-to-paste `claude mcp add --transport http boardripper
  http://<host>:1336/api/mcp --header "Authorization: Bearer <token>"` command, and a live
  status line (server up, N clients, active board).
- **Allow agents to control the UI** (drive-UI sub-toggle, default **off**). Off = read-only
  tool surface; on = drive-UI tools registered. Explicit opt-in, matching the off-by-default
  philosophy.
- **Rotate token** button (regenerate `.mcp-secret`).
- **Safety/visibility:** every agent-driven UI action emits a toast ("Agent highlighted net
  VCORE") and a `log.mcp` entry, so changes are never silent. All drive-UI actions are
  reversible (`clear_highlight`, re-select, flip back).

## 8. Frontend bridge client

- New module `src/frontend/src/store/mcp-bridge.ts` (+ a thin hook for lifecycle).
- Opens the WS when the app loads and MCP is enabled; reconnect with backoff.
- **Read ops** read the current `BoardData` from the board store and reuse existing utilities
  (`computeAdjacentNets`, net/pin membership in `parsers/types.ts`). No reimplementation of
  connectivity logic.
- **Drive-UI ops** call existing store actions only (selection store, overlay/spotlight store,
  board flip, `pdf-store` + `pdf-links` for the bound PDF). No new rendering logic.
- New `log.mcp` scope added to `store/log-store.ts`; Debug panel filters on it.

## 9. Error handling

- `pdfindex.db` nil / OBD cache miss / boards.db absent → graceful per-tool MCP error, never a
  panic.
- Bridge timeout / no tab / tab replied error → MCP error with actionable text.
- Multiple tabs open → tool answers from the active tab and the result notes which board
  answered (so the agent isn't confused about context).
- MCP disabled mid-session → `/api/mcp` starts returning 404; clients see connection closed.

## 10. Testing

- **Go unit:** tool dispatch (table-driven, mock bridge), bearer auth (valid/invalid/disabled →
  404), bridge registry + request/response correlation + timeout (mock WS conn).
- **Go integration smoke:** start the server, connect with the go-sdk **client**, `tools/list`,
  call `pdf_search` against a seeded `databank.db`.
- **Playwright E2E:** open a board, open a WS to `/api/mcp/bridge`, issue a `net_neighbors`
  read and assert the result; issue `highlight_net` and assert **geometry/store state** of the
  highlight (per the project rule: assert geometry, not bare `toBeVisible()`).
- Drive-UI tests run with the sub-toggle enabled; a separate test asserts drive-UI tools are
  **absent** from `tools/list` when the toggle is off.

## 11. Packaging / deploy

- Two new Go module dependencies: the official MCP SDK (`github.com/modelcontextprotocol/go-sdk`)
  and `github.com/coder/websocket` for the browser bridge (no WS lib currently in `go.mod`;
  the MCP SDK uses HTTP+SSE for its own transport, not WS). Both are cgo-free.
- No new port (same backend port), no new container. Multi-stage Docker already compiles Go.
- Settings UI addition only on the frontend.
- Ship via the `release` skill (version bump + signed manifest) when complete.

## 12. Out of scope (YAGNI for A)

- OAuth 2.1 (bearer token is sufficient for local/trusted Docker; revisit if exposed publicly).
- In-browser copilot panel and any LLM/Claude-API proxying — that is **Sub-project B**, its own
  spec, built on this tool surface.
- Server-side board parsing (no parser port to Go).
- Any write-to-disk / file-mutating / destructive tools.
- Multi-user / per-user auth.

## 13. Sub-project B (forward reference, not designed here)

In-browser copilot: a Dockview chat panel that is itself an MCP host. The Go backend would
proxy to the Claude API (key server-side) and loop this same tool surface. Depends entirely on
A. Will get its own brainstorm → spec → plan cycle, including model selection (consult the
`claude-api` skill) and cost/key handling.
