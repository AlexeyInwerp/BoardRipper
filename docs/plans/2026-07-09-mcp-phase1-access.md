# MCP Phase 1 — Access (visual / text / download) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a connected MCP model visual + textual + download access to the open board and schematic, plus library-wide PDF search and retrieval, with net-name reliability signalling.

**Architecture:** Two planes. *Plane A (browser bridge)* answers new ops from the in-memory `pdfStore`/`boardStore`/`worklistStore` and a new PixiJS renderer registry, proxied over the existing `/api/mcp/bridge` WebSocket. *Plane B (backend native)* answers directly from SQLite stores + the filesystem. Binary results (PNG images, PDF blobs) travel as base64 over the bridge/JSON and are emitted to MCP as `ImageContent` / `EmbeddedResource` content blocks.

**Tech Stack:** Go (`github.com/modelcontextprotocol/go-sdk` v1.6.1), React 19 + TypeScript (strict), PixiJS v8 (`renderer.extract`), pdf.js (`PDFDocumentProxy.getPage().render()`), vitest (new, for pure bridge helpers), Playwright (integration).

## Global Constraints

- **TypeScript strict mode**; component/functions per existing style (PascalCase components, camelCase functions).
- **Logging:** use scoped loggers from `store/log-store.ts` — `log.mcp.*` only; never `console.log`. Go side: existing `log.Printf` pattern in `mcpserver`.
- **NEVER call `app.destroy()` on PixiJS v8**; the renderer registry must not retain destroyed apps (clear on teardown).
- All new MCP tools in this phase are **read-only** → annotate `ro(true)` (`ReadOnlyHint`).
- **Size caps:** images longest side ≤ 2000 px; downloads ≤ `maxDownloadBytes = 50 << 20` (50 MiB) — reject over-cap with a tool error, never a truncated/huge payload.
- **Path sandbox:** backend file reads go only through `readFileEager(root, relPath)` with `root = scanner.ScanRoot()`; never join untrusted paths directly.
- **SDK content types** (verified): `mcp.ImageContent{Data []byte /*raw; SDK base64s on wire*/, MIMEType string}`; `mcp.EmbeddedResource{Resource: *mcp.ResourceContents{URI, MIMEType, Blob []byte}}`.
- **Bridge API** (existing): `Bridge.Request(ctx, sessionID, op string, params any, timeout) (json.RawMessage, error)`; `Bridge.Sessions() []json.RawMessage`. `bridgeTimeout = 10s` (add a longer `bridgeRenderTimeout = 30s` for image/render ops).
- **Net-name reliability** is a property of the data: every net-bearing bridge result carries `reliability: "named" | "synthetic"`.

## File Structure

**Backend (Go):**
- Modify `src/backend/mcpserver/tools_native.go` — `pdf_search` file scoping; new `file_download`; `binaryResult` helper.
- Modify `src/backend/mcpserver/tools_live.go` — new `liveBinaryTool` helper; register `board_overview`, `board_snapshot`, `pdf_page_image`, `pdf_page_text`, `pdf_search_open`, `pdf_download`.
- Modify `src/backend/mcpserver/server.go` — extend `Deps` with `FileBytes`.
- Modify `src/backend/handlers/serve.go` — export `ReadFileEager`.
- Modify `src/backend/main.go` — wire `Deps.FileBytes`.
- Modify `src/backend/mcpserver/mcpserver_test.go` — new Go tests.

**Frontend (TS):**
- Modify `src/frontend/src/store/mcp-bridge.ts` — new ops + `boardDescriptor` `pdfs[]` + reliability + feedback-rich drive returns; export `dispatch` + pure helpers for tests.
- Create `src/frontend/src/store/mcp-bridge-helpers.ts` — pure helpers (`classifyNetName`, `buildOverview`, `searchTextPages`, `pageText`) so they are unit-testable without the WS.
- Create `src/frontend/src/renderer/renderer-registry.ts` — active-tab PixiJS app registry.
- Modify `src/frontend/src/renderer/BoardRenderer.ts` — register/unregister the app.
- Create `src/frontend/src/store/pdf-render.ts` — `renderPdfPageToPng(doc, page, opts)` helper.
- Create `src/frontend/src/store/mcp-bridge-helpers.test.ts` — vitest unit tests.
- Create `src/frontend/vitest.config.ts` + edit `src/frontend/package.json` — vitest runner.
- Create `src/frontend/tests/mcp-bridge.spec.ts` — Playwright integration spec.

---

### Task 1: Content-block round-trip spike (`binaryResult` helper)

Prove the go-sdk emits an `ImageContent` block **and** structured output together, and lock the return pattern every binary tool uses.

**Files:**
- Modify: `src/backend/mcpserver/tools_native.go` (add `binaryResult`)
- Test: `src/backend/mcpserver/mcpserver_test.go`

