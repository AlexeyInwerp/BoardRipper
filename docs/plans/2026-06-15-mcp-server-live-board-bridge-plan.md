# MCP Server + Live-Board Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a standards-compliant Streamable-HTTP MCP server to the BoardRipper Go backend that exposes PDF/OBD/board-reference analytics plus live-board connectivity and drive-UI tools (proxied to the open browser tab over a WebSocket bridge), off by default and enabled in a new Settings ▸ Integrations tab.

**Architecture:** The official Go MCP SDK serves Streamable HTTP at `/api/mcp`, bearer-token gated by a new per-install `.mcp-secret`. Backend-native tools answer directly against the existing SQLite stores. Live-board tools fan a request over a `coder/websocket` bridge (`/api/mcp/bridge`) to the focused browser page, which answers from the in-memory `BoardData` or drives existing stores. Drive-UI tools register only when an explicit sub-toggle is on.

**Tech Stack:** Go 1.25 (net/http, `github.com/modelcontextprotocol/go-sdk`, `github.com/coder/websocket`), existing `databank`/`pdfindex`/`boarddb`/`obd` packages; React 19 + TypeScript frontend; Playwright E2E.

**Reference spec:** `docs/specs/2026-06-15-mcp-server-live-board-bridge-design.md`

---

## File Structure

**Backend (new):**
- `src/backend/mcpserver/secret.go` — `.mcp-secret` ensure/load (mirrors `updater/secret.go`)
- `src/backend/mcpserver/server.go` — build the SDK server, register tools, expose `Handler()` + enable state
- `src/backend/mcpserver/auth.go` — bearer middleware + 404-when-disabled gate
- `src/backend/mcpserver/tools_native.go` — backend-native tools (pdf/obd/boarddb/files)
- `src/backend/mcpserver/tools_live.go` — live-board tools (call the bridge)
- `src/backend/mcpserver/bridge.go` — WS bridge: session registry, active-tab tracking, request/response correlation + timeout
- `src/backend/mcpserver/bridge_test.go`, `src/backend/mcpserver/server_test.go`

**Backend (modified):**
- `src/backend/main.go` — construct the MCP server, mount `/api/mcp` + `/api/mcp/bridge` + `/api/mcp/status`
- `go.mod` / `go.sum` — two new deps

**Frontend (new):**
- `src/frontend/src/store/mcp-bridge.ts` — WS client + op dispatch (reads + drive-UI)

**Frontend (modified):**
- `src/frontend/src/store/log-store.ts` — add `mcp` scope
- `src/frontend/src/panels/SettingsPanel.tsx` — add Integrations tab
- `src/frontend/src/main.tsx` (or App bootstrap) — start the bridge client when MCP enabled
- `src/frontend/tests/mcp-bridge.spec.ts` — Playwright E2E

---

## PHASE A — Backend MCP foundation

### Task 1: Add dependencies

**Files:**
- Modify: `src/backend/go.mod`, `src/backend/go.sum`

- [ ] **Step 1: Add the two modules**

Run:
```bash
cd src/backend
go get github.com/modelcontextprotocol/go-sdk/mcp@latest
go get github.com/coder/websocket@latest
go mod tidy
```

- [ ] **Step 2: Verify they resolve and the module still builds**

