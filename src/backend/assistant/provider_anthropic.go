package assistant

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
)

// fallbackModels accept the server-side refusal fallback in its "default"
// form: a declined request is re-served by a suitable model inside the same
// call instead of just stopping.
var fallbackModels = map[string]bool{
	"claude-opus-5-5": true, "claude-opus-5": true, "claude-fable-5-1": true, "claude-sonnet-5-5": true,
}

// webSearchTool picks the newest web search variant the model supports.
func webSearchTool(model string) anthropic.ToolUnionParam {
	newer := strings.HasPrefix(model, "claude-opus-5") || strings.HasPrefix(model, "claude-sonnet-5") ||
		strings.HasPrefix(model, "claude-fable") || strings.HasPrefix(model, "claude-opus-4-6") ||
		strings.HasPrefix(model, "claude-opus-4-7") || strings.HasPrefix(model, "claude-opus-4-8") ||
		strings.HasPrefix(model, "claude-sonnet-4-6")
	if newer {
		return anthropic.ToolUnionParam{OfWebSearchTool20260209: &anthropic.WebSearchTool20260209Param{MaxUses: anthropic.Int(5)}}
	}
	return anthropic.ToolUnionParam{OfWebSearchTool20250305: &anthropic.WebSearchTool20250305Param{MaxUses: anthropic.Int(5)}}
}

func anthropicTools(tools []toolDef, model string, webSearch bool) []anthropic.ToolUnionParam {
	out := make([]anthropic.ToolUnionParam, 0, len(tools)+1)
	for _, t := range tools {
		schema := anthropic.ToolInputSchemaParam{ExtraFields: map[string]any{}}
		for k, v := range t.Schema {
			switch k {
			case "type":
			case "properties":
				schema.Properties = v
			case "required":
				if arr, ok := v.([]any); ok {
					for _, s := range arr {
						if str, ok := s.(string); ok && str != "session" {
							schema.Required = append(schema.Required, str)
						}
					}
				}
			default:
				schema.ExtraFields[k] = v
			}
		}
		tp := anthropic.ToolParam{
			Name:        t.Name,
			Description: anthropic.String(t.Description),
			InputSchema: schema,
			// Streams large tool inputs as they are generated; the input is
			// then not validated by the API, so runAnthropic parses it and
			// returns an error result when it is not valid JSON.
			EagerInputStreaming: anthropic.Bool(true),
		}
		out = append(out, anthropic.ToolUnionParam{OfTool: &tp})
	}
	if webSearch {
		out = append(out, webSearchTool(model))
	}
	return out
}

// stepAnthropic sends the conversation once, streams the answer to emit and
// returns the client tool calls the model asked for. done is true when the
// model finished its turn.
func (c *Conversation) stepAnthropic(ctx context.Context, r resolved, system string, tools []toolDef, webSearch bool, emit func(Event)) (calls []toolCall, done bool, err error) {
	opts := []option.RequestOption{option.WithAPIKey(r.APIKey), option.WithMaxRetries(2)}
	if r.BaseURL != "" && r.BaseURL != "https://api.anthropic.com" {
		opts = append(opts, option.WithBaseURL(r.BaseURL))
	}
	client := anthropic.NewClient(opts...)

	params := anthropic.MessageNewParams{
		Model:        anthropic.Model(r.Model),
		MaxTokens:    32000,
		System:       []anthropic.TextBlockParam{{Text: system}},
		Messages:     c.anth,
		Tools:        anthropicTools(tools, r.Model, webSearch),
		CacheControl: anthropic.NewCacheControlEphemeralParam(),
	}
	var reqOpts []option.RequestOption
	if fallbackModels[r.Model] {
		reqOpts = append(reqOpts,
			option.WithHeaderAdd("anthropic-beta", "server-side-fallback-2026-07-01"),
			option.WithJSONSet("fallbacks", "default"))
	}

	stream := client.Messages.NewStreaming(ctx, params, reqOpts...)
	msg := anthropic.Message{}
	for stream.Next() {
		ev := stream.Current()
		if err := msg.Accumulate(ev); err != nil {
			return nil, false, err
		}
		switch e := ev.AsAny().(type) {
		case anthropic.ContentBlockStartEvent:
			if e.ContentBlock.Type == "server_tool_use" {
				emit(Event{Type: "tool", Tool: e.ContentBlock.Name, Status: "running"})
			}
		case anthropic.ContentBlockDeltaEvent:
			if d, ok := e.Delta.AsAny().(anthropic.TextDelta); ok {
				emit(Event{Type: "text", Text: d.Text})
			}
		}
	}
	if err := stream.Err(); err != nil {
		var apiErr *anthropic.Error
		if errors.As(err, &apiErr) {
			return nil, false, errors.New(anthropicErrorText(apiErr))
		}
		return nil, false, err
	}
	// Keep the whole response, thinking and server-tool blocks included:
	// the next request must carry them back unchanged.
	c.anth = append(c.anth, msg.ToParam())

	switch msg.StopReason {
	case anthropic.StopReasonToolUse:
		for _, b := range msg.Content {
			if tu, ok := b.AsAny().(anthropic.ToolUseBlock); ok {
				call := toolCall{ID: tu.ID, Name: tu.Name, Args: map[string]any{}}
				raw := tu.JSON.Input.Raw()
				if strings.TrimSpace(raw) != "" {
					if err := json.Unmarshal([]byte(raw), &call.Args); err != nil {
						call.ParseErr = err
					}
				}
				calls = append(calls, call)
			}
		}
		return calls, false, nil
	case anthropic.StopReasonPauseTurn:
		return nil, false, nil // a server tool paused the turn; send it back as is
	case anthropic.StopReasonRefusal:
		emit(Event{Type: "notice", Message: "The model declined to answer this request."})
		return nil, true, nil
	case anthropic.StopReasonMaxTokens:
		emit(Event{Type: "notice", Message: "The answer hit the length limit and was cut."})
		return nil, true, nil
	}
	return nil, true, nil
}

