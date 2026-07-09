# MCP Phase 3 — Knowledge Base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship an on-demand repair knowledge base — `go:embed` markdown chunks exposed as MCP **Resources** and searchable via a `kb_search` tool — and wire `kb_search` into the persona + prompts.

**Architecture:** A `kb/` directory of frontmatter+markdown chunks embedded into the Go binary. A loader parses them once into an in-memory slice. Each chunk is registered as an MCP Resource (`boardripper://kb/<id>`); a native `kb_search` tool does in-memory keyword scoring over the chunks. No new DB.

**Tech Stack:** Go `embed`, `github.com/modelcontextprotocol/go-sdk` v1.6.1 (`Server.AddResource`, `Resource`, `ResourceHandler`, `ReadResourceResult`, `ResourceContents`; `mcp.AddTool` for `kb_search`).

## Global Constraints

- Builds on Phase 2 (same branch). Content sourcing: the 3 measurement-practice chunks are **authoritative** (user-authored, verbatim — no draft marker); other chunks are **draft** (`status: draft` in frontmatter) for later expert review. Do not invent measurement thresholds beyond the authoritative chunks.
- KB chunk frontmatter is a fixed shape: `---` then `id:`, `title:`, `tags: [..]`, `applies_to: [..]`, `status:` lines, then `---`, then the markdown body. IDs are unique, kebab-case.
- Resource URIs are `boardripper://kb/<id>`, MIMEType `text/markdown`.
- `kb_search` is READ-ONLY (`ro(true)`); returns an object (SDK requires object output) `{hits:[{id,title,tags,snippet}], total}`.
- After this phase, add `kb_search` back into the persona's tool sentence and the `understand_circuit`/`diagnose` prompts (Phase 2 intentionally omitted it).
- Style/logging: match existing `mcpserver` Go conventions.

## File Structure

- Create `src/backend/mcpserver/kb/*.md` — the embedded chunk files (6 to start).
- Create `src/backend/mcpserver/kb.go` — `//go:embed kb/*.md`, `kbChunk` type, `loadKB() []kbChunk`, `parseChunk`, and `searchKB(chunks, query, tags, k)`.
- Modify `src/backend/mcpserver/server.go` — load KB in `New()`; register resources; store chunks for the tool. Add `kb_search` registration (or in `tools_native.go`).
- Modify `src/backend/mcpserver/tools_native.go` — `kb_search` tool.
- Modify `src/backend/mcpserver/server.go` — persona: add `kb_search` to the tools sentence.
- Modify `src/backend/mcpserver/prompts.go` — reference `kb_search` in `understand_circuit`/`diagnose`.
- Test: `src/backend/mcpserver/kb_test.go` + additions to `mcpserver_test.go`.

---

### Task 1: KB content + embed + loader

**Files:**
- Create: `src/backend/mcpserver/kb/measurement-request-hygiene.md`, `diode-mode-usage.md`, `measurement-safety.md`, `short-to-ground-localize.md`, `power-rail-basics.md`, `diode-mode-why.md`
- Create: `src/backend/mcpserver/kb.go`
- Test: `src/backend/mcpserver/kb_test.go`

**Interfaces:**
- Produces: `type kbChunk struct { ID, Title string; Tags, AppliesTo []string; Status, Body string }`; `func loadKB() ([]kbChunk, error)`; `func searchKB(chunks []kbChunk, query string, tags []string, k int) []kbChunk`.

- [ ] **Step 1: Create the 3 authoritative measurement chunks** (verbatim — these are user-authored)

`kb/measurement-request-hygiene.md`:
```markdown
---
id: measurement-request-hygiene
title: Requesting measurements economically
tags: [measurement, method, efficiency]
applies_to: [any]
status: authoritative
---
- Treat nets bridged by a populated 0Ω resistor or a closed jumper as ONE
  electrical node. Don't request (or ask the user to probe) the same node twice.
- Before collapsing two nets into one node, confirm the bridging link is actually
  populated. A 0Ω resistor / jumper pad left unpopulated (DNP / open) does NOT
  connect the nets — if the link may be open, have the user verify it is bridged
  on this board before treating the nets as one.
- Detecting a bridge: net_neighbors surfaces nets reachable through 2-pin parts;
  part_info on the bridging part gives its value. Only a 0Ω-class link (0 / 0R /
  jumper) collapses the node; a real resistor does not.
```