Run: `cd src/backend && go build ./...`
Expected: exit 0, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/backend/go.mod src/backend/go.sum
git commit -m "build(backend): add MCP go-sdk + coder/websocket deps"
```

---

### Task 2: `.mcp-secret` ensure/load

**Files:**
- Create: `src/backend/mcpserver/secret.go`
- Test: `src/backend/mcpserver/secret_test.go`

- [ ] **Step 1: Write the failing test**

`src/backend/mcpserver/secret_test.go`:
```go
package mcpserver

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEnsureSecret_GeneratesAndPersists(t *testing.T) {
	dir := t.TempDir()
	s1, err := EnsureSecret(dir)
	if err != nil {
		t.Fatalf("EnsureSecret: %v", err)
	}
	if len(s1) < 32 {
		t.Fatalf("secret too short: %q", s1)
	}
	// File must exist with 0600.
	info, err := os.Stat(filepath.Join(dir, ".mcp-secret"))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("perm = %v, want 0600", info.Mode().Perm())
	}
	// Second call returns the same value (idempotent).
	s2, err := EnsureSecret(dir)
	if err != nil {
		t.Fatalf("EnsureSecret 2: %v", err)
	}
	if s1 != s2 {
		t.Fatalf("non-idempotent: %q != %q", s1, s2)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && go test ./mcpserver/ -run TestEnsureSecret -v`
Expected: FAIL/compile error (`undefined: EnsureSecret`).

- [ ] **Step 3: Write minimal implementation**

`src/backend/mcpserver/secret.go`:
```go
// Package mcpserver hosts BoardRipper's Model Context Protocol server and the
// WebSocket bridge that proxies live-board tools to the open browser tab.
package mcpserver

import (
	"crypto/rand"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
)

// EnsureSecret loads, or generates and persists, the per-install MCP bearer
// secret at <dataDir>/.mcp-secret (mode 0600). Mirrors updater.EnsureSecret.
func EnsureSecret(dataDir string) (string, error) {
	p := filepath.Join(dataDir, ".mcp-secret")
	if b, err := os.ReadFile(p); err == nil {
		if s := strings.TrimSpace(string(b)); len(s) >= 32 {
			return s, nil
		}
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	s := hex.EncodeToString(buf)
	if err := os.WriteFile(p, []byte(s), 0o600); err != nil {
		return "", err
	}
	return s, nil
}

// RotateSecret forces a new secret, overwriting any existing file.
func RotateSecret(dataDir string) (string, error) {
	p := filepath.Join(dataDir, ".mcp-secret")
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	s := hex.EncodeToString(buf)
	if err := os.WriteFile(p, []byte(s), 0o600); err != nil {
		return "", err
	}
	return s, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/backend && go test ./mcpserver/ -run TestEnsureSecret -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/mcpserver/secret.go src/backend/mcpserver/secret_test.go
git commit -m "feat(mcp): per-install .mcp-secret ensure/rotate"
```

---

### Task 3: Enable-state + config flags

The MCP server reads two booleans from the existing `config` table: `mcp_enabled` and `mcp_drive_ui`. We add a small `Config` accessor interface so `mcpserver` does not import `databank` directly (keeps the boundary clean and testable).

**Files:**
- Create: `src/backend/mcpserver/state.go`
- Test: `src/backend/mcpserver/state_test.go`

- [ ] **Step 1: Write the failing test**

`src/backend/mcpserver/state_test.go`:
```go
package mcpserver

import "testing"

type fakeConfig struct{ m map[string]string }

func (f *fakeConfig) GetConfig(k string) (string, error) { return f.m[k], nil }

func TestState_Defaults(t *testing.T) {
	st := NewState(&fakeConfig{m: map[string]string{}})
	if st.Enabled() {
		t.Fatal("MCP should be disabled by default")
	}
	if st.DriveUI() {
		t.Fatal("drive-UI should be off by default")
	}
}

func TestState_ReadsFlags(t *testing.T) {
	st := NewState(&fakeConfig{m: map[string]string{"mcp_enabled": "1", "mcp_drive_ui": "1"}})
	if !st.Enabled() || !st.DriveUI() {
		t.Fatal("flags not read")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && go test ./mcpserver/ -run TestState -v`
Expected: FAIL (`undefined: NewState`).

- [ ] **Step 3: Write minimal implementation**

`src/backend/mcpserver/state.go`:
```go
package mcpserver

// ConfigReader is the subset of databank.DB the MCP server needs. GetConfig
// returns ("", nil) for missing keys (matches databank.DB.GetConfig).
type ConfigReader interface {
	GetConfig(key string) (string, error)
}

// State exposes live feature flags backed by the config table.
type State struct{ cfg ConfigReader }

func NewState(cfg ConfigReader) *State { return &State{cfg: cfg} }

func (s *State) flag(key string) bool {
	v, err := s.cfg.GetConfig(key)
	if err != nil {
		return false
	}
	return v == "1" || v == "true"
}

// Enabled reports whether the MCP server should serve requests.
func (s *State) Enabled() bool { return s.flag("mcp_enabled") }

// DriveUI reports whether mutating drive-UI tools should be registered.
func (s *State) DriveUI() bool { return s.flag("mcp_drive_ui") }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/backend && go test ./mcpserver/ -run TestState -v`
Expected: PASS.

- [ ] **Step 5: Allow the new config keys through the write whitelist**

Modify `src/backend/handlers/databank.go` — add to `allowedConfigKeys` (after `"pdf_watermark_terms": true,`):
```go
	"mcp_enabled":   true,
	"mcp_drive_ui":  true,
```

- [ ] **Step 6: Build + commit**

Run: `cd src/backend && go build ./... && go test ./mcpserver/ -run TestState`
Expected: PASS.
```bash
git add src/backend/mcpserver/state.go src/backend/mcpserver/state_test.go src/backend/handlers/databank.go
git commit -m "feat(mcp): config-backed enable + drive-UI flags"
```

---

### Task 4: Bearer auth + disabled-gate middleware

**Files:**
- Create: `src/backend/mcpserver/auth.go`
- Test: `src/backend/mcpserver/auth_test.go`

- [ ] **Step 1: Write the failing test**

`src/backend/mcpserver/auth_test.go`:
```go
package mcpserver

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
}

func TestGate_DisabledReturns404(t *testing.T) {
	st := NewState(&fakeConfig{m: map[string]string{}}) // disabled
	h := Gate(st, "secret123secret123secret123secret1", okHandler())
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/mcp", nil)
	req.Header.Set("Authorization", "Bearer secret123secret123secret123secret1")
	h.ServeHTTP(rec, req)
	if rec.Code != 404 {
		t.Fatalf("code = %d, want 404 when disabled", rec.Code)
	}
}

func TestGate_EnabledRejectsBadToken(t *testing.T) {
	st := NewState(&fakeConfig{m: map[string]string{"mcp_enabled": "1"}})
	h := Gate(st, "secret123secret123secret123secret1", okHandler())
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/mcp", nil)
	req.Header.Set("Authorization", "Bearer wrong")
	h.ServeHTTP(rec, req)
	if rec.Code != 401 {
		t.Fatalf("code = %d, want 401", rec.Code)
	}
}

func TestGate_EnabledAcceptsGoodToken(t *testing.T) {
	st := NewState(&fakeConfig{m: map[string]string{"mcp_enabled": "1"}})
	h := Gate(st, "secret123secret123secret123secret1", okHandler())
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/mcp", nil)
	req.Header.Set("Authorization", "Bearer secret123secret123secret123secret1")
	h.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("code = %d, want 200", rec.Code)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && go test ./mcpserver/ -run TestGate -v`
Expected: FAIL (`undefined: Gate`).

- [ ] **Step 3: Write minimal implementation**

`src/backend/mcpserver/auth.go`:
```go
package mcpserver

import (
	"crypto/subtle"
	"net/http"
	"strings"
)

// Gate enforces the enable flag and bearer-token auth. When MCP is disabled the
// endpoint returns 404 so it is invisible to scanners. When enabled, requests
// must carry "Authorization: Bearer <secret>".
func Gate(st *State, secret string, next http.Handler) http.Handler {
	secretB := []byte(secret)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !st.Enabled() {
			http.NotFound(w, r)
			return
		}
		tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if subtle.ConstantTimeCompare([]byte(tok), secretB) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/backend && go test ./mcpserver/ -run TestGate -v`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add src/backend/mcpserver/auth.go src/backend/mcpserver/auth_test.go
git commit -m "feat(mcp): bearer auth + disabled-gate (404 when off)"
```

---

### Task 5: Build the SDK server with a `ping` tool + smoke test

**Files:**
- Create: `src/backend/mcpserver/server.go`
- Test: `src/backend/mcpserver/server_test.go`
- Modify: `src/backend/main.go`

- [ ] **Step 1: Write the server skeleton**

`src/backend/mcpserver/server.go`:
```go
package mcpserver

import (
	"context"
	"net/http"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Deps is the set of backend stores the tools read from. Concrete *databank.DB
// etc. are passed in from main; the interfaces live in tools_native.go.
type Deps struct {
	State  *State
	Bridge *Bridge
	PDF    PDFSearcher
	Files  FileStore
	Boards BoardResolver
	OBD    ObdStore
}

// Server wraps the SDK MCP server plus its Streamable HTTP handler.
type Server struct {
	deps *Deps
	mcp  *mcp.Server
	http http.Handler
}

type pingArgs struct{}
type pingResult struct {
	OK      bool   `json:"ok"`
	Service string `json:"service"`
}

// New builds the MCP server and registers all tools. Drive-UI tools are
// registered only when State.DriveUI() is true at construction time; main
// rebuilds the server when the flag changes (see Task 17 status endpoint).
func New(deps *Deps) *Server {
	s := &Server{deps: deps}
	s.mcp = mcp.NewServer(&mcp.Implementation{Name: "boardripper", Version: "1"}, nil)

	mcp.AddTool(s.mcp, &mcp.Tool{
		Name:        "ping",
		Description: "Health check; returns ok.",
	}, func(ctx context.Context, req *mcp.CallToolRequest, _ pingArgs) (*mcp.CallToolResult, pingResult, error) {
		return nil, pingResult{OK: true, Service: "boardripper"}, nil
	})

	registerNativeTools(s.mcp, deps)
	registerLiveTools(s.mcp, deps)

	s.http = mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return s.mcp }, nil)
	return s
}

// Handler returns the Streamable HTTP handler for mounting at /api/mcp.
func (s *Server) Handler() http.Handler { return s.http }
```

> **Note for implementer:** the exact `mcp.AddTool` / `NewStreamableHTTPHandler` signatures must be confirmed against the installed go-sdk version (`go doc github.com/modelcontextprotocol/go-sdk/mcp`). The shape above matches the 2025-06-18 API (typed-args handler returning `(*CallToolResult, TOut, error)`); adjust the handler signature if `go doc` differs, but keep the tool names/inputs/outputs identical.

- [ ] **Step 2: Add empty registration stubs so it compiles**

Create `src/backend/mcpserver/tools_native.go` with a stub (filled in Phase B):
```go
package mcpserver

import "github.com/modelcontextprotocol/go-sdk/mcp"

func registerNativeTools(s *mcp.Server, deps *Deps) { /* Phase B */ }
```
Create `src/backend/mcpserver/tools_live.go` with a stub (filled in Phase D):
```go
package mcpserver

import "github.com/modelcontextprotocol/go-sdk/mcp"

func registerLiveTools(s *mcp.Server, deps *Deps) { /* Phase D */ }
```
Add the interface placeholders to `tools_native.go` so `Deps` compiles:
```go
type PDFSearcher interface{}
type FileStore interface{}
type BoardResolver interface{}
type ObdStore interface{}
```
And a `Bridge` placeholder in `bridge.go` (real impl in Phase C) — create `src/backend/mcpserver/bridge.go`:
```go
package mcpserver

// Bridge is implemented in Phase C.
type Bridge struct{}
```

- [ ] **Step 3: Write the smoke test using the go-sdk in-memory client**

`src/backend/mcpserver/server_test.go`:
```go
package mcpserver

import (
	"context"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestServer_PingViaInMemoryClient(t *testing.T) {
	deps := &Deps{State: NewState(&fakeConfig{m: map[string]string{"mcp_enabled": "1"}})}
	srv := New(deps)

	ct, st := mcp.NewInMemoryTransports()
	if _, err := srv.mcp.Connect(context.Background(), st, nil); err != nil {
		t.Fatalf("server connect: %v", err)
	}
	client := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, nil)
	sess, err := client.Connect(context.Background(), ct, nil)
	if err != nil {
		t.Fatalf("client connect: %v", err)
	}
	defer sess.Close()

	res, err := sess.CallTool(context.Background(), &mcp.CallToolParams{Name: "ping"})
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if res.IsError {
		t.Fatalf("ping returned error result")
	}
}
```

> **Note:** `NewInMemoryTransports` / `Connect` / `CallTool` names follow the go-sdk examples; confirm via `go doc` and adjust if the installed version renamed them. The behavioral assertion (ping succeeds) stays the same.

- [ ] **Step 4: Run test**

Run: `cd src/backend && go test ./mcpserver/ -run TestServer_Ping -v`
Expected: PASS.

- [ ] **Step 5: Mount in main.go**

In `src/backend/main.go`, after the databank handler is constructed and before the middleware wrap (`handler := withSecurityHeaders(...)`), add:
```go
	// --- MCP server (off by default; enabled via Settings > Integrations) ---
	mcpSecret, err := mcpserver.EnsureSecret(dataDir)
	if err != nil {
		log.Fatalf("mcp secret: %v", err)
	}
	mcpState := mcpserver.NewState(db)
	mcpBridge := mcpserver.NewBridge() // real impl lands in Phase C; stub returns &Bridge{}
	mcpSrv := mcpserver.New(&mcpserver.Deps{
		State:  mcpState,
		Bridge: mcpBridge,
		PDF:    pdfIndexDB, // wired in Phase B; nil-safe until then
		Files:  db,
		Boards: boardDB,
		OBD:    obdStore,
	})
	mux.Handle("/api/mcp", mcpserver.Gate(mcpState, mcpSecret, mcpSrv.Handler()))
	mux.Handle("/api/mcp/", mcpserver.Gate(mcpState, mcpSecret, mcpSrv.Handler()))
```

Add a `NewBridge` constructor stub to `bridge.go` so this compiles:
```go
func NewBridge() *Bridge { return &Bridge{} }
```

> **Note:** Use the exact local variable names already present in `main.go` for the databank `*databank.DB` (shown as `db`), the pdfindex DB, the `*boarddb.DB`, and the OBD store. If a store is constructed later in the file, move the MCP block below it.
>
> **Typed-nil gotcha (important):** pdfindex/boarddb/obd are optional and may be a *typed* nil pointer. Assigning a typed-nil `*pdfindex.DB` into the `PDFSearcher` interface makes `deps.PDF != nil` TRUE (interface holds a non-nil type with a nil value) — so the `deps.PDF != nil` guards in Phase B would pass and then panic on call. Guard in main: only assign when non-nil, e.g. `if pdfIndexDB != nil { deps.PDF = pdfIndexDB }`, leaving the interface field as untyped nil otherwise. Do the same for `Boards`/`OBD`.

- [ ] **Step 6: Build + commit**

Run: `cd src/backend && go build ./... && go test ./mcpserver/`
Expected: PASS.
```bash
git add src/backend/mcpserver/ src/backend/main.go
git commit -m "feat(mcp): SDK server scaffold + ping tool, mounted at /api/mcp (gated)"
```

---

## PHASE B — Backend-native tools

All native tools live in `tools_native.go`. First replace the placeholder interfaces with real ones matching the verified signatures, then add tools one per task. Each tool uses `mcp.AddTool` with typed args/results.

### Task 6: `pdf_search` + `pdf_page_text`

**Files:**
- Modify: `src/backend/mcpserver/tools_native.go`
- Test: `src/backend/mcpserver/tools_native_test.go`

- [ ] **Step 1: Replace the interface placeholders with real ones**

In `tools_native.go`, replace `type PDFSearcher interface{}` and `type FileStore interface{}` etc. with:
```go
import (
	"context"

	"boardripper/databank"
	"boardripper/pdfindex"
	"boardripper/boarddb"
	"boardripper/obd"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// PDFSearcher is satisfied by *pdfindex.DB.
type PDFSearcher interface {
	SearchPages(query string, restrictTo []int64, limit int) ([]pdfindex.SearchHit, error)
}

// FileStore is satisfied by *databank.DB.
type FileStore interface {
	ListFiles(ctx context.Context, fileType, manufacturer string, donorOnly bool) ([]databank.FileRecord, error)
	GetFileByID(ctx context.Context, id int64) (*databank.FileRecord, error)
	GetBindingsForFile(ctx context.Context, fileID int64) ([]databank.BindingDetail, error)
	GetConfig(key string) (string, error)
}

// BoardResolver is satisfied by *boarddb.DB.
type BoardResolver interface {
	Resolve(boardNumber string) *boarddb.BoardMatch
}

// ObdStore is satisfied by *obd.Store.
type ObdStore interface {
	ReadIndex() (*obd.Index, error)
	ReadParsed(bpath string) (*obd.ObdData, error)
}
```

> **Note:** confirm the import path prefix (`boardripper/...`) matches `module boardripper` in go.mod (it does). Confirm `pdfindex.DB` and `obd.Store` are the concrete types passed from main and that the methods are exported as listed. `GetFileByID`/`GetBindingsForFile` take `context.Context` per the verified signatures.

- [ ] **Step 2: Write the failing test (page text helper + search wiring)**

`src/backend/mcpserver/tools_native_test.go`:
```go
package mcpserver

import (
	"context"
	"testing"

	"boardripper/pdfindex"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type fakePDF struct{ hits []pdfindex.SearchHit }

func (f *fakePDF) SearchPages(q string, r []int64, l int) ([]pdfindex.SearchHit, error) {
	return f.hits, nil
}

func TestPdfSearchTool_ReturnsHits(t *testing.T) {
	deps := &Deps{
		State: NewState(&fakeConfig{m: map[string]string{"mcp_enabled": "1"}}),
		PDF:   &fakePDF{hits: []pdfindex.SearchHit{{FileID: 7, PageNum: 3, Snippet: "AOZ5332"}}},
	}
	srv := New(deps)
	ct, st := mcp.NewInMemoryTransports()
	srv.mcp.Connect(context.Background(), st, nil)
	client := mcp.NewClient(&mcp.Implementation{Name: "t", Version: "1"}, nil)
	sess, _ := client.Connect(context.Background(), ct, nil)
	defer sess.Close()

	res, err := sess.CallTool(context.Background(), &mcp.CallToolParams{
		Name:      "pdf_search",
		Arguments: map[string]any{"query": "AOZ5332"},
	})
	if err != nil || res.IsError {
		t.Fatalf("pdf_search failed: err=%v isErr=%v", err, res.IsError)
	}
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd src/backend && go test ./mcpserver/ -run TestPdfSearchTool -v`
Expected: FAIL (tool `pdf_search` not registered / `IsError`).

- [ ] **Step 4: Implement the tools in `registerNativeTools`**

Replace the stub body of `registerNativeTools` with:
```go
type pdfSearchArgs struct {
	Query string `json:"query" jsonschema:"the full-text query (part numbers, designators, etc.)"`
	Scope string `json:"scope,omitempty" jsonschema:"all (default) or donor to restrict to the donor pool"`
	Limit int    `json:"limit,omitempty" jsonschema:"max hits (default 200, cap 1000)"`
}
type pdfHit struct {
	FileID  int64  `json:"file_id"`
	PageNum int    `json:"page_num"`
	Snippet string `json:"snippet"`
}
type pdfSearchResult struct {
	Hits  []pdfHit `json:"hits"`
	Total int      `json:"total"`
}

func registerNativeTools(s *mcp.Server, deps *Deps) {
	if deps.PDF != nil {
		mcp.AddTool(s, &mcp.Tool{
			Name:        "pdf_search",
			Description: "Full-text search across the indexed PDF library. Returns file_id, page, and a snippet.",
		}, func(ctx context.Context, _ *mcp.CallToolRequest, a pdfSearchArgs) (*mcp.CallToolResult, pdfSearchResult, error) {
			limit := a.Limit
			if limit <= 0 || limit > 1000 {
				limit = 200
			}
			// Donor scoping is intentionally omitted in v1 (needs DonorFileIDs on the
			// interface); scope!="donor" behaves as "all". Add in a follow-up.
			hits, err := deps.PDF.SearchPages(a.Query, nil, limit)
			if err != nil {
				return nil, pdfSearchResult{}, err
			}
			out := make([]pdfHit, 0, len(hits))
			for _, h := range hits {
				out = append(out, pdfHit{FileID: h.FileID, PageNum: h.PageNum, Snippet: h.Snippet})
			}
			return nil, pdfSearchResult{Hits: out, Total: len(out)}, nil
		})
	}

	registerObdTools(s, deps)
	registerBoardTool(s, deps)
	registerFileTools(s, deps)
}
```

Add a `pdf_page_text` tool requires a page-text getter not in the verified interface set; defer it to a follow-up and DO NOT register it in v1 (YAGNI — search snippets cover the primary use). Document this in the tool list.

> **Decision recorded:** `pdf_page_text` and donor-scoping are deferred to keep the interface minimal; `pdf_search` ships first. Update the spec's tool table accordingly when implementing.

- [ ] **Step 5: Add empty stubs for the other native registrars so it compiles**

In `tools_native.go`:
```go
func registerObdTools(s *mcp.Server, deps *Deps)  { /* Task 7 */ }
func registerBoardTool(s *mcp.Server, deps *Deps) { /* Task 8 */ }
func registerFileTools(s *mcp.Server, deps *Deps) { /* Task 9 */ }
```

- [ ] **Step 6: Run test + commit**

Run: `cd src/backend && go test ./mcpserver/ -run TestPdfSearchTool -v`
Expected: PASS.
```bash
git add src/backend/mcpserver/tools_native.go src/backend/mcpserver/tools_native_test.go
git commit -m "feat(mcp): pdf_search tool"
```

---

### Task 7: `obd_match` + `obd_data`

**Files:**
- Modify: `src/backend/mcpserver/tools_native.go`

- [ ] **Step 1: Implement `registerObdTools`**

Replace the stub:
```go
type obdMatchArgs struct {
	BoardNumber string `json:"board_number" jsonschema:"board number to match against the OBD index"`
}
type obdMatch struct {
	Bpath string `json:"bpath"`
}
type obdMatchResult struct {
	Matches []obdMatch `json:"matches"`
}
type obdDataArgs struct {
	Bpath string `json:"bpath" jsonschema:"the bpath returned by obd_match"`
}

func registerObdTools(s *mcp.Server, deps *Deps) {
	if deps.OBD == nil {
		return
	}
	mcp.AddTool(s, &mcp.Tool{
		Name:        "obd_match",
		Description: "Match a board number against the cached OpenBoardData index. Returns candidate bpaths for obd_data.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, a obdMatchArgs) (*mcp.CallToolResult, obdMatchResult, error) {
		idx, err := deps.OBD.ReadIndex()
		if err != nil || idx == nil {
			return nil, obdMatchResult{Matches: []obdMatch{}}, nil
		}
		var out []obdMatch
		for _, bp := range matchIndex(idx, a.BoardNumber) {
			out = append(out, obdMatch{Bpath: bp})
		}
		return nil, obdMatchResult{Matches: out}, nil
	})

	mcp.AddTool(s, &mcp.Tool{
		Name:        "obd_data",
		Description: "Fetch cached OpenBoardData diagnostics (nets with diode/voltage/resistance + diagnosis sections) for a bpath.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, a obdDataArgs) (*mcp.CallToolResult, *obd.ObdData, error) {
		data, err := deps.OBD.ReadParsed(a.Bpath)
		if err != nil {
			return nil, nil, err
		}
		return nil, data, nil
	})
}
```

- [ ] **Step 2: Implement the `matchIndex` helper using the existing OBD matching logic**

> **Discovery step (required):** open `src/backend/handlers/obd.go` `Match` (lines ~102–139) and copy the exact board-number→index matching it performs (it iterates `idx` entries comparing normalized board numbers). Extract that comparison into:
```go
// matchIndex returns bpaths from idx whose board number matches q, using the
// same normalization as handlers/obd.go Match.
func matchIndex(idx *obd.Index, q string) []string {
	// PASTE the matching loop from handlers.ObdHandler.Match here, returning
	// the bpath of each matched entry. Do not invent new normalization.
	return nil
}
```
Fill the body from the real handler so behavior is identical.

- [ ] **Step 3: Build + commit**

Run: `cd src/backend && go build ./... && go vet ./mcpserver/`
Expected: exit 0.
```bash
git add src/backend/mcpserver/tools_native.go
git commit -m "feat(mcp): obd_match + obd_data tools"
```

---

### Task 8: `board_resolve`

**Files:**
- Modify: `src/backend/mcpserver/tools_native.go`

- [ ] **Step 1: Implement `registerBoardTool`**

```go
type boardResolveArgs struct {
	BoardNumber string `json:"board_number" jsonschema:"board number to resolve (e.g. 820-02016, LA-K371P)"`
}

func registerBoardTool(s *mcp.Server, deps *Deps) {
	if deps.Boards == nil {
		return
	}
	mcp.AddTool(s, &mcp.Tool{
		Name:        "board_resolve",
		Description: "Resolve a board number to brand/family/model/color/ODM/aliases from the reference DB.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, a boardResolveArgs) (*mcp.CallToolResult, *boarddb.BoardMatch, error) {
		m := deps.Boards.Resolve(a.BoardNumber)
		if m == nil {
			return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: "no match"}}}, nil, nil
		}
		return nil, m, nil
	})
}
```

> **Note:** confirm the exact way the go-sdk wants an "error result with no structured output" — the shape `&mcp.CallToolResult{IsError:true, Content:[]mcp.Content{&mcp.TextContent{...}}}` matches the 2025-06-18 API. If `go doc` shows `Content` takes a different concrete type, adjust the literal but keep IsError semantics.

- [ ] **Step 2: Build + commit**

Run: `cd src/backend && go build ./...`
```bash
git add src/backend/mcpserver/tools_native.go
git commit -m "feat(mcp): board_resolve tool"
```

---

### Task 9: `file_list` + `file_get`

**Files:**
- Modify: `src/backend/mcpserver/tools_native.go`

- [ ] **Step 1: Implement `registerFileTools`**

```go
type fileListArgs struct {
	FileType     string `json:"file_type,omitempty" jsonschema:"filter: board | pdf | other"`
	Manufacturer string `json:"manufacturer,omitempty"`
	DonorOnly    bool   `json:"donor_only,omitempty"`
}
type fileGetArgs struct {
	ID int64 `json:"id"`
}
type fileGetResult struct {
	File     *databank.FileRecord     `json:"file"`
	Bindings []databank.BindingDetail `json:"bindings"`
}

func registerFileTools(s *mcp.Server, deps *Deps) {
	if deps.Files == nil {
		return
	}
	mcp.AddTool(s, &mcp.Tool{
		Name:        "file_list",
		Description: "List indexed board/PDF files with optional type/manufacturer/donor filters.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, a fileListArgs) (*mcp.CallToolResult, []databank.FileRecord, error) {
		recs, err := deps.Files.ListFiles(ctx, a.FileType, a.Manufacturer, a.DonorOnly)
		if err != nil {
			return nil, nil, err
		}
		return nil, recs, nil
	})

	mcp.AddTool(s, &mcp.Tool{
		Name:        "file_get",
		Description: "Get one file's metadata plus its board/PDF bindings.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, a fileGetArgs) (*mcp.CallToolResult, fileGetResult, error) {
		rec, err := deps.Files.GetFileByID(ctx, a.ID)
		if err != nil {
			return nil, fileGetResult{}, err
		}
		bindings, _ := deps.Files.GetBindingsForFile(ctx, a.ID)
		return nil, fileGetResult{File: rec, Bindings: bindings}, nil
	})
}
```

- [ ] **Step 2: Build + commit**

Run: `cd src/backend && go build ./... && go test ./mcpserver/`
Expected: PASS.
```bash
git add src/backend/mcpserver/tools_native.go
git commit -m "feat(mcp): file_list + file_get tools"
```

---

## PHASE C — Browser bridge (Go)

### Task 10: `Bridge` — session registry, correlation, timeout

**Files:**
- Rewrite: `src/backend/mcpserver/bridge.go`
- Test: `src/backend/mcpserver/bridge_test.go`

- [ ] **Step 1: Write the failing test (correlation + timeout, no real WS)**

`src/backend/mcpserver/bridge_test.go`:
```go
package mcpserver

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestBridge_RequestResponseCorrelation(t *testing.T) {
	b := NewBridge()
	sess := b.register("s1", json.RawMessage(`{"name":"DemoBoard"}`))
	defer b.unregister("s1")

	// Simulate the browser answering: read the outbound frame, reply by id.
	go func() {
		frame := <-sess.outbound
		_ = b.deliver("s1", bridgeReply{ID: frame.ID, OK: true, Result: json.RawMessage(`{"nets":3}`)})
	}()

	res, err := b.Request(context.Background(), "", "list_nets", map[string]any{}, 2*time.Second)
	if err != nil {
		t.Fatalf("Request: %v", err)
	}
	if string(res) != `{"nets":3}` {
		t.Fatalf("result = %s", res)
	}
}

func TestBridge_TimeoutWhenNoReply(t *testing.T) {
	b := NewBridge()
	b.register("s1", json.RawMessage(`{}`))
	defer b.unregister("s1")
	_, err := b.Request(context.Background(), "", "list_nets", nil, 100*time.Millisecond)
	if err == nil {
		t.Fatal("expected timeout error")
	}
}

func TestBridge_NoSession(t *testing.T) {
	b := NewBridge()
	_, err := b.Request(context.Background(), "", "list_nets", nil, time.Second)
	if err == nil {
		t.Fatal("expected error when no tab connected")
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src/backend && go test ./mcpserver/ -run TestBridge -v`
Expected: FAIL (undefined `register`/`Request`/etc.).

- [ ] **Step 3: Implement the bridge core (transport-agnostic)**

`src/backend/mcpserver/bridge.go`:
```go
package mcpserver

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"
)

type bridgeFrame struct {
	ID     int64           `json:"id"`
	Op     string          `json:"op"`
	Params json.RawMessage `json:"params"`
}
type bridgeReply struct {
	ID     int64           `json:"id"`
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  string          `json:"error,omitempty"`
}

type session struct {
	id        string
	board     json.RawMessage // descriptor from `hello`/`board_changed`
	outbound  chan bridgeFrame
	focusedAt time.Time
}

// Bridge tracks connected browser pages and correlates request/response.
type Bridge struct {
	mu       sync.Mutex
	sessions map[string]*session
	pending  map[int64]chan bridgeReply
	nextID   int64
}

func NewBridge() *Bridge {
	return &Bridge{sessions: map[string]*session{}, pending: map[int64]chan bridgeReply{}}
}

func (b *Bridge) register(id string, board json.RawMessage) *session {
	b.mu.Lock()
	defer b.mu.Unlock()
	s := &session{id: id, board: board, outbound: make(chan bridgeFrame, 8), focusedAt: time.Now()}
	b.sessions[id] = s
	return s
}

func (b *Bridge) unregister(id string) {
	b.mu.Lock()
	delete(b.sessions, id)
	b.mu.Unlock()
}

func (b *Bridge) touchFocus(id string) {
	b.mu.Lock()
	if s := b.sessions[id]; s != nil {
		s.focusedAt = time.Now()
	}
	b.mu.Unlock()
}

func (b *Bridge) setBoard(id string, board json.RawMessage) {
	b.mu.Lock()
	if s := b.sessions[id]; s != nil {
		s.board = board
	}
	b.mu.Unlock()
}

// pick returns the target session: explicit id, else most-recently-focused.
func (b *Bridge) pick(sessionID string) *session {
	b.mu.Lock()
	defer b.mu.Unlock()
	if sessionID != "" {
		return b.sessions[sessionID]
	}
	var best *session
	for _, s := range b.sessions {
		if best == nil || s.focusedAt.After(best.focusedAt) {
			best = s
		}
	}
	return best
}

func (b *Bridge) deliver(_ string, r bridgeReply) error {
	b.mu.Lock()
	ch := b.pending[r.ID]
	delete(b.pending, r.ID)
	b.mu.Unlock()
	if ch == nil {
		return errors.New("no pending request for id")
	}
	ch <- r
	return nil
}

// Request sends op/params to the chosen tab and waits for a reply or timeout.
func (b *Bridge) Request(ctx context.Context, sessionID, op string, params any, timeout time.Duration) (json.RawMessage, error) {
	s := b.pick(sessionID)
	if s == nil {
		return nil, errors.New("no board open in BoardRipper — open a board in the browser first")
	}
	raw, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	b.mu.Lock()
	b.nextID++
	id := b.nextID
	reply := make(chan bridgeReply, 1)
	b.pending[id] = reply
	b.mu.Unlock()

	select {
	case s.outbound <- bridgeFrame{ID: id, Op: op, Params: raw}:
	case <-time.After(timeout):
		b.cancel(id)
		return nil, errors.New("bridge send timeout")
	}

	select {
	case r := <-reply:
		if !r.OK {
			return nil, errors.New(r.Error)
		}
		return r.Result, nil
	case <-time.After(timeout):
		b.cancel(id)
		return nil, errors.New("bridge request timed out (no tab response)")
	case <-ctx.Done():
		b.cancel(id)
		return nil, ctx.Err()
	}
}

func (b *Bridge) cancel(id int64) {
	b.mu.Lock()
	delete(b.pending, id)
	b.mu.Unlock()
}

// Sessions returns descriptors of all connected boards (for board_sessions).
func (b *Bridge) Sessions() []json.RawMessage {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]json.RawMessage, 0, len(b.sessions))
	for _, s := range b.sessions {
		out = append(out, s.board)
	}
	return out
}
```

- [ ] **Step 4: Run tests**

Run: `cd src/backend && go test ./mcpserver/ -run TestBridge -v`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add src/backend/mcpserver/bridge.go src/backend/mcpserver/bridge_test.go
git commit -m "feat(mcp): bridge session registry + request/response correlation"
```

---

### Task 11: WebSocket endpoint for the bridge

**Files:**
- Create: `src/backend/mcpserver/bridge_ws.go`
- Modify: `src/backend/main.go`

- [ ] **Step 1: Implement the WS handler**

`src/backend/mcpserver/bridge_ws.go`:
```go
package mcpserver

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/coder/websocket"
)

type helloMsg struct {
	Type    string          `json:"type"` // "hello" | "board_changed" | "focus" | "reply"
	Session string          `json:"session"`
	Board   json.RawMessage `json:"board,omitempty"`
	Reply   *bridgeReply    `json:"reply,omitempty"`
}

// ServeWS upgrades the connection and runs the read/write loops. Same-origin
// only: it relies on the SPA being served from the same host (the SDK Gate is
// NOT applied here; the bridge is reachable only by the trusted frontend).
func (b *Bridge) ServeWS(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: []string{"*"}, // same-origin enforced by deployment; tighten if exposed
	})
	if err != nil {
		return
	}
	defer c.CloseNow()
	ctx := r.Context()

	// First frame must be hello.
	var hello helloMsg
	if err := readJSON(ctx, c, &hello); err != nil || hello.Type != "hello" || hello.Session == "" {
		return
	}
	s := b.register(hello.Session, hello.Board)
	defer b.unregister(hello.Session)

	// Writer: drain outbound frames to the browser.
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case f := <-s.outbound:
				if err := writeJSON(ctx, c, f); err != nil {
					return
				}
			}
		}
	}()

	// Reader: handle focus/board_changed/reply.
	for {
		var m helloMsg
		if err := readJSON(ctx, c, &m); err != nil {
			return
		}
		switch m.Type {
		case "focus":
			b.touchFocus(hello.Session)
		case "board_changed":
			b.setBoard(hello.Session, m.Board)
		case "reply":
			if m.Reply != nil {
				_ = b.deliver(hello.Session, *m.Reply)
			}
		}
	}
}

