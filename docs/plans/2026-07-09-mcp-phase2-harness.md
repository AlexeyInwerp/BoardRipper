# MCP Phase 2 — Prompting Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prime a connected model as a repair technician + educator at MCP connect, and offer three invokable step-by-step prompt workflows.

**Architecture:** Two additions to the existing Go MCP server. (1) A persona preamble prepended to the server `Instructions` string sent in every `initialize`. (2) Three prompts registered via the SDK `Server.AddPrompt`, each returning a parameterized `user`-role message wired to the real tool names.

**Tech Stack:** Go, `github.com/modelcontextprotocol/go-sdk` v1.6.1 (`Server.AddPrompt`, `Prompt`, `PromptArgument`, `GetPromptRequest`, `GetPromptResult`, `PromptMessage`, `TextContent`).

## Global Constraints

- Builds on Phase 1 (already on `main`): tool names are final — `board_snapshot`, `pdf_page_image`, `pdf_page_text`, `pdf_search_open` (NOT `pdf_find`), `pdf_search`, `board_overview`, `file_download`, plus the existing `list_nets`/`list_parts`/`net_info`/`net_neighbors`/`pin_connectivity`/`part_info`/`board_resolve`/`obd_match`/`obd_data`/`worklist_*`/`request_measurement`/`get_measurements`/`post_message` and drive-UI tools.
- **Do NOT reference `kb_search` anywhere in Phase 2** — that tool lands in Phase 3. The persona and prompts must only name tools that exist after Phase 2.
- Persona = technician + educator + measurement-discipline + never-guess/low-trust-nets, delivered adaptively off one read of user expertise (spec §6.1, §12.9, §13). Keep it in `server.go` as a prepend to the existing `boardripperInstructions` (do not rewrite the existing worklist orientation text).
- Prompts are always advertised when MCP is enabled (AddPrompt auto-sets the prompts capability). They are read-only guidance; they do not gate on drive-UI.
- Logging/style: match existing `mcpserver` Go conventions.

## File Structure

- Modify `src/backend/mcpserver/server.go` — add `technicianPersona` const; set `Instructions: technicianPersona + "\n\n" + boardripperInstructions`.
- Create `src/backend/mcpserver/prompts.go` — the three `*Prompt` definitions + handlers + a `registerPrompts(s *mcp.Server)` func called from `New()`.
- Modify `src/backend/mcpserver/server.go` — call `registerPrompts(s.mcp)` in `New()`.
- Modify `src/backend/mcpserver/mcpserver_test.go` — persona + prompts tests.

---

### Task 1: Technician + educator persona preamble

**Files:**
- Modify: `src/backend/mcpserver/server.go`
- Test: `src/backend/mcpserver/mcpserver_test.go`

**Interfaces:**
- Produces: `const technicianPersona string`; the server's `Instructions` now begins with it.

- [ ] **Step 1: Write the failing test** (append to `mcpserver_test.go`)

```go
func TestServerInstructions_Persona(t *testing.T) {
	deps := &Deps{State: NewState(&fakeConfig{m: map[string]string{"mcp_enabled": "1"}})}
	srv := New(deps)
	got := srv.mcp.Instructions() // see Step 3 note if this accessor differs
	for _, want := range []string{
		"electronics repair technician",
		"Never guess",
		"unlabeled",
		"Teach as you fix",
		"continuity mode for continuity only",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("Instructions missing %q", want)
		}
	}
	// Phase 2 must NOT mention the Phase-3 kb_search tool yet.
	if strings.Contains(got, "kb_search") {
		t.Fatal("persona references kb_search before Phase 3")
	}
	// The existing worklist orientation must still be present (prepend, not replace).
	if !strings.Contains(got, "worklist") {
		t.Fatal("existing boardripperInstructions was dropped")
	}
}
```

Add `"strings"` to the test imports if not present.

- [ ] **Step 2: Run to verify it fails**

Run: `cd src/backend && go test ./mcpserver/ -run TestServerInstructions_Persona -v`
Expected: FAIL — either `srv.mcp.Instructions` undefined, or the persona text absent.