`kb/diode-mode-usage.md`:
```markdown
---
id: diode-mode-usage
title: When diode mode helps and when it misleads
tags: [measurement, diode, method]
applies_to: [any]
status: authoritative
---
- Diode mode is very useful on DATA lines (USB, PCIe, DP/LVDS, I2C, …): it
  reveals shorts, leakage, and blown ESD/protection diodes, with readings that
  compare meaningfully pin-to-pin.
- Do NOT rely on diode mode for major power rails or CPU/GPU phase (VCORE) nodes.
  Those readings are low and vary a lot with the meter's diode-test voltage, so
  they are neither diagnostic nor comparable between meters.
- For power rails: measure VOLTAGE (board powered) or RESISTANCE-to-ground (board
  unpowered) instead.
```

`kb/measurement-safety.md`:
```markdown
---
id: measurement-safety
title: Safe and valid measurement practice
tags: [measurement, safety, method]
applies_to: [any]
status: authoritative
---
- Resistance and diode measurements require the board UNPOWERED. Never measure
  ohms or diode on a powered-up board.
- Continuity (beep) mode is for continuity ONLY — connected vs open. Never infer
  a resistance value or a rail's health from the beep.
- If a reading is abnormal (outside the expected range), double-check before
  acting: re-seat probes, confirm range/mode, re-probe. Bad contact and wrong
  mode cause more false readings than real faults.
```

- [ ] **Step 2: Create 3 DRAFT starter chunks** (marked `status: draft` — for later expert review)

`kb/short-to-ground-localize.md`:
```markdown
---
id: short-to-ground-localize
title: Localizing a short to ground on a power rail
tags: [short, power, method]
applies_to: [any]
status: draft
---
1. Confirm the short: with the board unpowered, resistance/diode from the rail to
   GND reads very low (near 0 Ω / a few ohms). Compare against a known-good sister
   board where possible.
2. Narrow the domain: use net_neighbors and the schematic to list every component
   on the rail. The short is one of the parts tied to it (often a decoupling cap,
   a load IC, or the regulator).
3. Inject-and-find: apply a low, current-limited voltage into the rail; the
   shorted part heats first — locate it with a thermal camera or freeze-spray +
   isopropyl (the wet spot over the short dries first).
4. On a multi-cap rail, lift/remove suspect caps one at a time and re-measure
   after each; the short clearing identifies the culprit.
```

`kb/power-rail-basics.md`:
```markdown
---
id: power-rail-basics
title: Power rails and where they come from
tags: [concept, power, teaching]
applies_to: [any]
status: draft
---
A power rail is a net that distributes one supply voltage to many parts. Rails are
produced by regulators: a **buck converter** steps a higher voltage down
efficiently by switching (look for an inductor + switching IC), while an **LDO**
drops voltage linearly (simpler, wastes the difference as heat, no inductor).
Rails usually sequence — some must come up before others — under the control of a
PMIC or power-management logic. Decoupling capacitors sit across a rail to steady
it; a shorted decoupling cap is a common cause of a dead rail. When tracing a
fault, identify which rail feeds the misbehaving part and whether that rail is
present and at the right voltage before suspecting the part itself.
```

`kb/diode-mode-why.md`:
```markdown
---
id: diode-mode-why
title: Why diode mode works (and what the number means)
tags: [concept, diode, measurement, teaching]
applies_to: [any]
status: draft
---
Diode mode pushes a small test current through the probes and shows the resulting
voltage drop. Across a healthy silicon junction that's roughly 0.4–0.7 V; a dead
short reads near 0; an open reads OL (over-limit). On a data line to ground you're
reading the drop across the ESD/protection diodes at the pin — a consistent,
comparable number pin-to-pin, so an outlier flags a blown protection diode or a
short. On a heavy power rail the reading is dominated by many parallel low-value
paths, so it's low and swings with the meter's test voltage — which is why diode
mode is diagnostic on data lines but not on rails.
```

- [ ] **Step 3: Write the failing test** (`kb_test.go`)