func readJSON(ctx context.Context, c *websocket.Conn, v any) error {
	rctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	_, data, err := c.Read(rctx)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}

func writeJSON(ctx context.Context, c *websocket.Conn, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return c.Write(wctx, websocket.MessageText, data)
}
```

> **Note:** confirm `coder/websocket`'s `Accept`/`Read`/`Write` signatures via `go doc github.com/coder/websocket`. The above matches the current API (`websocket.Accept(w, r, *AcceptOptions)` → `(*Conn, error)`; `c.Read(ctx) (MessageType, []byte, error)`; `c.Write(ctx, MessageType, []byte)`).

- [ ] **Step 2: Mount the WS route in main.go**

In `main.go`, next to the `/api/mcp` mounts (note: NOT wrapped by `Gate` — the bridge is for the same-origin SPA only):
```go
	mux.HandleFunc("/api/mcp/bridge", mcpBridge.ServeWS)
```

- [ ] **Step 3: Build + commit**

Run: `cd src/backend && go build ./...`
Expected: exit 0.
```bash
git add src/backend/mcpserver/bridge_ws.go src/backend/main.go
git commit -m "feat(mcp): WebSocket bridge endpoint /api/mcp/bridge"
```

---

## PHASE D — Live-board tools

### Task 12: Live-board read tools

**Files:**
- Rewrite: `src/backend/mcpserver/tools_live.go`

- [ ] **Step 1: Implement read tools that proxy through the bridge**

`src/backend/mcpserver/tools_live.go`:
```go
package mcpserver