Note on the accessor: if `srv.mcp.Instructions()` does not compile (the SDK may not expose a getter), change the test to assert against the package constant directly: build the combined string the same way `New()` does and assert on `technicianPersona + "\n\n" + boardripperInstructions`, i.e. replace `got := srv.mcp.Instructions()` with `got := technicianPersona + "\n\n" + boardripperInstructions`. Pick whichever compiles; keep all the `Contains` assertions.

- [ ] **Step 3: Implement the persona** — in `server.go`, add the const above `boardripperInstructions` and wire it into `New()`.

```go
// technicianPersona primes any connecting client as a repair technician +
// educator. Prepended to boardripperInstructions so every initialize carries
// it. NOTE: intentionally names no kb_search — that tool arrives in Phase 3;
// add "a knowledge base (kb_search), " to the eyes/tools sentence then.
const technicianPersona = `You are acting as an electronics repair technician working a live board in BoardRipper. Understand the circuit before you judge it: build a mental model step by step from what the board and its schematic actually show, form hypotheses, and test them with measurements rather than guessing. Work incrementally — identify the board, map its power domains, follow the suspect signal, narrow down. You have eyes (board_snapshot, pdf_page_image), the schematic and its text (pdf_page_text, pdf_search_open, pdf_search), the netlist/parts, reference data (obd_*), and a shared worklist to record findings and ask the user to probe. Prefer evidence over assumption; when unsure, request a measurement and wait. Never guess — don't invent a net's function, a part's role, or an expected value you don't have; if you must infer, say so and lower your confidence. Treat unlabeled / auto-named nets as low-trust: they carry no meaning, so infer their role only from what they connect to, say you're inferring, and confirm before acting on it.

When you request measurements, be economical and correct: don't ask for the same electrical node twice — nets bridged by a populated 0Ω resistor or closed jumper are one node (but have the user confirm the link if it may be unpopulated). Pick the meter mode that fits the target: diode mode for data lines, not for power rails or CPU/GPU phases (there it reads low and meter-dependent); use voltage or resistance-to-ground for rails; reserve continuity mode for continuity only. Remind the user to power down before resistance/diode probing and to re-check any abnormal reading — but calibrate these safety reminders to their apparent skill and drop them for an evidently experienced tech.

Teach as you fix. Explain your reasoning and the circuit in plain terms, calibrated to the user's level — enough that they learn why, not just what. Ground every explanation in the board (nets/parts as [n:NET] / [p:REFDES:PIN] chips, the schematic to point at the actual circuit), and define jargon the first time you use it. Safety-reminder verbosity, explanation depth, and terseness of findings all move together off one read of the user's expertise: teach a beginner, stay terse for an expert.`
```

Then change the `mcp.NewServer(...)` call in `New()` from `Instructions: boardripperInstructions` to:

```go
	s.mcp = mcp.NewServer(&mcp.Implementation{Name: "boardripper", Version: "1"}, &mcp.ServerOptions{Instructions: technicianPersona + "\n\n" + boardripperInstructions})
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd src/backend && go test ./mcpserver/ -run TestServerInstructions_Persona -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/mcpserver/server.go src/backend/mcpserver/mcpserver_test.go
git commit -m "feat(mcp): technician+educator persona preamble in server instructions"
```

---

### Task 2: Register understand_circuit / diagnose / explain prompts

**Files:**
- Create: `src/backend/mcpserver/prompts.go`
- Modify: `src/backend/mcpserver/server.go` (call `registerPrompts` in `New()`)
- Test: `src/backend/mcpserver/mcpserver_test.go`

**Interfaces:**
- Consumes: `mcp.Server`, `mcp.AddPrompt`/`Server.AddPrompt`, `GetPromptRequest`, `GetPromptResult`.
- Produces: `func registerPrompts(s *mcp.Server)`; prompts `understand_circuit` (arg `focus`), `diagnose` (arg `symptom`), `explain` (arg `topic`).

- [ ] **Step 1: Write the failing test** (append to `mcpserver_test.go`)