```go
package mcpserver

import "testing"

func TestLoadKB(t *testing.T) {
	chunks, err := loadKB()
	if err != nil {
		t.Fatalf("loadKB: %v", err)
	}
	if len(chunks) < 6 {
		t.Fatalf("want >=6 chunks, got %d", len(chunks))
	}
	byID := map[string]kbChunk{}
	for _, c := range chunks {
		if c.ID == "" || c.Title == "" || c.Body == "" {
			t.Fatalf("chunk missing id/title/body: %+v", c)
		}
		byID[c.ID] = c
	}
	m, ok := byID["diode-mode-usage"]
	if !ok {
		t.Fatal("missing diode-mode-usage chunk")
	}
	if m.Status != "authoritative" {
		t.Fatalf("diode-mode-usage status = %q, want authoritative", m.Status)
	}
	wantTag := false
	for _, tg := range m.Tags {
		if tg == "diode" {
			wantTag = true
		}
	}
	if !wantTag {
		t.Fatalf("diode-mode-usage tags missing 'diode': %v", m.Tags)
	}
}

func TestSearchKB(t *testing.T) {
	chunks, _ := loadKB()
	hits := searchKB(chunks, "diode mode on a power rail", nil, 3)
	if len(hits) == 0 {
		t.Fatal("no hits")
	}
	// the diode-mode guidance should rank at the top for this query.
	if hits[0].ID != "diode-mode-usage" && hits[0].ID != "diode-mode-why" {
		t.Fatalf("top hit = %q, want a diode-mode chunk", hits[0].ID)
	}
	// tag filter narrows results.
	safety := searchKB(chunks, "measurement", []string{"safety"}, 5)
	for _, h := range safety {
		found := false
		for _, tg := range h.Tags {
			if tg == "safety" {
				found = true
			}
		}
		if !found {
			t.Fatalf("tag filter leaked non-safety chunk %q", h.ID)
		}
	}
}
```

- [ ] **Step 4: Run to verify it fails**

Run: `cd src/backend && go test ./mcpserver/ -run 'TestLoadKB|TestSearchKB' -v`
Expected: FAIL — `loadKB`/`searchKB`/`kbChunk` undefined.

- [ ] **Step 5: Implement `kb.go`**

```go
package mcpserver

import (
	"embed"
	"fmt"
	"sort"
	"strings"
)

//go:embed kb/*.md
var kbFS embed.FS

type kbChunk struct {
	ID        string   `json:"id"`
	Title     string   `json:"title"`
	Tags      []string `json:"tags"`
	AppliesTo []string `json:"applies_to"`
	Status    string   `json:"status"`
	Body      string   `json:"body"`
}

// loadKB parses every embedded kb/*.md chunk once.
func loadKB() ([]kbChunk, error) {
	entries, err := kbFS.ReadDir("kb")
	if err != nil {
		return nil, err
	}
	var out []kbChunk
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		raw, err := kbFS.ReadFile("kb/" + e.Name())
		if err != nil {
			return nil, err
		}
		c, err := parseChunk(string(raw))
		if err != nil {
			return nil, fmt.Errorf("%s: %w", e.Name(), err)
		}
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// parseChunk splits leading ---frontmatter--- from the markdown body.
func parseChunk(raw string) (kbChunk, error) {
	s := strings.TrimLeft(raw, "﻿ \t\r\n")
	if !strings.HasPrefix(s, "---") {
		return kbChunk{}, fmt.Errorf("no frontmatter")
	}
	rest := s[3:]
	end := strings.Index(rest, "\n---")
	if end < 0 {
		return kbChunk{}, fmt.Errorf("unterminated frontmatter")
	}
	front := rest[:end]
	body := strings.TrimLeft(rest[end+4:], "\r\n")
	c := kbChunk{Body: strings.TrimSpace(body)}
	for _, line := range strings.Split(front, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		k = strings.TrimSpace(k)
		v = strings.TrimSpace(v)
		switch k {
		case "id":
			c.ID = v
		case "title":
			c.Title = v
		case "status":
			c.Status = v
		case "tags":
			c.Tags = parseList(v)
		case "applies_to":
			c.AppliesTo = parseList(v)
		}
	}
	if c.ID == "" || c.Title == "" {
		return kbChunk{}, fmt.Errorf("missing id or title")
	}
	return c, nil
}

func parseList(v string) []string {
	v = strings.TrimSpace(v)
	v = strings.TrimPrefix(v, "[")
	v = strings.TrimSuffix(v, "]")
	var out []string
	for _, p := range strings.Split(v, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// searchKB scores chunks by query-term hits (title×3, tags×2, body×1),
// optionally filtered to chunks carrying ALL given tags, and returns the top k.
func searchKB(chunks []kbChunk, query string, tags []string, k int) []kbChunk {
	if k <= 0 || k > 50 {
		k = 5
	}
	terms := strings.Fields(strings.ToLower(query))
	type scored struct {
		c     kbChunk
		score int
	}
	var ranked []scored
	for _, c := range chunks {
		if !hasAllTags(c, tags) {
			continue
		}
		title := strings.ToLower(c.Title)
		tagStr := strings.ToLower(strings.Join(c.Tags, " "))
		body := strings.ToLower(c.Body)
		score := 0
		for _, t := range terms {
			score += 3 * strings.Count(title, t)
			score += 2 * strings.Count(tagStr, t)
			score += strings.Count(body, t)
		}
		if score > 0 || len(terms) == 0 {
			ranked = append(ranked, scored{c, score})
		}
	}
	sort.SliceStable(ranked, func(i, j int) bool {
		if ranked[i].score != ranked[j].score {
			return ranked[i].score > ranked[j].score
		}
		return ranked[i].c.ID < ranked[j].c.ID
	})
	out := make([]kbChunk, 0, k)
	for i := 0; i < len(ranked) && i < k; i++ {
		out = append(out, ranked[i].c)
	}
	return out
}

func hasAllTags(c kbChunk, tags []string) bool {
	for _, want := range tags {
		want = strings.ToLower(strings.TrimSpace(want))
		if want == "" {
			continue
		}
		found := false
		for _, have := range c.Tags {
			if strings.ToLower(have) == want {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd src/backend && go test ./mcpserver/ -run 'TestLoadKB|TestSearchKB' -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/backend/mcpserver/kb/ src/backend/mcpserver/kb.go src/backend/mcpserver/kb_test.go
git commit -m "feat(mcp): knowledge-base chunks + go:embed loader + searchKB"
```