import (
	"context"
	"encoding/json"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const bridgeTimeout = 10 * time.Second

// liveTool registers a tool that forwards {op, args} to the active browser tab
// and returns the tab's JSON result verbatim.
func liveTool[T any](s *mcp.Server, b *Bridge, name, desc, op string, readOnly bool) {
	ro := readOnly
	mcp.AddTool(s, &mcp.Tool{
		Name:        name,
		Description: desc,
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: &ro},
	}, func(ctx context.Context, _ *mcp.CallToolRequest, a T) (*mcp.CallToolResult, json.RawMessage, error) {
		res, err := b.Request(ctx, "", op, a, bridgeTimeout)
		if err != nil {
			return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: err.Error()}}}, nil, nil
		}
		return nil, res, nil
	})
}

type emptyArgs struct {
	Session string `json:"session,omitempty" jsonschema:"optional browser session id from board_sessions"`
}
type netArgs struct {
	Net     string `json:"net"`
	Session string `json:"session,omitempty"`
}
type netNeighborsArgs struct {
	Net     string `json:"net"`
	Depth   int    `json:"depth,omitempty" jsonschema:"hops (default 1)"`
	Session string `json:"session,omitempty"`
}
type partArgs struct {
	Refdes  string `json:"refdes"`
	Session string `json:"session,omitempty"`
}
type pinArgs struct {
	Part    string `json:"part"`
	Pin     string `json:"pin"`
	Session string `json:"session,omitempty"`
}
type filterArgs struct {
	Filter  string `json:"filter,omitempty" jsonschema:"optional substring filter"`
	Session string `json:"session,omitempty"`
}

