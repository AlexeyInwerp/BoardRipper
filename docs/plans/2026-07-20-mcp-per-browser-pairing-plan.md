# MCP Per-Browser Pairing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scope MCP live-board tools to the browser that paired the calling token, so multiple technicians on one install never see or drive each other's sessions by accident.

**Architecture:** A per-browser `client_id` (localStorage) tags every bridge session; a persisted pairing store maps per-client bearer tokens to client ids; `GateAuto` resolves the bearer into a `Scope` on the request context (the go-sdk propagates it into tool handlers); `Bridge.pick`/`Bridge.Sessions` enforce the scope in one place. The install secret keeps today's install-wide behavior as the explicit "shared token".

**Tech Stack:** Go (net/http, modelcontextprotocol/go-sdk v1.6.1), TypeScript/React (Vite), Playwright.

## Global Constraints

- Spec: `docs/specs/2026-07-20-mcp-per-browser-pairing-design.md` — error strings and endpoint shapes are normative there.
- Internal tool: pairing endpoints are same-origin unauthenticated (same trust as `GET /api/mcp/token`); 404 when MCP disabled.
- Zero-value `Scope` must behave as **shared** (SelfTest and in-memory tests bypass Gate).
- No new dependencies. Logging via `log.mcp.*` frontend / stdlib backend.
- Commit after every task (repo safety rule).

---

### Task 1: PairingStore

**Files:**
- Create: `src/backend/mcpserver/pairing.go`
- Test: `src/backend/mcpserver/pairing_test.go`

**Interfaces:**
- Produces: `LoadPairings(dataDir string) (*PairingStore, error)`; methods `PairClient(clientID, label string) (string, error)` (idempotent mint, updates label), `Rotate(clientID string) (string, error)`, `ClientForToken(token string) (clientID string, ok bool)`, `LabelFor(clientID string) string`.

- [x] **Step 1: failing tests** — `pairing_test.go`: mint→same token on re-pair with label update; rotate→new token, old invalid; persistence across `LoadPairings` reloads; `ClientForToken` unknown → ok=false; file mode 0600.
- [x] **Step 2: run, verify FAIL** — `go test ./mcpserver/ -run TestPairing -v` (from `src/backend`).
- [x] **Step 3: implement** — JSON file `<dataDir>/mcp-pairings.json`, atomic tmp+rename write, `sync.Mutex`, token = 32-byte hex via `crypto/rand` (reuse `writeSecret` style). Token lookup iterates with `subtle.ConstantTimeCompare`.
- [x] **Step 4: run, verify PASS**
- [x] **Step 5: commit** — `feat(mcp): pairing store for per-browser tokens`

### Task 2: Scope type + Gate resolution

**Files:**
- Modify: `src/backend/mcpserver/auth.go`
- Test: `src/backend/mcpserver/auth_scope_test.go`

**Interfaces:**
- Produces: `type Scope struct { ClientID string }` (empty ClientID ⇒ shared), `withScope(ctx, Scope) context.Context`, `ScopeFrom(ctx) Scope`; `GateAuto(st *State, secret string, pairings *PairingStore, oauth *OAuth, next http.Handler)` (new `pairings` param; nil ⇒ static-only behavior).
- Resolution order (both auth modes): paired token → `Scope{ClientID}`; install secret → shared `Scope{}`; OAuth-verified token → shared; else 401.

- [x] **Step 1: failing tests** — httptest like `TestGate` (mcpserver_test.go:60): paired token passes and handler sees `ScopeFrom(ctx).ClientID == "c1"`; install secret passes with empty ClientID; garbage 401; paired token accepted in oauth mode too.
- [x] **Step 2: FAIL run** → **Step 3: implement** (Gate stays static-only for back-compat; GateAuto gains pairings + `r.WithContext`) → **Step 4: PASS run**
- [x] **Step 5: commit** — `feat(mcp): resolve bearer into request-scoped client identity`

### Task 3: Bridge scoping + focus carry-over

**Files:**
- Modify: `src/backend/mcpserver/bridge.go`, `src/backend/mcpserver/bridge_ws.go`
- Test: extend `src/backend/mcpserver/mcpserver_test.go` bridge tests

**Interfaces:**
- `session` gains `clientID, clientLabel string`.
- `register(id string, board json.RawMessage, clientID, clientLabel string) *session` — preserves prior `focusedAt` when re-registering an existing id.
- `pick(sessionID string, sc Scope) (*session, error)` with sentinel errors `errForeignSession`, `errNoPairedPage` (exact strings from spec §Request scoping); default pick filters to `sc.ClientID` when set.
- `Request(ctx, sessionID string, sc Scope, op string, params any, timeout)` threads scope.
- `Sessions(sc Scope) []SessionInfo` where `SessionInfo{Board json.RawMessage; ClientID, ClientLabel string; FocusedAtMs int64}`.
- `bridge_ws.go`: `wsMsg` gains `Client *wsClient` (`{ID,Label string}`) read from hello.