---

### Task 2: Expose KB chunks as MCP Resources

**Files:**
- Modify: `src/backend/mcpserver/server.go` (load KB in `New()`, register resources, keep chunks on `Server`)
- Test: `src/backend/mcpserver/mcpserver_test.go`

**Interfaces:**
- Consumes: `loadKB()`; `Server.AddResource`, `ResourceHandler`, `ReadResourceResult`, `ResourceContents`.
- Produces: `Server.kb []kbChunk`; one resource per chunk at `boardripper://kb/<id>`.

- [ ] **Step 1: Write the failing test** (append to `mcpserver_test.go`)

```go
func TestKBResources(t *testing.T) {
	deps := &Deps{State: NewState(&fakeConfig{m: map[string]string{"mcp_enabled": "1"}})}
	srv := New(deps)
	ctx := context.Background()
	ct, st := mcp.NewInMemoryTransports()
	ss, err := srv.mcp.Connect(ctx, st, nil)
	if err != nil { t.Fatal(err) }
	defer ss.Close()
	cl := mcp.NewClient(&mcp.Implementation{Name: "t", Version: "1"}, nil)
	cs, err := cl.Connect(ctx, ct, nil)
	if err != nil { t.Fatal(err) }
	defer cs.Close()

	lr, err := cs.ListResources(ctx, nil)
	if err != nil { t.Fatal(err) }
	var uri string
	for _, r := range lr.Resources {
		if r.URI == "boardripper://kb/diode-mode-usage" { uri = r.URI }
	}
	if uri == "" { t.Fatal("kb resource diode-mode-usage not listed") }

	rr, err := cs.ReadResource(ctx, &mcp.ReadResourceParams{URI: uri})
	if err != nil { t.Fatal(err) }
	if len(rr.Contents) == 0 || rr.Contents[0].MIMEType != "text/markdown" {
		t.Fatalf("bad resource contents: %+v", rr.Contents)
	}
	if !strings.Contains(rr.Contents[0].Text, "data line") {
		t.Fatalf("resource body not returned: %s", rr.Contents[0].Text)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src/backend && go test ./mcpserver/ -run TestKBResources -v`
Expected: FAIL — resource not listed.

- [ ] **Step 3: Implement** — in `server.go`: add `kb []kbChunk` to the `Server` struct; in `New()`, after building tools and before `registerPrompts`, load + register:

```go
	if chunks, err := loadKB(); err == nil {
		s.kb = chunks
		registerKBResources(s.mcp, chunks)
	}
```

