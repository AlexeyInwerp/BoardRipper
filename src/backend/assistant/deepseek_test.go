package assistant

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestImagesForNarrowsByModel(t *testing.T) {
	ds, _ := providerByID("deepseek")
	if !imagesFor(ds, "deepseek-flash") {
		t.Error("deepseek-flash reads images")
	}
	if imagesFor(ds, "deepseek-v4-pro") {
		t.Error("deepseek-v4-pro does not read images")
	}
	oa, _ := providerByID("openai")
	if !imagesFor(oa, "anything") {
		t.Error("a provider without ImageModels keeps its Images flag")
	}
}

// DeepSeek's thinking mode: with tools in the request, the reasoning of an
// earlier assistant turn must be sent back, or the API answers 400.
func TestReasoningContentGoesBackOnTheNextRequest(t *testing.T) {
	var second map[string]any
	n := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n++
		body, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		if n == 1 {
			for _, c := range []string{
				`{"choices":[{"delta":{"reasoning_content":"The user wants U2; "}}]}`,
				`{"choices":[{"delta":{"reasoning_content":"look it up."}}]}`,
				`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"part_info","arguments":"{\"part\":\"U2\"}"}}]},"finish_reason":"tool_calls"}]}`,
			} {
				fmt.Fprintf(w, "data: %s\n\n", c)
			}
			fmt.Fprint(w, "data: [DONE]\n\n")
			return
		}
		json.Unmarshal(body, &second)
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"U2 is the PCH.\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer srv.Close()

	p, _ := providerByID("deepseek")
	p.BaseURL = srv.URL
	r := resolved{Provider: p, APIKey: "k", Model: "deepseek-v4-pro"}
	c := &Conversation{}
	c.addOpenAIUser("what is U2?")
	tools := []toolDef{{Name: "part_info", Description: "d", Schema: map[string]any{"type": "object"}}}
	calls, done, err := c.stepOpenAI(context.Background(), r, "sys", tools, func(Event) {})
	if err != nil || done || len(calls) != 1 {
		t.Fatalf("first step: calls=%d done=%v err=%v", len(calls), done, err)
	}
	c.addOpenAIResults(calls, []toolOutput{{Text: "U2: PCH"}}, false)
	if _, _, err := c.stepOpenAI(context.Background(), r, "sys", tools, func(Event) {}); err != nil {
		t.Fatal(err)
	}
	msgs, _ := second["messages"].([]any)
	var found bool
	for _, m := range msgs {
		mm := m.(map[string]any)
		if mm["role"] == "assistant" && mm["reasoning_content"] == "The user wants U2; look it up." {
			found = true
		}
	}
	if !found {
		t.Fatalf("reasoning_content not sent back: %v", msgs)
	}
}
