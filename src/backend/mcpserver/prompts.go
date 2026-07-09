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