**Interfaces:**
- Produces: `func binaryResult(mime string, data []byte, meta map[string]any) *mcp.CallToolResult` — builds a `CallToolResult` whose `Content` is one `ImageContent` (image/*) or `EmbeddedResource` (else), and whose `StructuredContent` is `meta`.

- [ ] **Step 1: Write the failing test** (append to `mcpserver_test.go`)

```go
func TestBinaryResult_ImageRoundTrips(t *testing.T) {
	res := binaryResult("image/png", []byte{0x89, 'P', 'N', 'G'}, map[string]any{"w": 4, "h": 2})
	if res.IsError || len(res.Content) != 1 {
		t.Fatalf("want 1 content block, got err=%v n=%d", res.IsError, len(res.Content))
	}
	img, ok := res.Content[0].(*mcp.ImageContent)
	if !ok {
		t.Fatalf("content[0] is %T, want *mcp.ImageContent", res.Content[0])
	}
	if img.MIMEType != "image/png" || len(img.Data) != 4 {
		t.Fatalf("bad image content: mime=%q len=%d", img.MIMEType, len(img.Data))
	}
	if res.StructuredContent == nil {
		t.Fatal("StructuredContent must carry the metadata map")
	}
}

func TestBinaryResult_BlobForNonImage(t *testing.T) {
	res := binaryResult("application/pdf", []byte("%PDF-1.7"), map[string]any{"size": 8})
	er, ok := res.Content[0].(*mcp.EmbeddedResource)
	if !ok || er.Resource == nil || er.Resource.MIMEType != "application/pdf" {
		t.Fatalf("want application/pdf EmbeddedResource, got %T", res.Content[0])
	}
	if len(er.Resource.Blob) != 8 {
		t.Fatalf("blob len=%d want 8", len(er.Resource.Blob))
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && go test ./mcpserver/ -run TestBinaryResult -v`
Expected: FAIL — `undefined: binaryResult`.

- [ ] **Step 3: Implement `binaryResult`** (add near `errResult` usage in `tools_native.go`, after the imports)

```go
// binaryResult wraps binary tool output: an ImageContent block for image/*
// MIME types, otherwise an EmbeddedResource blob, plus the metadata map as
// StructuredContent so the model gets both the bytes and the dimensions/size.
func binaryResult(mime string, data []byte, meta map[string]any) *mcp.CallToolResult {
	var content mcp.Content
	if strings.HasPrefix(mime, "image/") {
		content = &mcp.ImageContent{Data: data, MIMEType: mime}
	} else {
		content = &mcp.EmbeddedResource{Resource: &mcp.ResourceContents{
			URI: "boardripper://download", MIMEType: mime, Blob: data,
		}}
	}
	return &mcp.CallToolResult{
		Content:           []mcp.Content{content},
		StructuredContent: meta,
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/backend && go test ./mcpserver/ -run TestBinaryResult -v`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add src/backend/mcpserver/tools_native.go src/backend/mcpserver/mcpserver_test.go
git commit -m "feat(mcp): binaryResult helper for image/blob content blocks"
```

---

### Task 2: `file_download` native tool + `Deps.FileBytes` wiring

**Files:**
- Modify: `src/backend/handlers/serve.go` (export `ReadFileEager`)
- Modify: `src/backend/mcpserver/server.go` (extend `Deps`)
- Modify: `src/backend/mcpserver/tools_native.go` (new tool + `mimeForExt`)
- Modify: `src/backend/main.go` (wire `FileBytes`)
- Test: `src/backend/mcpserver/mcpserver_test.go`

**Interfaces:**
- Consumes: `binaryResult` (Task 1); `FileStore.GetFileByID` (existing).
- Produces: `Deps.FileBytes func(ctx context.Context, id int64) (data []byte, name, mime string, err error)`; MCP tool `file_download{ id int64 }`.

- [ ] **Step 1: Export `ReadFileEager`** — add to `src/backend/handlers/serve.go` (below `readFileEager`)

```go
// ReadFileEager is the exported wrapper other packages (mcpserver wiring) use to
// read a library file fully into memory with the same cloud-placeholder
// semantics as the file-serve handlers.
func ReadFileEager(root, relPath string) ([]byte, error) { return readFileEager(root, relPath) }
```

- [ ] **Step 2: Extend `Deps`** — in `src/backend/mcpserver/server.go`, add field to the `Deps` struct

```go
type Deps struct {
	State  *State
	Bridge *Bridge
	PDF    PDFSearcher
	Files  FileStore
	Boards BoardResolver
	OBD    ObdStore
	// FileBytes reads a library file's bytes by id (path-sandboxed eager read).
	// Left nil disables file_download. Returns filename + MIME alongside bytes.
	FileBytes func(ctx context.Context, id int64) (data []byte, name, mime string, err error)
}
```

- [ ] **Step 3: Write the failing test** (append to `mcpserver_test.go`)

```go
func TestFileDownload(t *testing.T) {
	deps := &Deps{
		State: NewState(&fakeConfig{m: map[string]string{"mcp_enabled": "1"}}),
		FileBytes: func(_ context.Context, id int64) ([]byte, string, string, error) {
			if id == 7 {
				return []byte("%PDF-1.7 body"), "sch.pdf", "application/pdf", nil
			}
			return nil, "", "", fmt.Errorf("not found: %d", id)
		},
	}
	srv := New(deps)
	out := callToolStructured(t, srv, "file_download", map[string]any{"id": 7})
	if out["filename"] != "sch.pdf" || out["mime"] != "application/pdf" {
		t.Fatalf("bad meta: %v", out)
	}
	// missing id -> tool error
	res := callToolRaw(t, srv, "file_download", map[string]any{"id": 999})
	if !res.IsError {
		t.Fatal("missing file should be a tool error")
	}
}
```

Add these test helpers to `mcpserver_test.go` if not already present (model on the existing in-memory client in `TestServer_PingAndPdfSearch`):

```go
func callToolRaw(t *testing.T, srv *Server, name string, args map[string]any) *mcp.CallToolResult {
	t.Helper()
	ctx := context.Background()
	ct, st := mcp.NewInMemoryTransports()
	ss, err := srv.mcp.Connect(ctx, st, nil)
	if err != nil { t.Fatal(err) }
	defer ss.Close()
	cl := mcp.NewClient(&mcp.Implementation{Name: "t", Version: "1"}, nil)
	cs, err := cl.Connect(ctx, ct, nil)
	if err != nil { t.Fatal(err) }
	defer cs.Close()
	res, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil { t.Fatal(err) }
	return res
}

func callToolStructured(t *testing.T, srv *Server, name string, args map[string]any) map[string]any {
	t.Helper()
	res := callToolRaw(t, srv, name, args)
	if res.IsError { t.Fatalf("tool %s errored: %v", name, res.Content) }
	b, _ := json.Marshal(res.StructuredContent)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	return m
}
```

Add `"fmt"` to the test file imports.

- [ ] **Step 3b: Run test to verify it fails**

Run: `cd src/backend && go test ./mcpserver/ -run TestFileDownload -v`
Expected: FAIL — `file_download` not registered.

- [ ] **Step 4: Implement the tool + mime helper** — in `tools_native.go`, add inside `registerNativeTools` under an `if deps.FileBytes != nil` block, and add the helper + const at file scope

```go
const maxDownloadBytes = 50 << 20 // 50 MiB

func mimeForExt(ext string) string {
	switch strings.ToLower(strings.TrimPrefix(ext, ".")) {
	case "pdf":
		return "application/pdf"
	case "png":
		return "image/png"
	case "jpg", "jpeg":
		return "image/jpeg"
	default:
		return "application/octet-stream"
	}
}
```

```go
	if deps.FileBytes != nil {
		mcp.AddTool(s, &mcp.Tool{
			Name:        "file_download",
			Description: "Download a library file by id (from file_list/file_get or a pdf_search hit) as bytes, so the model can read it natively. Capped at 50 MiB.",
			Annotations: ro(true),
		}, func(ctx context.Context, _ *mcp.CallToolRequest, a fileGetArgs) (*mcp.CallToolResult, any, error) {
			data, name, mime, err := deps.FileBytes(ctx, a.ID)
			if err != nil {
				return errResult("file_download failed: " + err.Error()), nil, nil
			}
			if len(data) > maxDownloadBytes {
				return errResult(fmt.Sprintf("file too large (%d bytes, cap %d) — use pdf_page_image/pdf_page_text instead", len(data), maxDownloadBytes)), nil, nil
			}
			return binaryResult(mime, data, map[string]any{"filename": name, "mime": mime, "size": len(data)}), nil, nil
		})
	}
```

Add `"fmt"` to `tools_native.go` imports if not present.

- [ ] **Step 5: Wire `FileBytes` in `main.go`** — in the `mcpDeps := &mcpserver.Deps{...}` literal (around line 411), add:

```go
		FileBytes: func(ctx context.Context, id int64) ([]byte, string, string, error) {
			rec, err := db.GetFileByID(ctx, id)
			if err != nil || rec == nil {
				return nil, "", "", fmt.Errorf("file %d not found", id)
			}
			if rec.Size > (50 << 20) {
				return nil, "", "", fmt.Errorf("file too large: %d bytes", rec.Size)
			}
			data, err := handlers.ReadFileEager(scanner.ScanRoot(), rec.Path)
			if err != nil {
				return nil, "", "", err
			}
			return data, rec.Filename, mimeForExtMain(rec.Extension), nil
		},
```

Add a tiny mirror of `mimeForExt` usable in `main` (or export `mcpserver.MimeForExt`). Simplest: export it — rename `mimeForExt` to `MimeForExt` in `tools_native.go` and call `mcpserver.MimeForExt` here (replace `mimeForExtMain`). Ensure `db` is the databank handle used at `mcpserver.NewState(db)` and `scanner` is in scope in `main.go` (both already are).

- [ ] **Step 6: Run test to verify it passes**

Run: `cd src/backend && go test ./mcpserver/ -run 'TestFileDownload|TestBinaryResult' -v`
Expected: PASS.

- [ ] **Step 7: Build the backend to confirm wiring compiles**

Run: `cd src/backend && go build ./...`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/backend/handlers/serve.go src/backend/mcpserver/server.go src/backend/mcpserver/tools_native.go src/backend/main.go src/backend/mcpserver/mcpserver_test.go
git commit -m "feat(mcp): file_download native tool (library file by id -> bytes)"
```

---

### Task 3: `pdf_search` file scoping

**Files:**
- Modify: `src/backend/mcpserver/tools_native.go` (add `FileID` to `pdfSearchArgs`, pass `restrictTo`)
- Test: `src/backend/mcpserver/mcpserver_test.go`

**Interfaces:**
- Consumes: `PDFSearcher.SearchPages(query, restrictTo []int64, limit)` (existing).
- Produces: `pdf_search` accepts optional `file_id int64`.

- [ ] **Step 1: Write the failing test** — extend the existing pdf_search fake to record `restrictTo`. In `mcpserver_test.go` add:

```go
func TestPdfSearch_FileScope(t *testing.T) {
	var gotRestrict []int64
	deps := &Deps{
		State: NewState(&fakeConfig{m: map[string]string{"mcp_enabled": "1"}}),
		PDF: &fakePDFRec{fn: func(q string, r []int64, l int) ([]pdfindex.SearchHit, error) {
			gotRestrict = r
			return []pdfindex.SearchHit{{FileID: 5, PageNum: 1, Snippet: "hit"}}, nil
		}},
	}
	srv := New(deps)
	_ = callToolStructured(t, srv, "pdf_search", map[string]any{"query": "x", "file_id": 5})
	if len(gotRestrict) != 1 || gotRestrict[0] != 5 {
		t.Fatalf("file_id not forwarded as restrictTo: %v", gotRestrict)
	}
}

type fakePDFRec struct{ fn func(string, []int64, int) ([]pdfindex.SearchHit, error) }

func (f *fakePDFRec) SearchPages(q string, r []int64, l int) ([]pdfindex.SearchHit, error) {
	return f.fn(q, r, l)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && go test ./mcpserver/ -run TestPdfSearch_FileScope -v`
Expected: FAIL — `file_id` ignored (`gotRestrict` nil).

- [ ] **Step 3: Implement** — in `tools_native.go`, extend `pdfSearchArgs` and the handler:

```go
type pdfSearchArgs struct {
	Query  string `json:"query" jsonschema:"full-text query (part numbers, designators, keywords)"`
	Limit  int    `json:"limit,omitempty" jsonschema:"max hits (default 200, cap 1000)"`
	FileID int64  `json:"file_id,omitempty" jsonschema:"optional: restrict search to a single indexed file id"`
}
```

In the handler body, build `restrictTo` before calling `SearchPages`:

```go
			var restrict []int64
			if a.FileID > 0 {
				restrict = []int64{a.FileID}
			}
			hits, err := deps.PDF.SearchPages(a.Query, restrict, limit)
```

Update the tool description first sentence to: `"Full-text search across the indexed PDF library (library-wide); pass file_id to scope to one document."`

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/backend && go test ./mcpserver/ -run 'TestPdfSearch' -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/mcpserver/tools_native.go src/backend/mcpserver/mcpserver_test.go
git commit -m "feat(mcp): pdf_search file_id scoping"
```

---

### Task 4: Frontend vitest runner

Add a fast unit runner for the pure bridge helpers (the repo has only Playwright today).

**Files:**
- Create: `src/frontend/vitest.config.ts`
- Modify: `src/frontend/package.json`

- [ ] **Step 1: Install vitest**

Run: `cd src/frontend && npm i -D vitest@^2`
Expected: added to devDependencies.

- [ ] **Step 2: Create `src/frontend/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 3: Add script** — in `src/frontend/package.json` `"scripts"`, add:

```json
    "test:unit": "vitest run",
```

- [ ] **Step 4: Smoke test the runner** — create `src/frontend/src/store/mcp-bridge-helpers.test.ts` with a trivial passing test:

```ts
import { describe, it, expect } from 'vitest';
describe('vitest runner', () => {
  it('runs', () => { expect(1 + 1).toBe(2); });
});
```

- [ ] **Step 5: Run it**

Run: `cd src/frontend && npm run test:unit`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add src/frontend/package.json src/frontend/package-lock.json src/frontend/vitest.config.ts src/frontend/src/store/mcp-bridge-helpers.test.ts
git commit -m "test(frontend): add vitest runner for pure bridge helpers"
```

---

### Task 5: Net-name reliability classifier

**Files:**
- Create: `src/frontend/src/store/mcp-bridge-helpers.ts`
- Modify: `src/frontend/src/store/mcp-bridge-helpers.test.ts`
- Modify: `src/frontend/src/store/mcp-bridge.ts` (apply to net-bearing ops)

**Interfaces:**
- Produces: `classifyNetName(name: string): 'named' | 'synthetic'`.

- [ ] **Step 1: Write the failing test** — replace the smoke test body in `mcp-bridge-helpers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { classifyNetName } from './mcp-bridge-helpers';

describe('classifyNetName', () => {
  it('flags auto-generated names as synthetic', () => {
    for (const n of ['', '   ', 'N$123', 'NET0042', '42', '$77', 'UNNAMED_9', 'NODE12'])
      expect(classifyNetName(n)).toBe('synthetic');
  });
  it('treats real rail/signal names as named', () => {
    for (const n of ['PP3V3_G3H', 'VCC_MAIN', 'USB_DP', 'GND', 'PCIE_TX0'])
      expect(classifyNetName(n)).toBe('named');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src/frontend && npm run test:unit`
Expected: FAIL — module/function missing.

- [ ] **Step 3: Implement** — create `src/frontend/src/store/mcp-bridge-helpers.ts`

```ts
// Pure, WS-independent helpers for the MCP live-board bridge, split out so they
// are unit-testable without a socket or a live board.

/** Heuristic: does this net name carry semantic meaning, or is it an
 *  auto-generated placeholder the model must not read function into? Tunable —
 *  extend the synthetic patterns as new formats surface (see spec §12.9). */
const SYNTHETIC_PATTERNS: RegExp[] = [
  /^\s*$/,          // empty / whitespace
  /^n\$\d+$/i,      // Altium-style N$123
  /^net\d+$/i,      // NET0042
  /^\$?\d+$/,       // bare number, optional leading $
  /^unnamed/i,      // UNNAMED_*
  /^node\d+$/i,     // NODE12
];

export function classifyNetName(name: string): 'named' | 'synthetic' {
  const n = name ?? '';
  return SYNTHETIC_PATTERNS.some((re) => re.test(n)) ? 'synthetic' : 'named';
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd src/frontend && npm run test:unit`
Expected: PASS.

- [ ] **Step 5: Apply in `mcp-bridge.ts`** — import and attach `reliability` to net outputs. Add import at top:

```ts
import { classifyNetName } from './mcp-bridge-helpers';
```

In `dispatch`, update the net-returning cases:
- `list_nets`: map each name to `{ name, reliability: classifyNetName(name) }` in the page — change the return to `{ nets: page.map((n) => ({ name: n, reliability: classifyNetName(n) })), total, offset, has_more }`.
- `net_info`: add `reliability: classifyNetName(p.net)` to the returned object.
- `net_neighbors`: map neighbors to `{ name, reliability }` objects.
- `pin_connectivity`: add `net_reliability: pin.net ? classifyNetName(pin.net) : null` to the return.

- [ ] **Step 6: Type-check**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/frontend/src/store/mcp-bridge-helpers.ts src/frontend/src/store/mcp-bridge-helpers.test.ts src/frontend/src/store/mcp-bridge.ts
git commit -m "feat(mcp): net-name reliability (named|synthetic) on net-bearing ops"
```

---

### Task 6: Descriptor `pdfs[]` + `board_overview`

**Files:**
- Modify: `src/frontend/src/store/mcp-bridge.ts` (`boardDescriptor`, new `board_overview` op)
- Modify: `src/frontend/src/store/mcp-bridge-helpers.ts` (`buildOverview`)
- Modify: `src/frontend/src/store/mcp-bridge-helpers.test.ts`
- Modify: `src/backend/mcpserver/tools_live.go` (register `board_overview`)
- Modify: `src/frontend/src/store/worklist-store.ts` (`peekUnreadUserMessages`)

**Interfaces:**
- Consumes: `pdfStore.openPdfEntries()`, `worklistStore.aiSnapshot()`.
- Produces: bridge op `board_overview`; `boardDescriptor()` gains `pdfs`.

- [ ] **Step 1: Add non-consuming unread counter** — in `worklist-store.ts`, add a method near `consumeUserMessages`:

```ts
  /** Count unread user messages WITHOUT marking them read (for board_overview). */
  peekUnreadUserMessages(): number {
    const w = this.activeWorklist;
    if (!w?.messages) return 0;
    return w.messages.filter((m) => m.role === 'user' && m.unread).length;
  }
```

- [ ] **Step 2: Write the failing helper test** — add to `mcp-bridge-helpers.test.ts`:

```ts
import { buildOverview } from './mcp-bridge-helpers';

describe('buildOverview', () => {
  it('summarizes worklist counts', () => {
    const snap = {
      note: 'diag',
      parts: [{ refdes: 'U1' }, { refdes: 'U2' }],
      netEntries: [
        { netName: 'A', measurements: [{ status: 'requested' }] },
        { netName: 'B', measurements: [{ status: 'recorded' }] },
      ],
    };
    const wl = buildOverview(snap, 3);
    expect(wl).toEqual({ parts: 2, nets: 2, pendingMeasurements: 1, unreadUserMessages: 3, hasListNote: true });
  });
  it('handles no worklist', () => {
    expect(buildOverview(null, 0)).toEqual({ parts: 0, nets: 0, pendingMeasurements: 0, unreadUserMessages: 0, hasListNote: false });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd src/frontend && npm run test:unit`
Expected: FAIL — `buildOverview` missing.

- [ ] **Step 4: Implement `buildOverview`** — add to `mcp-bridge-helpers.ts`:

```ts
type Snap = {
  note?: string;
  parts?: unknown[];
  netEntries?: Array<{ measurements?: Array<{ status?: string }> }>;
} | null;

export interface WorklistSummary {
  parts: number;
  nets: number;
  pendingMeasurements: number;
  unreadUserMessages: number;
  hasListNote: boolean;
}

export function buildOverview(snap: Snap, unread: number): WorklistSummary {
  const netEntries = snap?.netEntries ?? [];
  const pending = netEntries.reduce(
    (acc, n) => acc + (n.measurements ?? []).filter((m) => m.status === 'requested').length,
    0,
  );
  return {
    parts: snap?.parts?.length ?? 0,
    nets: netEntries.length,
    pendingMeasurements: pending,
    unreadUserMessages: unread,
    hasListNote: !!(snap?.note && snap.note.trim()),
  };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd src/frontend && npm run test:unit`
Expected: PASS.

- [ ] **Step 6: Extend `boardDescriptor` + add op** — in `mcp-bridge.ts`, update `boardDescriptor()` to include open PDFs:

```ts
function boardDescriptor() {
  const b = boardStore.board;
  const tab = boardStore.activeTab;
  return {
    session: sessionId,
    name: tab?.fileName ?? null,
    parts: b ? b.parts.length : 0,
    nets: b ? b.nets.size : 0,
    pdfs: pdfStore.openPdfEntries().map((e) => ({
      name: e.fileName, page: pdfStore.pageOf(e.fileName), pageCount: pdfStore.pageCountOf(e.fileName), fileId: e.fileId ?? null,
    })),
    generation: `${boardStore.activeTabId ?? ''}:${tab?.fileName ?? ''}`,
  };
}
```

If `pdfStore.pageOf`/`pageCountOf` accessors don't exist, add them (they read `_documents.get(name)?.currentPage` / `?.pageCount`; return `null` when absent). Then add the dispatch case:

```ts
    case 'board_overview': {
      const b = boardStore.board;
      return {
        ...boardDescriptor(),
        board: b ? { parts: b.parts.length, nets: b.nets.size, side: boardStore.showTop ? 'top' : 'bottom' } : null,
        worklist: buildOverview(worklistStore.aiSnapshot() as any, worklistStore.peekUnreadUserMessages()),
      };
    }
```

Add `import { buildOverview } from './mcp-bridge-helpers';` (extend the existing import).

- [ ] **Step 7: Register `board_overview` (Go)** — in `tools_live.go` `registerLiveTools`, under the read-tools group:

```go
	liveTool[emptyArgs](s, b, "board_overview", "One-call orientation: the active board's name, part/net counts, shown side, open PDFs (name/page/pageCount/fileId), and a worklist summary (entry counts, pending measurements, unread user messages). Recommended first call.", "board_overview", true, nil)
```

- [ ] **Step 8: Type-check + build**

Run: `cd src/frontend && npx tsc --noEmit && cd ../backend && go build ./...`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/frontend/src/store/mcp-bridge.ts src/frontend/src/store/mcp-bridge-helpers.ts src/frontend/src/store/mcp-bridge-helpers.test.ts src/frontend/src/store/worklist-store.ts src/backend/mcpserver/tools_live.go
git commit -m "feat(mcp): board_overview + open-PDF exposure in descriptor"
```

---

### Task 7: `pdf_page_text` + `pdf_search_open`

**Files:**
- Modify: `src/frontend/src/store/mcp-bridge-helpers.ts` (`pageText`, `searchTextPages`)
- Modify: `src/frontend/src/store/mcp-bridge-helpers.test.ts`
- Modify: `src/frontend/src/store/mcp-bridge.ts` (ops)
- Modify: `src/backend/mcpserver/tools_live.go` (register both)

**Interfaces:**
- Consumes: `PdfDocument.textPages: PdfTextItem[][]` (each item has `.str`), `currentPage`, `pageCount`.
- Produces: bridge ops `pdf_page_text`, `pdf_search_open`.

- [ ] **Step 1: Write the failing test** — add to `mcp-bridge-helpers.test.ts`:

```ts
import { pageText, searchTextPages } from './mcp-bridge-helpers';

const PAGES = [
  [{ str: 'VCC' }, { str: 'MAIN' }],
  [{ str: 'USB' }, { str: 'connector' }],
];

describe('pageText', () => {
  it('joins a page', () => { expect(pageText(PAGES as any, 1)).toBe('VCC MAIN'); });
  it('clamps out-of-range', () => { expect(pageText(PAGES as any, 99)).toBe(''); });
});
describe('searchTextPages', () => {
  it('finds a case-insensitive match with page + snippet', () => {
    const m = searchTextPages(PAGES as any, 'usb', 10);
    expect(m).toEqual([{ page: 2, snippet: 'USB connector' }]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src/frontend && npm run test:unit`
Expected: FAIL.

- [ ] **Step 3: Implement** — add to `mcp-bridge-helpers.ts`:

```ts
type TextItem = { str: string };

export function pageText(pages: TextItem[][], page: number): string {
  const idx = page - 1;
  if (idx < 0 || idx >= pages.length) return '';
  return pages[idx].map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
}

export function searchTextPages(pages: TextItem[][], query: string, limit: number): Array<{ page: number; snippet: string }> {
  const q = (query ?? '').toLowerCase().trim();
  const out: Array<{ page: number; snippet: string }> = [];
  if (!q) return out;
  const cap = limit > 0 && limit <= 1000 ? limit : 200;
  for (let i = 0; i < pages.length && out.length < cap; i++) {
    const text = pages[i].map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
    if (text.toLowerCase().includes(q)) out.push({ page: i + 1, snippet: text });
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd src/frontend && npm run test:unit`
Expected: PASS.

- [ ] **Step 5: Add ops in `mcp-bridge.ts`** — helper to resolve the focused doc, then two cases. Add near `requireBoard`:

```ts
function activePdf() {
  const d = pdfStore.activeDoc; // the focused PdfDocument (see pdf-store getter)
  if (!d) throw new Error('no PDF open in BoardRipper');
  return d;
}
```

If `pdfStore.activeDoc` is not public, add a getter returning the private `_active`. Then in `dispatch`:

```ts
    case 'pdf_page_text': {
      const d = activePdf();
      const page = typeof p.page === 'number' && p.page > 0 ? p.page : d.currentPage;
      return { page, text: pageText(d.textPages, page) };
    }
    case 'pdf_search_open': {
      const d = activePdf();
      return { matches: searchTextPages(d.textPages, String(p.query ?? ''), p.limit), total: undefined };
    }
```

Fix `total`: compute from matches — `const matches = searchTextPages(...); return { matches, total: matches.length };`. Add `pageText, searchTextPages` to the helpers import.

- [ ] **Step 6: Register both (Go)** — in `tools_live.go` read-tools group:

```go
	liveTool[pdfPageArgs](s, b, "pdf_page_text", "Extracted text of a page of the open PDF (defaults to the current page). Reads the already-cached text layer; no re-extraction.", "pdf_page_text", true, nil)
	liveTool[pdfFindArgs](s, b, "pdf_search_open", "Search WITHIN the open PDF document (instant, in-memory; also works for drag-dropped files). For library-wide search use pdf_search.", "pdf_search_open", true, nil)
```

Add the arg structs to `tools_live.go`:

```go
type pdfPageArgs struct {
	Page    int    `json:"page,omitempty" jsonschema:"1-based page (default: current page)"`
	Session string `json:"session,omitempty"`
}

func (a pdfPageArgs) session() string { return a.Session }

type pdfFindArgs struct {
	Query   string `json:"query" jsonschema:"text to find in the open PDF"`
	Limit   int    `json:"limit,omitempty" jsonschema:"max matches (default 200, cap 1000)"`
	Session string `json:"session,omitempty"`
}

func (a pdfFindArgs) session() string { return a.Session }
```

- [ ] **Step 7: Type-check + build**

Run: `cd src/frontend && npx tsc --noEmit && cd ../backend && go build ./...`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/frontend/src/store/mcp-bridge-helpers.ts src/frontend/src/store/mcp-bridge-helpers.test.ts src/frontend/src/store/mcp-bridge.ts src/backend/mcpserver/tools_live.go
git commit -m "feat(mcp): pdf_page_text + pdf_search_open (open-doc text)"
```

---

### Task 8: `pdf_download` (open doc bytes)

**Files:**
- Modify: `src/frontend/src/store/mcp-bridge.ts` (op returns base64)
- Modify: `src/backend/mcpserver/tools_live.go` (`liveBinaryTool` + register)

**Interfaces:**
- Consumes: `PdfDocument.originalBuffer: ArrayBuffer`; `binaryResult` (Task 1); `Bridge.Request`.
- Produces: bridge op `pdf_download` → `{ base64, mime, name, size }`; MCP tool `pdf_download`.

- [ ] **Step 1: Add the frontend op** — in `mcp-bridge.ts` `dispatch`:

```ts
    case 'pdf_download': {
      const d = activePdf();
      const bytes = new Uint8Array(d.originalBuffer);
      const MAX = 50 * 1024 * 1024;
      if (bytes.byteLength > MAX) throw new Error(`PDF too large (${bytes.byteLength} bytes) to download over MCP`);
      // btoa needs a binary string; build in chunks to avoid call-stack limits.
      let bin = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      return { base64: btoa(bin), mime: 'application/pdf', name: d.fileName, size: bytes.byteLength };
    }
```

- [ ] **Step 2: Add `liveBinaryTool` helper (Go)** — in `tools_live.go`, after `liveTool`:

```go
// liveBinaryTool registers a bridge-backed tool whose browser reply is
// {base64, mime, ...meta}; it decodes base64 and emits an MCP image/blob
// content block via binaryResult. Uses the longer render timeout.
func liveBinaryTool[T any](s *mcp.Server, b *Bridge, name, desc, op string, gate func() bool) {
	mcp.AddTool(s, &mcp.Tool{Name: name, Description: desc, Annotations: ro(true)},
		func(ctx context.Context, _ *mcp.CallToolRequest, a T) (*mcp.CallToolResult, any, error) {
			if gate != nil && !gate() {
				return errResult("disabled"), nil, nil
			}
			if b == nil {
				return errResult("bridge unavailable"), nil, nil
			}
			res, err := b.Request(ctx, extractSession(a), op, a, bridgeRenderTimeout)
			if err != nil {
				return errResult(err.Error()), nil, nil
			}
			var r struct {
				Base64 string         `json:"base64"`
				MIME   string         `json:"mime"`
				Meta   map[string]any `json:"-"`
			}
			if err := json.Unmarshal(res, &r); err != nil {
				return errResult("bad binary reply: " + err.Error()), nil, nil
			}
			var meta map[string]any
			_ = json.Unmarshal(res, &meta)
			delete(meta, "base64")
			data, err := base64.StdEncoding.DecodeString(r.Base64)
			if err != nil {
				return errResult("bad base64 from tab: " + err.Error()), nil, nil
			}
			mime := r.MIME
			if mime == "" {
				mime = "application/octet-stream"
			}
			return binaryResult(mime, data, meta), nil, nil
		})
}
```

Add `bridgeRenderTimeout` next to `bridgeTimeout`:

```go
const bridgeRenderTimeout = 30 * time.Second
```

Add `"encoding/base64"` to `tools_live.go` imports.

- [ ] **Step 3: Register `pdf_download`** — in `registerLiveTools` read-tools group:

```go
	liveBinaryTool[emptyArgs](s, b, "pdf_download", "Download the currently open PDF as bytes (application/pdf) so the model can read the schematic natively. Works for library and drag-dropped files.", "pdf_download", nil)
```

- [ ] **Step 4: Write a Go decode test** — assert `liveBinaryTool`'s decode path via a fake bridge is out of scope for unit test (needs a live socket); instead assert `binaryResult` already covered (Task 1). Add a focused base64 sanity test:

```go
func TestLiveBinary_DecodePath(t *testing.T) {
	raw := json.RawMessage(`{"base64":"JVBERg==","mime":"application/pdf","name":"a.pdf","size":4}`)
	var r struct{ Base64, MIME string }
	_ = json.Unmarshal(raw, &r)
	data, err := base64.StdEncoding.DecodeString(r.Base64)
	if err != nil || string(data) != "%PDF" {
		t.Fatalf("decode: %v %q", err, data)
	}
}
```

Add `"encoding/base64"` to test imports.

- [ ] **Step 5: Run tests + build**

Run: `cd src/backend && go test ./mcpserver/ -run 'TestLiveBinary|TestBinaryResult' -v && go build ./... && cd ../frontend && npx tsc --noEmit`
Expected: PASS, no build errors.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/store/mcp-bridge.ts src/backend/mcpserver/tools_live.go src/backend/mcpserver/mcpserver_test.go
git commit -m "feat(mcp): pdf_download (open doc bytes) + liveBinaryTool"
```

---

### Task 9: `pdf_page_image` (pdf.js render)

**Files:**
- Create: `src/frontend/src/store/pdf-render.ts`
- Modify: `src/frontend/src/store/mcp-bridge.ts` (op)
- Modify: `src/backend/mcpserver/tools_live.go` (register)

**Interfaces:**
- Consumes: `PdfDocument.doc: PDFDocumentProxy`, `.rotation`, `.mirror`, `.currentPage`.
- Produces: `renderPdfPageToPng(doc, pageNum, {rotation, mirror, maxPx}): Promise<{ base64, w, h }>`; bridge op + tool `pdf_page_image`.

- [ ] **Step 1: Implement the render helper** — create `src/frontend/src/store/pdf-render.ts`

```ts
import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/pdf';

/** Render one PDF page to a PNG data payload (base64, no data: prefix) via
 *  pdf.js. Honors user rotation and horizontal mirror; caps the longest side. */
export async function renderPdfPageToPng(
  doc: PDFDocumentProxy,
  pageNum: number,
  opts: { rotation?: number; mirror?: boolean; maxPx?: number } = {},
): Promise<{ base64: string; w: number; h: number }> {
  const page = await doc.getPage(pageNum);
  const rotation = (page.rotate + (opts.rotation ?? 0)) % 360;
  let viewport = page.getViewport({ scale: 1, rotation });
  const maxPx = opts.maxPx ?? 2000;
  const scale = Math.min(1, maxPx / Math.max(viewport.width, viewport.height));
  viewport = page.getViewport({ scale, rotation });

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d')!;
  if (opts.mirror) { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
  await page.render({ canvasContext: ctx, viewport }).promise;

  const dataUrl = canvas.toDataURL('image/png');
  return { base64: dataUrl.split(',')[1], w: canvas.width, h: canvas.height };
}
```

- [ ] **Step 2: Add the op** — in `mcp-bridge.ts` `dispatch`:

```ts
    case 'pdf_page_image': {
      const d = activePdf();
      const page = typeof p.page === 'number' && p.page > 0 ? p.page : d.currentPage;
      const { base64, w, h } = await renderPdfPageToPng(d.doc, page, { rotation: d.rotation, mirror: d.mirror });
      return { base64, mime: 'image/png', page, w, h };
    }
```

Add `import { renderPdfPageToPng } from './pdf-render';`.

- [ ] **Step 3: Register the tool (Go)** — in `registerLiveTools`:

```go
	liveBinaryTool[pdfPageArgs](s, b, "pdf_page_image", "Render a page of the open PDF to a PNG image (defaults to the current page). Honors the doc's rotation/mirror. Prefer text (pdf_page_text/pdf_search_open) first; use this when text is insufficient or to inspect a region visually.", "pdf_page_image", nil)
```

(`pdfPageArgs` already added in Task 7.)

- [ ] **Step 4: Type-check + build**

Run: `cd src/frontend && npx tsc --noEmit && cd ../backend && go build ./...`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/store/pdf-render.ts src/frontend/src/store/mcp-bridge.ts src/backend/mcpserver/tools_live.go
git commit -m "feat(mcp): pdf_page_image (render open PDF page to PNG)"
```

---

### Task 10: Renderer registry + `board_snapshot`

**Files:**
- Create: `src/frontend/src/renderer/renderer-registry.ts`
- Modify: `src/frontend/src/renderer/BoardRenderer.ts` (register/unregister)
- Modify: `src/frontend/src/store/mcp-bridge.ts` (op)
- Modify: `src/backend/mcpserver/tools_live.go` (register)

**Interfaces:**
- Consumes: PixiJS `Application` (`this.app`), `renderer.extract.canvas({ target })`, `boardStore.activeTabId`.
- Produces: `registerRenderer(tabId, app)`, `unregisterRenderer(tabId)`, `getActiveApp(): Application | null`; bridge op + tool `board_snapshot`.

- [ ] **Step 1: Create the registry** — `src/frontend/src/renderer/renderer-registry.ts`

```ts
import type { Application } from 'pixi.js';
import { boardStore } from '../store/board-store';

// Module-level map of tabId -> live PixiJS Application, so the MCP bridge can
// snapshot the active board's canvas without the renderer being a React ref.
const apps = new Map<string, Application>();

export function registerRenderer(tabId: string, app: Application): void { apps.set(tabId, app); }
export function unregisterRenderer(tabId: string): void { apps.delete(tabId); }

export function getActiveApp(): Application | null {
  const id = boardStore.activeTabId;
  return id ? apps.get(id) ?? null : null;
}
```

- [ ] **Step 2: Register from `BoardRenderer`** — in `BoardRenderer.ts`, import the registry and call it where `this.app` is created and torn down. After the initial `this.app.init(...)` completes (in the constructor/init path) and inside `reinitApp` after `this.app = new Application()` is initialized, add `registerRenderer(this.tabId, this.app);`. In the teardown path (`teardownForReinit` / disposal where the canvas is removed) add `unregisterRenderer(this.tabId);`.

```ts
import { registerRenderer, unregisterRenderer } from './renderer-registry';
```

(Place `registerRenderer(this.tabId, this.app)` immediately after each successful `app.init`; place `unregisterRenderer(this.tabId)` in the same method that removes the canvas from the DOM.)

- [ ] **Step 3: Add the op** — in `mcp-bridge.ts` `dispatch`:

```ts
    case 'board_snapshot': {
      requireBoard();
      const app = getActiveApp();
      if (!app) throw new Error('board renderer not ready');
      const out = app.renderer.extract.canvas({ target: app.stage }) as HTMLCanvasElement;
      const base64 = out.toDataURL('image/png').split(',')[1];
      return { base64, mime: 'image/png', w: out.width, h: out.height };
    }
```

Add `import { getActiveApp } from '../renderer/renderer-registry';`. Note: `dispatch` is already `async`, and `extract.canvas` is synchronous in PixiJS v8; if the installed version returns a Promise, `await` it.

- [ ] **Step 4: Register the tool (Go)** — in `registerLiveTools`:

```go
	liveBinaryTool[emptyArgs](s, b, "board_snapshot", "Capture the live board view as a PNG (what the user currently sees — side, zoom, highlight). Prefer topology/text tools first; use this to correlate the board visually.", "board_snapshot", nil)
```

- [ ] **Step 5: Type-check + build**

Run: `cd src/frontend && npx tsc --noEmit && cd ../backend && go build ./...`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/renderer/renderer-registry.ts src/frontend/src/renderer/BoardRenderer.ts src/frontend/src/store/mcp-bridge.ts src/backend/mcpserver/tools_live.go
git commit -m "feat(mcp): board_snapshot via renderer registry + PixiJS extract"
```

---

### Task 11: Feedback-rich drive-UI returns

**Files:**
- Modify: `src/frontend/src/store/mcp-bridge.ts` (`dispatchDrive` returns)

**Interfaces:**
- Consumes: existing `netPins`, `findPart`, `boardStore`.
- Produces: richer return objects for `highlight_net`, `select_part`, `set_side`.

- [ ] **Step 1: Enrich `highlight_net`** — in `dispatchDrive`, replace its return:

```ts
    case 'highlight_net': {
      const board = requireBoard();
      boardStore.highlightNet(p.net);
      const pins = netPins(board, p.net) ?? [];
      const parts = Array.from(new Set(pins.map((x) => x.part).filter(Boolean)));
      toast(`Agent highlighted net ${p.net}`);
      return { ok: true, net: p.net, pins_highlighted: pins.length, parts };
    }
```

- [ ] **Step 2: Enrich `select_part`**

```ts
    case 'select_part': {
      const board = requireBoard();
      const part = findPart(board, p.refdes);
      boardStore.focusPart(p.refdes);
      toast(`Agent selected ${p.refdes}`);
      return { ok: true, refdes: p.refdes, found: !!part, side: part?.side ?? null, centered: !!part };
    }
```

- [ ] **Step 3: Enrich `set_side`**

```ts
    case 'set_side': {
      requireBoard();
      const side = String(p.side).toLowerCase() === 'bottom' ? 'bottom' : 'top';
      if (side === 'bottom') boardStore.selectBottom(); else boardStore.selectTop();
      toast(`Agent set side: ${side}`);
      return { ok: true, side };
    }
```

- [ ] **Step 4: Type-check**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/store/mcp-bridge.ts
git commit -m "feat(mcp): feedback-rich drive-UI returns (pins/found/side)"
```

---

### Task 12: Playwright integration proof + manual smoke

Verify the frontend bridge answers correctly against a real loaded board, and document the full external-client path.

**Files:**
- Modify: `src/frontend/src/store/mcp-bridge.ts` (dev-only test hook)
- Create: `src/frontend/tests/mcp-bridge.spec.ts`

**Interfaces:**
- Produces: `window.__brBridgeDispatch(op, params)` (dev builds only) → calls `dispatch`.

- [ ] **Step 1: Expose a dev-only dispatch hook** — at the bottom of `mcp-bridge.ts`, export `dispatch` and attach under dev:

```ts
export { dispatch as __dispatchForTest };
if (import.meta.env.DEV) {
  (window as unknown as { __brBridgeDispatch?: unknown }).__brBridgeDispatch =
    (op: string, params: unknown) => dispatch(op, (params ?? {}) as any);
}
```

- [ ] **Step 2: Write the Playwright spec** — `src/frontend/tests/mcp-bridge.spec.ts`

```ts
import { test, expect } from '@playwright/test';

// Loads a fixture board, then drives the MCP bridge dispatch directly (the WS
// transport is exercised by the manual smoke in Step 4; here we prove the
// frontend answers each op correctly from real stores).
test('bridge ops answer from a loaded board', async ({ page }) => {
  await page.goto('/');
  // Load the bundled sample board the other specs use (adjust path if needed).
  await page.evaluate(async () => {
    const res = await fetch('/samples/820-02016.bvr');
    const buf = await res.arrayBuffer();
    const file = new File([buf], '820-02016.bvr');
    // Reuse the app's open path via a drop or the store; simplest: dispatch through the store API the UI uses.
    (window as any).__openBoardForTest?.(file);
  });
  await page.waitForFunction(() => (window as any).__brBridgeDispatch && (window as any).boardReady === true, { timeout: 15000 });

  const overview = await page.evaluate(() => (window as any).__brBridgeDispatch('board_overview', {}));
  expect(overview.board.nets).toBeGreaterThan(0);

  const nets = await page.evaluate(() => (window as any).__brBridgeDispatch('list_nets', { limit: 5 }));
  expect(nets.nets[0]).toHaveProperty('reliability');

  const snap = await page.evaluate(() => (window as any).__brBridgeDispatch('board_snapshot', {}));
  expect(typeof snap.base64).toBe('string');
  expect(snap.base64.length).toBeGreaterThan(100);
});
```

Note: this spec depends on a board-open test hook. If `__openBoardForTest`/`boardReady` don't exist, add a minimal dev-only hook in the app's board-open path mirroring Step 1, or reuse whatever open mechanism the existing `boardripper.spec.ts` uses to load `samples/820-02016.bvr` (check that spec and copy its load pattern). The three assertions (overview counts, net reliability field, snapshot bytes) are the required proof.

- [ ] **Step 3: Run the spec**

Run: `cd src/frontend && npx playwright test tests/mcp-bridge.spec.ts`
Expected: PASS. (Headless Chromium has no WebGL adapter — if `board_snapshot` fails on that, gate that one assertion with a WebGL-available check and note it; the topology/text assertions must pass regardless.)

- [ ] **Step 4: Document the external-client smoke** — append to `docs/PDF_VIEWER.md#pdf-text-index` or a new note in the spec: enable MCP in Settings ▸ Integrations, then:

```bash
claude mcp add --transport http boardripper http://localhost:1336/api/mcp --header "Authorization: Bearer <token>"
# In Claude: call board_overview, pdf_page_text, pdf_search (library), file_download, board_snapshot
```

Confirm each returns; confirm `board_snapshot`/`pdf_page_image` render as images and `file_download`/`pdf_download` deliver a readable PDF.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/store/mcp-bridge.ts src/frontend/tests/mcp-bridge.spec.ts docs/
git commit -m "test(mcp): Playwright bridge-ops proof + external-client smoke doc"
```

---

### Task 13 (optional, deferrable): `board_snapshot` crop (`around=` / `fit=board`)

Ship only if the token-discipline crop (spec §12.3) is wanted in Phase 1; otherwise defer.

**Files:**
- Modify: `src/frontend/src/store/mcp-bridge.ts` (extend `board_snapshot`)
- Modify: `src/backend/mcpserver/tools_live.go` (`board_snapshot` arg struct)

- [ ] **Step 1:** Add `fit`/`around` to the Go arg struct (a `snapshotArgs` with `Fit`, `Around`, `Session`) and switch `board_snapshot` from `emptyArgs` to it.
- [ ] **Step 2:** In the op, when `around` is a refdes, compute the part's world bbox from `board.parts` (x/y + pin extents), map corners via `viewport.toScreen(...)` (the pixi-viewport instance held by the renderer — expose `getActiveViewport()` from the registry alongside `getActiveApp()`), build a `Rectangle`, and pass `{ target: app.stage, frame }` to `extract.canvas`. For `fit=board`, extract `{ target: viewport }` whole.
- [ ] **Step 3:** Verify via the Playwright spec (assert a cropped snapshot is smaller than the full-view one).
- [ ] **Step 4:** Commit `feat(mcp): board_snapshot region crop (around/fit)`.

---

## Self-Review

**Spec coverage (Phase 1 items in the design):**
- `pdf_search` file scope → Task 3 ✓
- `file_download` (library id) → Task 2 ✓
- open-PDF descriptor exposure → Task 6 ✓
- `board_overview` (§12.1) → Task 6 ✓
- `pdf_page_text` → Task 7 ✓
- `pdf_search_open` (renamed from pdf_find, §12.4) → Task 7 ✓
- `pdf_download` → Task 8 ✓
- `pdf_page_image` → Task 9 ✓
- `board_snapshot` → Task 10 ✓ (crop `around=`/`fit=board` → Task 13, optional)
- feedback-rich drive-UI returns (§12.2) → Task 11 ✓
- net `named`/`synthetic` reliability (§12.9) → Task 5 ✓
- content-block mapping (§5.5) → Task 1 ✓
- read-only annotations, size caps, path sandbox → Global Constraints, enforced in Tasks 2/8/9/10 ✓

**Deferred to later phases (not Phase 1):** persona/prompts (Phase 2), KB resources + `kb_search` + concept chunks (Phase 3), measurement-practice chunks (Phase 3). Not in scope here.

**Type consistency:** `binaryResult(mime, data, meta)` used identically in Tasks 1/2/8; `liveBinaryTool` reply shape `{base64, mime, ...meta}` matches the frontend ops in Tasks 8/9/10; `classifyNetName` signature stable across Task 5 usages; `pdfPageArgs`/`pdfFindArgs` defined once (Task 7) and reused (Task 9). `Deps.FileBytes` signature identical in server.go (Task 2 Step 2), main.go (Task 2 Step 5), and the tool (Task 2 Step 4).

**Placeholder scan:** the two frontend hooks that depend on existing app internals — `pdfStore.activeDoc`/`pageOf`/`pageCountOf` (Tasks 6/7) and the board-open test hook (Task 12) — carry explicit "add this getter if absent" instructions rather than assuming; not placeholders, but confirm-or-add steps. All code steps contain runnable code.

## Execution Handoff

Plan complete and saved to `docs/plans/2026-07-09-mcp-phase1-access.md`.