func registerLiveTools(s *mcp.Server, deps *Deps) {
	b := deps.Bridge

	// board_sessions answered in Go (registry), not proxied.
	mcp.AddTool(s, &mcp.Tool{
		Name:        "board_sessions",
		Description: "List the boards currently open in connected BoardRipper pages.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, []json.RawMessage, error) {
		return nil, b.Sessions(), nil
	})

	liveTool[emptyArgs](s, b, "board_active", "Describe the active board (name, format, part/net counts, side).", "board_active", true)
	liveTool[filterArgs](s, b, "list_nets", "List net names on the active board (optional substring filter).", "list_nets", true)
	liveTool[filterArgs](s, b, "list_parts", "List component refdes on the active board (optional substring filter).", "list_parts", true)
	liveTool[netArgs](s, b, "net_info", "Pins and parts on a given net.", "net_info", true)
	liveTool[netNeighborsArgs](s, b, "net_neighbors", "Adjacent nets reachable through 2-pin components (computeAdjacentNets).", "net_neighbors", true)
	liveTool[pinArgs](s, b, "pin_connectivity", "Net and connected pins for a given part/pin.", "pin_connectivity", true)
	liveTool[partArgs](s, b, "part_info", "Pins, value, package, side, and bounds for a component.", "part_info", true)

	registerDriveTools(s, deps) // gated inside
}
```

> **Note:** `mcp.ToolAnnotations{ReadOnlyHint: *bool}` matches the spec's tool annotations; confirm field names via `go doc`. Generic tool registration with `liveTool[T]` keeps each tool a single line.

- [ ] **Step 2: Build + commit**

Run: `cd src/backend && go build ./...`
```bash
git add src/backend/mcpserver/tools_live.go
git commit -m "feat(mcp): live-board read tools via bridge"
```

---

### Task 13: Drive-UI tools (gated)

**Files:**
- Modify: `src/backend/mcpserver/tools_live.go`

- [ ] **Step 1: Implement `registerDriveTools`, registered only when DriveUI() is on**

```go
type highlightArgs struct {
	Net     string `json:"net"`
	Session string `json:"session,omitempty"`
}
type selectArgs struct {
	Refdes  string `json:"refdes"`
	Session string `json:"session,omitempty"`
}
type sideArgs struct {
	Side    string `json:"side" jsonschema:"top or bottom"`
	Session string `json:"session,omitempty"`
}
type pdfGotoArgs struct {
	Page    int    `json:"page"`
	Term    string `json:"term,omitempty" jsonschema:"optional search term to jump to"`
	Session string `json:"session,omitempty"`
}