Add `registerKBResources` (in `kb.go` or `server.go`):

```go
func registerKBResources(s *mcp.Server, chunks []kbChunk) {
	for _, c := range chunks {
		c := c // capture
		s.AddResource(&mcp.Resource{
			URI:         "boardripper://kb/" + c.ID,
			Name:        c.Title,
			Description: "Repair knowledge: " + c.Title,
			MIMEType:    "text/markdown",
		}, func(_ context.Context, req *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
			return &mcp.ReadResourceResult{
				Contents: []*mcp.ResourceContents{
					{URI: req.Params.URI, MIMEType: "text/markdown", Text: c.Body},
				},
			}, nil
		})
	}
}
```

Add `"context"` import to whichever file hosts this if not present. (Confirm `mcp.Resource` has a `URI` field — it does in v1.6.1.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd src/backend && go test ./mcpserver/ -run TestKBResources -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/mcpserver/server.go src/backend/mcpserver/kb.go src/backend/mcpserver/mcpserver_test.go
git commit -m "feat(mcp): expose KB chunks as MCP resources"
```

---

### Task 3: `kb_search` tool

**Files:**
- Modify: `src/backend/mcpserver/tools_native.go` (register `kb_search`)
- Modify: `src/backend/mcpserver/server.go` (pass `s.kb` into native tools) OR register in `New()` where `s.kb` is in scope
- Test: `src/backend/mcpserver/mcpserver_test.go`

**Interfaces:**
- Consumes: `searchKB`; `s.kb`.
- Produces: tool `kb_search{query string, tags []string, k int}` → `{hits:[{id,title,tags,snippet}], total}`.

- [ ] **Step 1: Write the failing test** (append to `mcpserver_test.go`)

```go
func TestKBSearchTool(t *testing.T) {
	deps := &Deps{State: NewState(&fakeConfig{m: map[string]string{"mcp_enabled": "1"}})}
	srv := New(deps)
	out := callToolStructured(t, srv, "kb_search", map[string]any{"query": "continuity mode beep", "k": 3})
	hits, ok := out["hits"].([]any)
	if !ok || len(hits) == 0 {
		t.Fatalf("no hits: %v", out)
	}
	first := hits[0].(map[string]any)
	if first["id"] != "measurement-safety" {
		t.Fatalf("top hit = %v, want measurement-safety", first["id"])
	}
	if _, ok := first["snippet"].(string); !ok {
		t.Fatalf("hit missing snippet: %v", first)
	}
}
```

(`callToolStructured` already exists from Phase 1.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd src/backend && go test ./mcpserver/ -run TestKBSearchTool -v`
Expected: FAIL — unknown tool `kb_search`.

- [ ] **Step 3: Implement** — register `kb_search` where `s.kb` is in scope. Simplest: in `New()` after `s.kb` is set, call a helper `registerKBSearch(s.mcp, s.kb)` defined in `tools_native.go`:

```go
type kbSearchArgs struct {
	Query string   `json:"query" jsonschema:"what to look up (technique, symptom, concept)"`
	Tags  []string `json:"tags,omitempty" jsonschema:"optional: only chunks carrying ALL these tags"`
	K     int      `json:"k,omitempty" jsonschema:"max chunks to return (default 5, cap 50)"`
}
type kbHit struct {
	ID      string   `json:"id"`
	Title   string   `json:"title"`
	Tags    []string `json:"tags"`
	Snippet string   `json:"snippet"`
}
type kbSearchResult struct {
	Hits  []kbHit `json:"hits"`
	Total int     `json:"total"`
}

func registerKBSearch(s *mcp.Server, chunks []kbChunk) {
	if len(chunks) == 0 {
		return
	}
	mcp.AddTool(s, &mcp.Tool{
		Name:        "kb_search",
		Description: "Search the repair knowledge base for relevant technique/concept chunks. Returns top matches (id, title, tags, snippet); read the full chunk via the boardripper://kb/<id> resource.",
		Annotations: ro(true),
	}, func(_ context.Context, _ *mcp.CallToolRequest, a kbSearchArgs) (*mcp.CallToolResult, kbSearchResult, error) {
		found := searchKB(chunks, a.Query, a.Tags, a.K)
		hits := make([]kbHit, 0, len(found))
		for _, c := range found {
			snippet := c.Body
			if len(snippet) > 300 {
				snippet = snippet[:300] + "…"
			}
			hits = append(hits, kbHit{ID: c.ID, Title: c.Title, Tags: c.Tags, Snippet: snippet})
		}
		return nil, kbSearchResult{Hits: hits, Total: len(hits)}, nil
	})
}
```

Call `registerKBSearch(s.mcp, s.kb)` in `New()` right after `registerKBResources(...)`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd src/backend && go test ./mcpserver/ -run TestKBSearchTool -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/mcpserver/tools_native.go src/backend/mcpserver/server.go src/backend/mcpserver/mcpserver_test.go
git commit -m "feat(mcp): kb_search tool over the embedded knowledge base"
```

---

### Task 4: Wire `kb_search` into persona + prompts

**Files:**
- Modify: `src/backend/mcpserver/server.go` (persona)
- Modify: `src/backend/mcpserver/prompts.go` (prompt bodies)
- Test: `src/backend/mcpserver/mcpserver_test.go`

**Interfaces:** none new — text edits + a test.

- [ ] **Step 1: Write the failing test** (append to `mcpserver_test.go`)

```go
func TestKBReferencedInPersonaAndPrompts(t *testing.T) {
	if !strings.Contains(technicianPersona, "kb_search") {
		t.Fatal("persona should reference kb_search now that Phase 3 landed")
	}
	if !strings.Contains(understandCircuitBody(""), "kb_search") {
		t.Fatal("understand_circuit should reference kb_search")
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src/backend && go test ./mcpserver/ -run TestKBReferencedInPersonaAndPrompts -v`
Expected: FAIL — no kb_search reference yet.

- [ ] **Step 3: Implement** — in `server.go`, edit the persona's tools sentence to add the knowledge base. Change:

`…reference data (obd_*), and a shared worklist…`
to:
`…reference data (obd_*), a knowledge base (kb_search), and a shared worklist…`

Remove/trim the doc-comment note that says kb_search is deferred (it has now landed).

In `prompts.go`, add a knowledge step to `understandCircuitBody` — after step 3 ("Read it …"), append to that line or add: `Pull relevant method/concept chunks with kb_search and read the full chunk via its boardripper://kb/<id> resource.` And in `diagnoseBody`, in step 2/3 add `kb_search for the relevant technique (e.g. localizing a short).` Keep bodies coherent; do not remove existing steps.

- [ ] **Step 4: Run to verify it passes + full suite + build**

Run: `cd src/backend && go test ./mcpserver/ && go build ./...`
Expected: PASS (including the Phase 2 `TestPrompts_ListAndGet` and `TestServerInstructions_Persona`, which do NOT assert absence of kb_search — verify they still pass; if `TestServerInstructions_Persona` asserts `!Contains("kb_search")`, that assertion must be removed as part of this task since Phase 3 intentionally adds it).

- [ ] **Step 5: Commit**

```bash
git add src/backend/mcpserver/server.go src/backend/mcpserver/prompts.go src/backend/mcpserver/mcpserver_test.go
git commit -m "feat(mcp): reference kb_search in persona + prompts"
```

---

## Self-Review

**Spec coverage (Phase 3, spec §7 + §13.4):**
- `go:embed` KB chunks (method / measurement / concept), authoritative vs draft → Task 1 ✓
- Loader + frontmatter parse → Task 1 ✓
- Resources (`boardripper://kb/<id>`, list + read) → Task 2 ✓
- `kb_search` tool (query + tags + k, top-k) → Task 3 ✓
- Persona + prompts reference kb_search (the Phase-2-deferred clause) → Task 4 ✓
- Measurement-practice chunks authoritative/verbatim; concept/method chunks marked draft → Task 1 ✓

**Cross-phase note:** Task 4 Step 4 explicitly reconciles the Phase-2 `TestServerInstructions_Persona` negative kb_search assertion — it must be removed when Phase 3 adds kb_search. Flag to the reviewer.

**Placeholder scan:** all chunk bodies + Go code are complete literals; no TBD.

**Type consistency:** `kbChunk`/`loadKB`/`searchKB` defined in Task 1 and consumed unchanged in Tasks 2–3; `registerKBResources(*mcp.Server, []kbChunk)` and `registerKBSearch(*mcp.Server, []kbChunk)` both take the loaded slice; resource URI scheme `boardripper://kb/<id>` identical in registration (Task 2) and the tool's snippet pointer (Task 3).