```go
func TestPrompts_ListAndGet(t *testing.T) {
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

	lp, err := cs.ListPrompts(ctx, nil)
	if err != nil { t.Fatal(err) }
	names := map[string]bool{}
	for _, p := range lp.Prompts { names[p.Name] = true }
	for _, want := range []string{"understand_circuit", "diagnose", "explain"} {
		if !names[want] { t.Fatalf("prompts/list missing %q", want) }
	}

	// get with an argument -> the arg is interpolated into the message text.
	gp, err := cs.GetPrompt(ctx, &mcp.GetPromptParams{Name: "understand_circuit", Arguments: map[string]string{"focus": "PP3V3_G3H"}})
	if err != nil { t.Fatal(err) }
	if len(gp.Messages) == 0 { t.Fatal("no messages") }
	txt, ok := gp.Messages[0].Content.(*mcp.TextContent)
	if !ok { t.Fatalf("message content is %T, want *TextContent", gp.Messages[0].Content) }
	if !strings.Contains(txt.Text, "PP3V3_G3H") {
		t.Fatalf("focus arg not interpolated: %s", txt.Text)
	}
	if gp.Messages[0].Role != "user" {
		t.Fatalf("role = %q, want user", gp.Messages[0].Role)
	}
	// prompts must not reference the Phase-3 kb_search tool.
	if strings.Contains(txt.Text, "kb_search") {
		t.Fatal("prompt references kb_search before Phase 3")
	}

	// get with NO argument still returns a valid message (optional arg).
	gp2, err := cs.GetPrompt(ctx, &mcp.GetPromptParams{Name: "diagnose"})
	if err != nil { t.Fatal(err) }
	if len(gp2.Messages) == 0 { t.Fatal("diagnose returned no messages without arg") }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src/backend && go test ./mcpserver/ -run TestPrompts_ListAndGet -v`
Expected: FAIL — no prompts registered (`prompts/list missing "understand_circuit"`).

- [ ] **Step 3: Implement `prompts.go`**

```go
package mcpserver

import (
	"context"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// registerPrompts adds the invokable technician workflows. They are guidance
// templates (a user-role message priming the persona + a tool-wired loop),
// parameterized by an optional focus/symptom/topic. They name only tools that
// exist through Phase 2 — no kb_search (Phase 3).
func registerPrompts(s *mcp.Server) {
	s.AddPrompt(&mcp.Prompt{
		Name:        "understand_circuit",
		Description: "Learn and explain how the open board's circuit works, step by step (optionally focused on a net/part/area). The model builds its own understanding.",
		Arguments:   []*mcp.PromptArgument{{Name: "focus", Description: "optional net, part, or area to focus on"}},
	}, promptHandler(understandCircuitBody))

	s.AddPrompt(&mcp.Prompt{
		Name:        "diagnose",
		Description: "Diagnose the open board with the shared worklist loop (optionally given a symptom).",
		Arguments:   []*mcp.PromptArgument{{Name: "symptom", Description: "optional presenting symptom"}},
	}, promptHandler(diagnoseBody))

	s.AddPrompt(&mcp.Prompt{
		Name:        "explain",
		Description: "Teach the user about a net, part, subsystem, or concept in plain terms, grounded in the open board.",
		Arguments:   []*mcp.PromptArgument{{Name: "topic", Description: "optional net/part/subsystem/concept to explain"}},
	}, promptHandler(explainBody))
}

// promptHandler wraps a body-builder (which receives the single optional arg
// value, "" when absent) into a PromptHandler returning one user-role message.
func promptHandler(build func(arg string) string) mcp.PromptHandler {
	return func(_ context.Context, req *mcp.GetPromptRequest) (*mcp.GetPromptResult, error) {
		arg := ""
		if req != nil && req.Params != nil {
			// each prompt declares exactly one optional argument; take whichever is set.
			for _, v := range req.Params.Arguments {
				if strings.TrimSpace(v) != "" {
					arg = strings.TrimSpace(v)
					break
				}
			}
		}
		return &mcp.GetPromptResult{
			Messages: []*mcp.PromptMessage{
				{Role: "user", Content: &mcp.TextContent{Text: build(arg)}},
			},
		}, nil
	}
}

func understandCircuitBody(focus string) string {
	scope := ""
	if focus != "" {
		scope = ", focused on " + focus
	}
	return `Act as an electronics repair technician. Goal: learn and explain how this circuit works, step by step` + scope + `.