func registerDriveTools(s *mcp.Server, deps *Deps) {
	if deps.State == nil || !deps.State.DriveUI() {
		return // read-only surface
	}
	liveTool[highlightArgs](s, deps.Bridge, "highlight_net", "Highlight a net on the live board.", "highlight_net", false)
	liveTool[emptyArgs](s, deps.Bridge, "clear_highlight", "Clear any net highlight on the live board.", "clear_highlight", false)
	liveTool[selectArgs](s, deps.Bridge, "select_part", "Select/focus a component by refdes on the live board.", "select_part", false)
	liveTool[sideArgs](s, deps.Bridge, "set_side", "Show the top or bottom side of the live board.", "set_side", false)
	liveTool[pdfGotoArgs](s, deps.Bridge, "pdf_goto", "Navigate the open PDF to a page (optionally to a search term).", "pdf_goto", false)
}
```

- [ ] **Step 2: Build + commit**

Run: `cd src/backend && go build ./... && go test ./mcpserver/`
Expected: PASS.
```bash
git add src/backend/mcpserver/tools_live.go
git commit -m "feat(mcp): drive-UI tools (gated by mcp_drive_ui)"
```

---

## PHASE E — Frontend bridge client

### Task 14: Add `log.mcp` scope

**Files:**
- Modify: `src/frontend/src/store/log-store.ts:4`, `:6`, `:99+`

- [ ] **Step 1: Add the scope**

Change line 4 (`LogScope` union) to include `'mcp'`:
```typescript
export type LogScope = 'parser' | 'render' | 'pdf' | 'scan' | 'ui' | 'cache' | 'perf' | 'update' | 'obd' | 'cloud' | 'twoWindow' | 'mcp';
```
Change line 6 (`LOG_SCOPES`) to append `'mcp'`:
```typescript
export const LOG_SCOPES: readonly LogScope[] = ['parser', 'render', 'pdf', 'scan', 'ui', 'cache', 'perf', 'update', 'obd', 'cloud', 'twoWindow', 'mcp'];
```
In the `log` export object (around line 99), add:
```typescript
  mcp: logStore.createScopedLogger('mcp'),
```

- [ ] **Step 2: Typecheck + commit**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: exit 0.
```bash
git add src/frontend/src/store/log-store.ts
git commit -m "feat(mcp): add log.mcp scope"
```

---

### Task 15: Bridge client + read op handlers

**Files:**
- Create: `src/frontend/src/store/mcp-bridge.ts`

- [ ] **Step 1: Implement the WS client with read ops**

`src/frontend/src/store/mcp-bridge.ts`:
```typescript
import { boardStore } from './board-store';
import { computeAdjacentNets } from '../parsers/types';
import { log } from './log-store';

type Frame = { id: number; op: string; params: any };
type Reply = { id: number; ok: boolean; result?: any; error?: string };

let socket: WebSocket | null = null;
let sessionId = '';
let started = false;

function boardDescriptor() {
  const b = boardStore.board;
  const tab = boardStore.activeTab;
  return {
    session: sessionId,
    name: tab?.fileName ?? null,
    format: (b as any)?.format ?? null,
    parts: b ? b.parts.length : 0,
    nets: b ? b.nets.size : 0,
  };
}

function send(obj: any) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj));
}

/** Start the bridge. Call once after the app mounts when MCP is enabled. */
export function startMcpBridge() {
  if (started) return;
  started = true;
  sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  connect();
  window.addEventListener('focus', () => send({ type: 'focus', session: sessionId }));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) send({ type: 'focus', session: sessionId });
  });
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/api/mcp/bridge`);
  socket.onopen = () => {
    log.mcp.log('bridge connected');
    send({ type: 'hello', session: sessionId, board: boardDescriptor() });
  };
  socket.onmessage = (ev) => {
    const frame = JSON.parse(ev.data) as Frame;
    handle(frame);
  };
  socket.onclose = () => {
    log.mcp.warn('bridge closed; reconnecting in 3s');
    setTimeout(connect, 3000);
  };
  socket.onerror = () => socket?.close();
}

/** Push a fresh board descriptor (call when the active board changes). */
export function notifyBoardChanged() {
  send({ type: 'board_changed', session: sessionId, board: boardDescriptor() });
}

async function handle(frame: Frame) {
  try {
    const result = await dispatch(frame.op, frame.params ?? {});
    send({ type: 'reply', session: sessionId, reply: { id: frame.id, ok: true, result } });
  } catch (e: any) {
    log.mcp.error(`op ${frame.op} failed`, e);
    send({ type: 'reply', session: sessionId, reply: { id: frame.id, ok: false, error: String(e?.message ?? e) } });
  }
}

function requireBoard() {
  const b = boardStore.board;
  if (!b) throw new Error('no board open');
  return b;
}

async function dispatch(op: string, p: any): Promise<any> {
  switch (op) {
    case 'board_active': {
      const b = requireBoard();
      return { ...boardDescriptor() };
    }
    case 'list_nets': {
      const b = requireBoard();
      const names = Array.from(b.nets.keys());
      const f = (p.filter ?? '').toLowerCase();
      const out = f ? names.filter((n) => n.toLowerCase().includes(f)) : names;
      return { nets: out.slice(0, 5000), total: out.length };
    }
    case 'list_parts': {
      const b = requireBoard();
      const f = (p.filter ?? '').toLowerCase();
      const out = b.parts
        .map((pt) => pt.name)
        .filter((n) => (f ? n.toLowerCase().includes(f) : true));
      return { parts: out.slice(0, 5000), total: out.length };
    }
    case 'net_info': {
      const b = requireBoard();
      const net = b.nets.get(p.net);
      if (!net) throw new Error(`net not found: ${p.net}`);
      const pins = net.pinIndices.map((pi) => ({
        part: b.parts[pi.partIndex]?.name,
        pin: b.parts[pi.partIndex]?.pins[pi.pinIndex]?.name ?? String(pi.pinIndex),
      }));
      const parts = Array.from(new Set(pins.map((x) => x.part).filter(Boolean)));
      return { net: p.net, pins, parts };
    }
    case 'net_neighbors': {
      const b = requireBoard();
      const depth = p.depth && p.depth > 0 ? p.depth : 1;
      const set = computeAdjacentNets(b, p.net, depth);
      return { net: p.net, depth, neighbors: Array.from(set) };
    }
    case 'pin_connectivity': {
      const b = requireBoard();
      const part = b.parts.find((pt) => pt.name.toLowerCase() === String(p.part).toLowerCase());
      if (!part) throw new Error(`part not found: ${p.part}`);
      const pin = part.pins.find((pn) => String(pn.name) === String(p.pin) || String(pn.number) === String(p.pin));
      if (!pin) throw new Error(`pin not found: ${p.pin}`);
      const net = pin.net;
      const connected = net
        ? (b.nets.get(net)?.pinIndices ?? []).map((pi) => ({
            part: b.parts[pi.partIndex]?.name,
            pin: b.parts[pi.partIndex]?.pins[pi.pinIndex]?.name ?? String(pi.pinIndex),
          }))
        : [];
      return { part: part.name, pin: p.pin, net, connected };
    }
    case 'part_info': {
      const b = requireBoard();
      const part = b.parts.find((pt) => pt.name.toLowerCase() === String(p.refdes).toLowerCase());
      if (!part) throw new Error(`part not found: ${p.refdes}`);
      return {
        refdes: part.name,
        side: part.side,
        value: (part.meta as any)?.value ?? null,
        package: (part.meta as any)?.package ?? null,
        pins: part.pins.map((pn) => ({ name: pn.name, number: pn.number, net: pn.net })),
      };
    }
    default:
      return dispatchDrive(op, p); // Task 16
  }
}
```