- [x] **Step 1: failing tests** — foreign explicit session refused for scoped caller, allowed for shared; scoped default pick ignores other clients' fresher focus; re-register same id keeps focusedAt; `Sessions` filtered; update `TestBridge_PicksMostRecentlyFocused` etc. to new signatures.
- [x] **Step 2: FAIL** → **Step 3: implement** → **Step 4: PASS**
- [x] **Step 5: commit** — `feat(mcp): scope bridge session registry by paired client`

### Task 4: Tool plumbing, pair endpoints, wiring

**Files:**
- Modify: `src/backend/mcpserver/tools_live.go` (liveTool/liveBinaryTool call `b.Request(ctx, sess, ScopeFrom(ctx), …)`; `board_sessions` uses `b.Sessions(ScopeFrom(ctx))` and emits `client_id`, `client_label`, `focused_at_ms` merged into each descriptor)
- Modify: `src/backend/mcpserver/server.go` (`boardripperInstructions`: add paired-vs-shared sentence)
- Create: `src/backend/mcpserver/pairing_http.go` — `PairHandler(st *State, ps *PairingStore)` `POST {client_id,label}→{token,label}`, `RotateHandler` `POST {client_id}→{token}`; both 404 when disabled, 400 on missing/oversized client_id (8–64 chars) or label >64.
- Modify: `src/backend/main.go` — `mcpPairings, _ := mcpserver.LoadPairings(dataDir)`; pass into `GateAuto`; mount `POST /api/mcp/pair`, `POST /api/mcp/pair/rotate`.
- Test: `src/backend/mcpserver/scope_http_test.go` — end-to-end over `httptest.NewServer(GateAuto(...))` + `mcp.StreamableClientTransport` with header-injecting RoundTripper: paired client lists only its own sessions; shared lists all; live tool with foreign session id returns the spec error text.

- [x] **Steps 1–4: TDD cycle as above** (this test also proves the go-sdk actually propagates the request context; if it does not, STOP and re-design scope transport before proceeding)
- [x] **Step 5: commit** — `feat(mcp): enforce client scope in live tools + pairing endpoints`

### Task 5: Frontend — identity, hello, Settings card

**Files:**
- Modify: `src/frontend/src/store/mcp-bridge.ts` — `clientIdentity()` (localStorage `br-mcp-client-id` 32-hex via `crypto.getRandomValues`, `br-mcp-client-label` default `Browser <id[0..6]>`), include `client` in hello; export `getMcpClientIdentity()`, `setMcpClientLabel(label)`.
- Modify: `src/frontend/src/panels/SettingsPanel.tsx` — Integrations section: card **"This browser's agent"** (editable label → `setMcpClientLabel` + re-POST pair; token fetched from `POST /api/mcp/pair`; reveal/copy; `claude mcp add` snippet; Rotate → `/api/mcp/pair/rotate`), relabel existing token block **"Shared token (all sessions)"** with one-line explanation. Match existing Settings styling; no decorative UI.
- Test: `src/frontend/tests/mcp-pairing.spec.ts` — with `page.route` stubbing `/api/mcp/status` (enabled) and `/api/mcp/pair` (fixed token): card renders label + token + snippet; label edit persists to localStorage; rotate calls the rotate route.

- [x] **Steps:** write spec test → `npx playwright test tests/mcp-pairing.spec.ts` FAIL → implement → PASS → `npx tsc --noEmit` clean.
- [x] **Commit** — `feat(mcp): per-browser pairing UI + client identity in bridge hello`

### Task 6: Docs + final verification

**Files:**
- Modify: `.claude/skills/boardripper-repair-helper/SKILL.md` (preflight: paired token lands on your own browser; shared token ⇒ pick + pass `session` explicitly), `CLAUDE.md` (MCP bullet: pairing summary), spec status line.

- [x] **Steps:** edit docs → `cd src/backend && go vet ./... && go test ./mcpserver/` all green → `cd src/frontend && npx tsc --noEmit` → full Playwright run of the new spec → commit `docs(mcp): pairing docs + skill guidance`.

## Self-Review

- Spec coverage: identity→T5, store→T1, endpoints→T4, scoping table→T2/T3/T4, focus carry-over→T3, Settings→T5, docs/skill→T6, tests→each task. OAuth = shared covered in T2 resolution order. ✓
- No placeholders; signatures consistent (`Scope`, `pick(sessionID, sc)`, `Sessions(sc)`, `Request(ctx, sess, sc, …)`) across T2–T4. ✓
- Deliberate deviation from bite-size dogma: steps within a task are batched TDD cycles; each task remains independently testable + committed. ✓
