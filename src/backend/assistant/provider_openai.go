package assistant

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
)

// OpenAI-compatible chat completions: OpenAI itself, Google's Gemini API
// compatibility endpoint, Ollama and LM Studio all speak this shape.

var httpClient = &http.Client{Timeout: 0} // streaming; the request context bounds it

func oaiTools(tools []toolDef) []map[string]any {
	out := make([]map[string]any, 0, len(tools))
	for _, t := range tools {
		schema := t.Schema
		if req, ok := schema["required"].([]any); ok {
			kept := req[:0:0]
			for _, r := range req {
				if r != "session" {
					kept = append(kept, r)
				}
			}
			schema["required"] = kept
		}
		out = append(out, map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        t.Name,
				"description": t.Description,
				"parameters":  schema,
			},
		})
	}
	return out
}

func (c *Conversation) stepOpenAI(ctx context.Context, r resolved, system string, tools []toolDef, emit func(Event)) (calls []toolCall, done bool, err error) {
	msgs := append([]map[string]any{{"role": "system", "content": system}}, c.oai...)
	body := map[string]any{
		"model":    r.Model,
		"messages": msgs,
		"stream":   true,
	}
	if len(tools) > 0 {
		body["tools"] = oaiTools(tools)
	}
	b, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.BaseURL+"/chat/completions", bytes.NewReader(b))
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("Content-Type", "application/json")
	if r.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+r.APIKey)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		if r.Local {
			return nil, false, fmt.Errorf("could not reach %s at %s. Is it running, and is the address right from the BoardRipper server? (%v)", r.Label, r.BaseURL, err)
		}
		return nil, false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, false, errors.New(oaiErrorText(r, resp.StatusCode, msg))
	}

	type partial struct {
		ID, Name string
		Args     strings.Builder
	}
	var text strings.Builder
	parts := map[int]*partial{}
	finish := ""
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			break
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content   *string `json:"content"`
					ToolCalls []struct {
						Index    int    `json:"index"`
						ID       string `json:"id"`
						Function struct {
							Name      string `json:"name"`
							Arguments string `json:"arguments"`
						} `json:"function"`
					} `json:"tool_calls"`
				} `json:"delta"`
				FinishReason *string `json:"finish_reason"`
			} `json:"choices"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal([]byte(data), &chunk) != nil {
			continue
		}
		if chunk.Error != nil {
			return nil, false, errors.New(r.Label + ": " + chunk.Error.Message)
		}
		for _, ch := range chunk.Choices {
			if ch.Delta.Content != nil && *ch.Delta.Content != "" {
				text.WriteString(*ch.Delta.Content)
				emit(Event{Type: "text", Text: *ch.Delta.Content})
			}
			for _, tc := range ch.Delta.ToolCalls {
				p := parts[tc.Index]
				if p == nil {
					p = &partial{}
					parts[tc.Index] = p
				}
				if tc.ID != "" {
					p.ID = tc.ID
				}
				if tc.Function.Name != "" {
					p.Name += tc.Function.Name
				}
				p.Args.WriteString(tc.Function.Arguments)
			}
			if ch.FinishReason != nil {
				finish = *ch.FinishReason
			}
		}
	}
	if err := sc.Err(); err != nil {
		return nil, false, err
	}

	asst := map[string]any{"role": "assistant"}
	if text.Len() > 0 {
		asst["content"] = text.String()
	} else {
		asst["content"] = nil
	}
	idx := make([]int, 0, len(parts))
	for i := range parts {
		idx = append(idx, i)
	}
	sort.Ints(idx)
	var tcs []map[string]any
	for n, i := range idx {
		p := parts[i]
		if p.Name == "" {
			continue
		}
		if p.ID == "" {
			p.ID = fmt.Sprintf("call_%d_%d", time.Now().UnixNano(), n)
		}
		args := p.Args.String()
		if strings.TrimSpace(args) == "" {
			args = "{}"
		}
		tcs = append(tcs, map[string]any{"id": p.ID, "type": "function", "function": map[string]any{"name": p.Name, "arguments": args}})
		call := toolCall{ID: p.ID, Name: p.Name, Args: map[string]any{}}
		if err := json.Unmarshal([]byte(args), &call.Args); err != nil {
			call.ParseErr = err
		}
		calls = append(calls, call)
	}
	if len(tcs) > 0 {
		asst["tool_calls"] = tcs
	}
	c.oai = append(c.oai, asst)
	if finish == "length" {
		emit(Event{Type: "notice", Message: "The answer hit the length limit and was cut."})
	}
	return calls, len(calls) == 0, nil
}

func oaiErrorText(r resolved, status int, body []byte) string {
	var e struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &e)
	detail := e.Error.Message
	if detail == "" {
		detail = strings.TrimSpace(string(body))
	}
	switch status {
	case 401, 403:
		return r.Label + " rejected the API key. Check it in the assistant's settings."
	case 404:
		return r.Label + " does not know the model " + r.Model + ". Pick another one in the assistant's settings."
	case 429:
		return r.Label + "'s rate limit or quota was reached. " + detail
	}
	return fmt.Sprintf("%s error (HTTP %d): %s", r.Label, status, detail)
}

func (c *Conversation) addOpenAIResults(calls []toolCall, outs []toolOutput, images bool) {
	var pending []toolImage
	for i, call := range calls {
		c.oai = append(c.oai, map[string]any{"role": "tool", "tool_call_id": call.ID, "content": outs[i].Text})
		pending = append(pending, outs[i].Images...)
	}
	if len(pending) == 0 {
		return
	}
	// Tool messages can only carry text in this API; images follow as a user turn.
	if !images {
		c.oai = append(c.oai, map[string]any{"role": "user", "content": "(The tools also returned images, which are not sent to this model.)"})
		return
	}
	parts := []map[string]any{{"type": "text", "text": "Images returned by the tool calls above:"}}
	for _, img := range pending {
		parts = append(parts, map[string]any{"type": "image_url", "image_url": map[string]any{
			"url": "data:" + img.MIME + ";base64," + base64.StdEncoding.EncodeToString(img.Data),
		}})
	}
	c.oai = append(c.oai, map[string]any{"role": "user", "content": parts})
}

func (c *Conversation) addOpenAIUser(text string) {
	c.oai = append(c.oai, map[string]any{"role": "user", "content": text})
}

func listOpenAIModels(ctx context.Context, r resolved) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.BaseURL+"/models", nil)
	if err != nil {
		return nil, err
	}
	if r.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+r.APIKey)
	}
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		if r.Local {
			return nil, fmt.Errorf("could not reach %s at %s from the BoardRipper server (%v)", r.Label, r.BaseURL, err)
		}
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, errors.New(oaiErrorText(r, resp.StatusCode, body))
	}
	var list struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &list); err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(list.Data))
	for _, m := range list.Data {
		ids = append(ids, strings.TrimPrefix(m.ID, "models/"))
	}
	sort.Strings(ids)
	return ids, nil
}