> **Discovery step (required):** confirm the exact `Part`/`Pin`/`Net` field names against `parsers/types.ts` (the explore report shows `part.name`, `part.side`, `part.meta.{value,package}`, `pin.name`, `pin.number`, `pin.net`, `net.pinIndices[].{partIndex,pinIndex}`). Fix any mismatch before running.

- [ ] **Step 2: Typecheck**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: exit 0 (will fail until Task 16 adds `dispatchDrive` — add a temporary `function dispatchDrive(op:string,p:any):any{throw new Error('unknown op '+op)}` at the bottom to compile, replaced in Task 16).

- [ ] **Step 3: Commit**

```bash
git add src/frontend/src/store/mcp-bridge.ts
git commit -m "feat(mcp): frontend bridge client + read op handlers"
```

---

### Task 16: Drive-UI op handlers + toasts + mount

**Files:**
- Modify: `src/frontend/src/store/mcp-bridge.ts`
- Modify: app bootstrap (e.g. `src/frontend/src/main.tsx` or the top-level App component)
- Modify: `src/frontend/src/store/board-store.ts` (call `notifyBoardChanged` on tab switch — optional, see note)

- [ ] **Step 1: Replace the temporary `dispatchDrive` with real handlers**

Append to `mcp-bridge.ts` (remove the temporary stub):
```typescript
import { pdfStore } from './pdf-store';

function toast(msg: string) {
  boardStore.addToast(msg, 'info');
  log.mcp.log(msg);
}

async function dispatchDrive(op: string, p: any): Promise<any> {
  switch (op) {
    case 'highlight_net': {
      requireBoard();
      boardStore.highlightNet(p.net);
      toast(`Agent highlighted net ${p.net}`);
      return { ok: true };
    }
    case 'clear_highlight': {
      boardStore.highlightNet(null);
      toast('Agent cleared highlight');
      return { ok: true };
    }
    case 'select_part': {
      requireBoard();
      boardStore.focusPart(p.refdes);
      toast(`Agent selected ${p.refdes}`);
      return { ok: true };
    }
    case 'set_side': {
      requireBoard();
      if (String(p.side).toLowerCase() === 'bottom') boardStore.selectBottom();
      else boardStore.selectTop();
      toast(`Agent set side: ${p.side}`);
      return { ok: true };
    }
    case 'pdf_goto': {
      if (p.term) pdfStore.searchText(String(p.term), 'lookup');
      if (typeof p.page === 'number' && p.page > 0) pdfStore.goToPage(p.page);
      toast(`Agent navigated PDF to page ${p.page}`);
      return { ok: true };
    }
    default:
      throw new Error(`unknown op: ${op}`);
  }
}
```

- [ ] **Step 2: Start the bridge from the app bootstrap when MCP is enabled**

In the app bootstrap (where other stores/effects start), add:
```typescript
import { startMcpBridge } from './store/mcp-bridge';

// Start the MCP bridge if the server is enabled (status from /api/mcp/status).
fetch('/api/mcp/status')
  .then((r) => (r.ok ? r.json() : null))
  .then((s) => {
    if (s && s.enabled) startMcpBridge();
  })
  .catch(() => {});
```

> **Note:** `/api/mcp/status` is added in Task 17. Until then this fetch 404s and the bridge stays off — acceptable. The status endpoint is unauthenticated and returns only `{enabled, drive_ui, clients}` (no secret).

- [ ] **Step 3: (Optional) notify on board change**

If a single place handles "active tab changed" in `board-store.ts`, call `notifyBoardChanged()` there. If not obvious, skip — `board_active` always reads live state on demand, so this only refreshes `board_sessions` descriptors.

- [ ] **Step 4: Typecheck + commit**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: exit 0.
```bash
git add src/frontend/src/store/mcp-bridge.ts src/frontend/src/main.tsx
git commit -m "feat(mcp): drive-UI op handlers + bridge auto-start"
```

---

## PHASE F — Settings ▸ Integrations tab + status endpoint

### Task 17: `/api/mcp/status` endpoint

**Files:**
- Create: `src/backend/mcpserver/status.go`
- Modify: `src/backend/main.go`

- [ ] **Step 1: Implement the status handler**

`src/backend/mcpserver/status.go`:
```go
package mcpserver

import (
	"encoding/json"
	"net/http"
)

// StatusHandler reports enable state for the SPA bootstrap and Settings UI.
// It never returns the secret. Unauthenticated (no sensitive data).
func StatusHandler(st *State, b *Bridge) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"enabled":  st.Enabled(),
			"drive_ui": st.DriveUI(),
			"clients":  len(b.Sessions()),
		})
	}
}

// TokenHandler returns the bearer token for display in Settings. Same-origin +
// CSRF protections apply (it is mounted behind the standard middleware). It is
// only meaningful to the local operator viewing their own Settings.
func TokenHandler(st *State, secret string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !st.Enabled() {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"token": secret})
	}
}
```

> **Security note:** `TokenHandler` exposes the bearer token to any same-origin caller. That matches the project's trust model (the SPA is trusted; the backend is on a trusted LAN). If you want it stricter, gate it behind the update-secret cookie. Recorded as an accepted trade-off in the spec's auth section.

- [ ] **Step 2: Mount in main.go**

```go
	mux.HandleFunc("GET /api/mcp/status", mcpserver.StatusHandler(mcpState, mcpBridge))
	mux.HandleFunc("GET /api/mcp/token", mcpserver.TokenHandler(mcpState, mcpSecret))
```

- [ ] **Step 3: Build + commit**

Run: `cd src/backend && go build ./...`
```bash
git add src/backend/mcpserver/status.go src/backend/main.go
git commit -m "feat(mcp): /api/mcp/status + /api/mcp/token endpoints"
```

---

### Task 18: Settings ▸ Integrations tab UI

**Files:**
- Modify: `src/frontend/src/panels/SettingsPanel.tsx`

- [ ] **Step 1: Register the tab**

Per the verified structure (lines 61–71): add `'integrations'` to `SettingsTabId`, to `TAB_ORDER` (after `'input'`), and to `TAB_LABELS` (`integrations: 'Integrations'`). Add a `SectionId` `'mcpConfig'` and map it in `SECTION_TO_TAB`: `mcpConfig: 'integrations'`.

- [ ] **Step 2: Render the tab content**