func anthropicErrorText(e *anthropic.Error) string {
	switch e.StatusCode {
	case 401:
		return "Anthropic rejected the API key. Check it in the assistant's settings."
	case 403:
		return "This API key is not allowed to use that model."
	case 404:
		return "That model is not available to this API key. Pick another one in the assistant's settings."
	case 429:
		return "Anthropic's rate limit was reached. Wait a moment and try again."
	case 529, 503:
		return "Anthropic is overloaded right now. Try again in a minute."
	}
	return "Anthropic API error: " + e.Error()
}

// addAnthropicResults appends one user turn holding every tool result.
func (c *Conversation) addAnthropicResults(calls []toolCall, outs []toolOutput, images bool) {
	blocks := make([]anthropic.ContentBlockParamUnion, 0, len(calls))
	for i, call := range calls {
		out := outs[i]
		content := []anthropic.ToolResultBlockParamContentUnion{{OfText: &anthropic.TextBlockParam{Text: out.Text}}}
		if images {
			for _, img := range out.Images {
				ib := anthropic.NewImageBlockBase64(img.MIME, base64.StdEncoding.EncodeToString(img.Data))
				if ib.OfImage != nil {
					content = append(content, anthropic.ToolResultBlockParamContentUnion{OfImage: ib.OfImage})
				}
			}
		}
		blocks = append(blocks, anthropic.ContentBlockParamUnion{OfToolResult: &anthropic.ToolResultBlockParam{
			ToolUseID: call.ID,
			IsError:   anthropic.Bool(out.IsError),
			Content:   content,
		}})
	}
	c.anth = append(c.anth, anthropic.NewUserMessage(blocks...))
}

func (c *Conversation) addAnthropicUser(text string) {
	c.anth = append(c.anth, anthropic.NewUserMessage(anthropic.NewTextBlock(text)))
}

func listAnthropicModels(ctx context.Context, r resolved) ([]string, error) {
	opts := []option.RequestOption{option.WithAPIKey(r.APIKey)}
	if r.BaseURL != "" && r.BaseURL != "https://api.anthropic.com" {
		opts = append(opts, option.WithBaseURL(r.BaseURL))
	}
	client := anthropic.NewClient(opts...)
	pager := client.Models.ListAutoPaging(ctx, anthropic.ModelListParams{})
	var ids []string
	for pager.Next() {
		ids = append(ids, pager.Current().ID)
	}
	if err := pager.Err(); err != nil {
		var apiErr *anthropic.Error
		if errors.As(err, &apiErr) {
			return nil, errors.New(anthropicErrorText(apiErr))
		}
		return nil, err
	}
	return ids, nil
}
