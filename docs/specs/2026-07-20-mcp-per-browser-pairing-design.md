# MCP per-browser pairing — session separation design

**Date:** 2026-07-20 · **Status:** approved (user-confirmed in session)
**Problem owner:** multi-user NAS installs (3–4 technicians share one BoardRipper backend, each with their own agent).

## Problem

The MCP bearer token authenticates callers to the *install*, not to a session. The bridge
session registry (`Bridge.sessions`) is one flat map of every connected browser page from
every device; `board_sessions` lists all of them and the no-`session` default target is
the most-recently-focused page **install-wide** (`Bridge.pick`). With several technicians
on one install, agent A silently reads and drives technician B's screen — observed in the
field as "one user sees wrong boards open."

Trust context: internal LAN tool. This is a **usability/correctness** fix, not a security
boundary. Anyone on the LAN is trusted; the goal is that sessions don't *mix by accident*.

## Design

### Identity: per-browser client id

- Each browser profile mints a stable `client_id` once (32 hex chars, `crypto.getRandomValues`)
  and persists it in `localStorage` (`br-mcp-client-id`), plus a user-editable label
  (`br-mcp-client-label`, default `Browser <first 6 of id>`).
- The bridge `hello` frame carries `client: {id, label}` in addition to `session` +
  install secret. The Go `session` struct stores `clientID` + `clientLabel`; the
  descriptor returned by `board_sessions` includes them.
- A reload mints a new *session id* but keeps the *client id* → pairing survives reloads,
  reconnects, and backend restarts.

### Pairing token

- New file `<dataDir>/mcp-pairings.json` (0600), managed by `mcpserver/pairing.go`:
  `{"pairings":[{"token","client_id","label","created_at","last_used"}]}`.
  One token per client_id; minting is idempotent (returns the existing token).
- `POST /api/mcp/pair {client_id, label}` → `{token}` — same-origin, unauthenticated
  (same trust level as the existing `GET /api/mcp/token`). Called by the Settings panel,
  and also updates the stored label.
- `POST /api/mcp/pair/rotate {client_id}` → `{token}` — mints a replacement token.
- Both endpoints 404 when MCP is disabled (mirror TokenHandler).

### Request scoping

`Gate`/`GateAuto` resolve the bearer and attach a **scope** to the request context
(custom ctx key in `mcpserver`; the MCP go-sdk passes the HTTP request context through
to tool handlers — verified `streamable.go:491-494`):

| Bearer | Scope | board_sessions | live/drive/worklist target |
|---|---|---|---|
| paired token | `client:<id>` | only that client's sessions | explicit `session` must belong to the client, else refused; default = most-recently-focused **among the client's sessions** |
| install secret (`.mcp-secret`) | `shared` | all sessions (today's behavior) | unchanged (any session; install-wide focus default) |
| OAuth token | `shared` | all sessions | unchanged |

- Native tools (`pdf_search`, `obd_*`, `board_resolve`, `file_*`, `file_download`,
  `kb_search`, `ping`) are user-agnostic and ignore scope.
- Scoping is enforced in ONE place: `Bridge.pick(sessionID, scope)` (+ `Bridge.Sessions(scope)`),
  so every live tool inherits it via `liveTool`/`liveBinaryTool`.
- Error text for a foreign/unknown explicit session:
  `"session not found for this token — list yours with board_sessions, or use the shared token to reach other users' sessions"`.
- Error text when a paired client has no connected page:
  `"no BoardRipper page connected for this browser pairing — open BoardRipper in the paired browser (Settings ▸ Integrations shows which one)"`.

### Settings ▸ Integrations UI

Two token cards, presented as deliberate alternatives:

1. **"This browser's agent"** (default path) — editable label, reveal/copy token, ready
   `claude mcp add boardripper <url> --transport http --header "Authorization: Bearer <token>"`
   snippet, Rotate button. Copy explains: *scoped to boards open in this browser.*
2. **"Shared token (all sessions)"** — the existing install token, relabeled. Copy
   explains: *sees and drives every connected session; use deliberately, e.g. to analyze
   other users' sessions.* Existing setups keep working unchanged.

### Bridge fix riding along

`Bridge.register` currently resets `focusedAt` on every (re)connect, so the 10-minute
idle read-timeout reconnect cycle lets background windows steal the focus default.
Fix: when re-registering a session id that is already present, carry the previous
`focusedAt` forward. (Applies to same-id reconnects; a reload = new session id = fresh
focus, which is correct since a freshly loaded page was just focused.)

### Docs / agent guidance

- `SKILL.md` preflight: note that with a paired token `board_active` already lands on
  *your* browser; with the shared token you MUST pick a session from `board_sessions`
  and pass it on every live call.
- Server `boardripperInstructions`: one added sentence describing paired vs shared scope.
- CLAUDE.md MCP bullet: append pairing summary.

## Out of scope (documented, deliberate)

- Admin/full-view *mode switch* beyond the shared token (user: "keep as concept, put aside").
- OAuth consent→session binding (OAuth stays shared-scope).
- Per-page drive-UI toggle (stays global).
- WS keepalive/ping rework; zombie-session pruning beyond the focus carry-over above.
- Login/user accounts. `client_id` is a browser-profile identity, not a person.

## Testing

- **Go** (`mcpserver`): pairing store mint/idempotence/rotate/persistence; Gate scope
  resolution (paired/shared/invalid); `pick` with scope (foreign explicit session refused,
  default confined to own sessions, shared unchanged); `Sessions(scope)` filtering;
  focus carry-over on re-register; live-tool ctx plumbing via the in-process harness.
- **Playwright**: hello carries `client`; Settings shows both cards; pair endpoint
  round-trip; label edit persists.