Find where the panel renders the active tab's sections (the conditional/switch on the current tab) and add an Integrations branch. Use existing settings form classes (grep `library-modal-` / existing toggle markup in this file — reuse, don't invent CSS):
```tsx
function IntegrationsSection() {
  const [status, setStatus] = React.useState<{enabled: boolean; drive_ui: boolean; clients: number} | null>(null);
  const [token, setToken] = React.useState<string>('');

  const refresh = React.useCallback(() => {
    fetch('/api/mcp/status').then((r) => r.json()).then(setStatus).catch(() => {});
  }, []);
  React.useEffect(() => { refresh(); }, [refresh]);
  React.useEffect(() => {
    if (status?.enabled) fetch('/api/mcp/token').then((r) => r.ok ? r.json() : {token: ''}).then((d) => setToken(d.token || '')).catch(() => {});
  }, [status?.enabled]);

  const setFlag = async (key: 'mcp_enabled' | 'mcp_drive_ui', on: boolean) => {
    await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value: on ? '1' : '' }),
    });
    refresh();
  };

  const cmd = `claude mcp add --transport http boardripper ${location.protocol}//${location.host}/api/mcp --header "Authorization: Bearer ${token || '<enable to reveal>'}"`;

  return (
    <div className="settings-section">
      <label>
        <input type="checkbox" checked={!!status?.enabled} onChange={(e) => setFlag('mcp_enabled', e.target.checked)} />
        Enable MCP server (lets external agents query this BoardRipper)
      </label>
      <label>
        <input type="checkbox" checked={!!status?.drive_ui} disabled={!status?.enabled} onChange={(e) => setFlag('mcp_drive_ui', e.target.checked)} />
        Allow agents to control the UI (highlight nets, select parts, navigate PDFs)
      </label>
      {status?.enabled && (
        <>
          <p>Connected pages: {status.clients}</p>
          <p>Add to Claude Code:</p>
          <pre style={{ whiteSpace: 'pre-wrap', userSelect: 'all' }}>{cmd}</pre>
        </>
      )}
    </div>
  );
}
```
Render `<IntegrationsSection />` in the Integrations tab branch. Ensure `import * as React` / `useState`/`useEffect` are available (match the file's existing import style).

> **Note:** Changing `mcp_enabled` requires the backend to register/unregister drive-UI tools, which happens at `New()` time. For v1, drive-UI tool visibility updates on next backend restart OR rebuild the server on flag change. Simplest correct v1: the `mcp_drive_ui` flag is also checked inside each drive tool at call time. **Implement that guard:** in `registerDriveTools`, always register the tools but have `liveTool` check `deps.State.DriveUI()` and return an error result when off. Replace the early-return in Task 13 with an always-register + per-call check. (Adjust `liveTool` to accept an optional `gate func() bool`.)

- [ ] **Step 3: Typecheck + commit**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: exit 0.
```bash
git add src/frontend/src/panels/SettingsPanel.tsx
git commit -m "feat(mcp): Settings > Integrations tab (enable, drive-UI, connect command)"
```

- [ ] **Step 4: Apply the drive-UI per-call gate fix in the backend**

Modify `liveTool` (Task 12) to accept a `gate func() bool` and, when non-nil and false, return an error result "drive-UI disabled". Register drive tools unconditionally in `registerDriveTools` passing `deps.State.DriveUI`. Read tools pass `nil`. Re-run `go test ./mcpserver/`.
```bash
git add src/backend/mcpserver/tools_live.go
git commit -m "fix(mcp): per-call drive-UI gate so the toggle takes effect without restart"
```

---

## PHASE G — End-to-end verification

### Task 19: Playwright E2E (read + drive-UI geometry)

**Files:**
- Create: `src/frontend/tests/mcp-bridge.spec.ts`

- [ ] **Step 1: Write the E2E test**

This test exercises the **bridge** directly from the page context (opening a WS as if it were the backend pushing ops is not possible from the browser; instead we assert the dispatch logic by invoking the exported handler path). The realistic E2E: load app, open a board, open a second WS client to `/api/mcp/bridge` from Node, push a `net_neighbors` op, assert the reply; push `highlight_net`, then assert the **store geometry** in the page.

`src/frontend/tests/mcp-bridge.spec.ts`:
```typescript
import { test, expect } from '@playwright/test';
import WebSocket from 'ws';

// Assumes the dev server + backend are up (see existing specs for baseURL).
test('mcp bridge: read net_neighbors and drive highlight', async ({ page }) => {
  await page.goto('/');
  // Enable MCP + drive-UI via the config API.
  await page.request.put('/api/config', { data: { key: 'mcp_enabled', value: '1' } });
  await page.request.put('/api/config', { data: { key: 'mcp_drive_ui', value: '1' } });

  // Open a demo/sample board through the normal UI flow used by other specs.
  // (Reuse the helper other specs use to load samples/820-02016.bvr.)
  await loadSampleBoard(page); // <-- use the project's existing test helper

  // The page's bridge connects with its own session. Connect a second control
  // socket that simulates the backend is not possible; instead drive via the
  // backend: call a tool over HTTP MCP is heavy. For v1 E2E, assert the page
  // answered hello by checking the status endpoint shows >=1 client.
  await expect.poll(async () => {
    const s = await (await page.request.get('/api/mcp/status')).json();
    return s.clients;
  }).toBeGreaterThanOrEqual(1);

  // Drive-UI: call highlight via the in-page bridge dispatch by simulating a
  // backend op is out of scope for browser-only Playwright. Instead, assert the
  // store action the tool would call produces the highlight geometry:
  await page.evaluate(() => {
    // @ts-ignore - exercise the same store path the tool uses
    (window as any).boardStore?.highlightNet?.('GND');
  });
  const highlighted = await page.evaluate(() => (window as any).boardStore?.selection?.highlightedNet);
  expect(highlighted).toBe('GND');
});
```

> **Reality note:** a browser-only Playwright test cannot make the *backend* push a bridge op to the page (that requires an MCP client driving `/api/mcp`). This spec therefore verifies (a) the bridge connects (status `clients>=1`) and (b) the store path the drive tools call mutates highlight state. The full backend→bridge→page round trip is covered by the Go `bridge_test.go` (correlation) + the in-memory MCP client smoke test. If you want a true end-to-end, add a Node script that speaks MCP to `/api/mcp` and asserts the page reacts — track as a follow-up.

> **Discovery step:** reuse the existing sample-loading helper from another spec in `src/frontend/tests/` for `loadSampleBoard`. Expose `boardStore` on `window` in dev if not already (check; several stores are already attached for debugging).

- [ ] **Step 2: Run the test**

Run: `cd src/frontend && npx playwright test tests/mcp-bridge.spec.ts`
Expected: PASS (headless Chromium; WebGL adapter warning is expected and harmless).

- [ ] **Step 3: Commit**

```bash
git add src/frontend/tests/mcp-bridge.spec.ts
git commit -m "test(mcp): bridge connect + highlight geometry E2E"
```

---

## Final verification & ship

- [ ] **Step 1: Full backend build + tests**

Run: `cd src/backend && go build ./... && go test ./...`
Expected: PASS.

- [ ] **Step 2: Frontend typecheck + build**

Run: `cd src/frontend && npx tsc --noEmit && npm run build`
Expected: exit 0.

- [ ] **Step 3: Manual smoke (real client)**

1. Start the stack (dev backend :1336, frontend :8082 — see `reference_local_dev`).
2. Settings ▸ Integrations → enable MCP + drive-UI; copy the `claude mcp add` command.
3. `claude mcp add --transport http boardripper http://localhost:1336/api/mcp --header "Authorization: Bearer <token>"`.
4. In Claude Code: `/mcp`, confirm `boardripper` tools list. Call `pdf_search`. Open a board in the browser, call `board_active`, then `highlight_net` and watch the toast + highlight appear.

- [ ] **Step 4: Ship**

Use the `release` skill (version bump + signed manifest + NAS deploy). This is a feature → minor bump per the versioning convention.

---

## Spec coverage map

| Spec section | Task(s) |
|--------------|---------|
| §4 Transport & auth | 1, 2, 4, 5 |
| §5 Backend-native tools | 6, 7, 8, 9 |
| §5 Live-board read tools | 12 |
| §5 Drive-UI tools | 13, 16, 18(step 4) |
| §6 Bridge protocol & active-tab | 10, 11, 15 |
| §7 Settings ▸ Integrations + safety toasts | 16, 17, 18 |
| §8 Frontend bridge client | 14, 15, 16 |
| §9 Error handling | 4, 10 (timeout/no-tab), 12 (error results) |
| §10 Testing | 5, 6, 10, 19 |
| §11 Packaging | 1, Final ship |

## Deferred (recorded, not in this plan)

- `pdf_page_text` tool and donor-scoping for `pdf_search` (needs extra interface methods) — follow-up.
- True backend→bridge→page Playwright round trip via a Node MCP client — follow-up.
- Server rebuild on `mcp_drive_ui` change is handled by a per-call gate instead of rebuild (Task 18 step 4).
- Sub-project B (in-browser copilot panel) — separate spec.