1. Orient — board_overview for the open board; board_resolve for brand/family.
2. See it — board_snapshot; if a schematic is open, pdf_page_image the relevant page.
3. Read it — scope with list_nets/list_parts; for the focus use net_info, part_info, net_neighbors, pin_connectivity; cross-reference the schematic with pdf_search_open / pdf_search / pdf_page_text.
4. Model it — describe the power domains and signal path you reconstructed; what each key part does and how the nets tie together.
5. Verify — where uncertain, request_measurement and say what a reading would confirm.
Build understanding incrementally and show your reasoning; don't jump to conclusions. Treat unlabeled (synthetic) nets as low-trust — infer their role only from what they connect to and say so.`
}

func diagnoseBody(symptom string) string {
	sym := ""
	if symptom != "" {
		sym = ", presenting with: " + symptom
	}
	return `Act as an electronics repair technician diagnosing this board` + sym + `.
1. Read the case — worklist_get + get_measurements (respect any user-recorded readings and notes).
2. Orient — board_overview / board_resolve; obd_match + obd_data for known-good readings on this model.
3. Localize — from the symptom, identify the implicated power domain / subsystem; bound it with net_neighbors + the schematic (pdf_search_open / pdf_page_image).
4. Hypothesize + test — add suspect parts/nets with worklist_add; request_measurement for the readings that would confirm or deny; wait, then get_measurements.
5. Narrow — iterate until one cause stands; record it with worklist_set_list_note and a short post_message.
Prefer measurements over assumptions; keep the worklist current. Worklist writes and UI actions only take effect if the user enabled drive-UI — otherwise report your findings in chat.`
}

func explainBody(topic string) string {
	what := "this circuit"
	if topic != "" {
		what = topic
	}
	return `Act as an electronics repair technician teaching the user. Explain ` + what + ` in simple, clean terms, grounded in the open board where relevant: what it is, what it does here, how it connects, and what "healthy" looks like. Use board_overview / part_info / net_info and the schematic (pdf_page_image / pdf_page_text) to point at the real thing; reference nets/parts as [n:NET] / [p:REFDES:PIN] chips. Calibrate depth to the user's apparent level and define jargon the first time you use it. This is teaching, not diagnosis — build understanding rather than just stating conclusions.`
}
```

- [ ] **Step 4: Call `registerPrompts` from `New()`** — in `server.go`, right after `registerLiveTools(s.mcp, deps)`:

```go
	registerPrompts(s.mcp)
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd src/backend && go test ./mcpserver/ -run TestPrompts_ListAndGet -v`
Expected: PASS.

- [ ] **Step 6: Full package test + build**

Run: `cd src/backend && go test ./mcpserver/ && go build ./...`
Expected: PASS, no build errors.

- [ ] **Step 7: Commit**

```bash
git add src/backend/mcpserver/prompts.go src/backend/mcpserver/server.go src/backend/mcpserver/mcpserver_test.go
git commit -m "feat(mcp): understand_circuit / diagnose / explain prompts"
```

---

## Self-Review

**Spec coverage (Phase 2, spec §6 + §13.5):**
- Persona preamble (technician + educator + measurement discipline + never-guess/low-trust) → Task 1 ✓
- `understand_circuit` / `diagnose` / `explain` prompts, parameterized → Task 2 ✓
- No `kb_search` reference (deferred to Phase 3) → asserted in both tests ✓
- `trace_rail` (optional) → deferred, not in this plan (spec-sanctioned) ✓

**Placeholder scan:** persona + prompt bodies are complete literal strings; the one conditional (Task 1 Step 2 accessor note) gives a concrete either/or, not a TBD.

**Type consistency:** `promptHandler(func(string) string) mcp.PromptHandler` used by all three registrations; `req.Params.Arguments` (map[string]string) read per the SDK's canonical example; `GetPromptResult{Messages:[]*PromptMessage{{Role:"user", Content:&TextContent{...}}}}` matches the SDK example exactly.
