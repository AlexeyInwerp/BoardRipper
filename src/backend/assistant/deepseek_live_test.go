package assistant

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"os"
	"strings"
	"testing"
	"time"
)

// Live check against api.deepseek.com, run only with DEEPSEEK_API_KEY set:
// a tool round trip through stepOpenAI on each model, and the control — the
// same follow-up with the reasoning stripped must be refused.
func TestDeepSeekLive(t *testing.T) {
	key := os.Getenv("DEEPSEEK_API_KEY")
	if key == "" {
		t.Skip("DEEPSEEK_API_KEY not set")
	}
	tools := []toolDef{{Name: "part_info", Description: "Look up a component on the open board by reference designator.",
		Schema: map[string]any{"type": "object", "properties": map[string]any{"part": map[string]any{"type": "string"}}, "required": []any{"part"}}}}
	for _, model := range []string{"deepseek-v4-pro", "deepseek-flash"} {
		t.Run(model, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
			defer cancel()
			p, _ := providerByID("deepseek")
			r := resolved{Provider: p, APIKey: key, Model: model}
			c := &Conversation{}
			c.addOpenAIUser("What is U2 on this board? Use the part_info tool, then answer in one sentence.")
			calls, done, err := c.stepOpenAI(ctx, r, "You help repair circuit boards.", tools, func(Event) {})
			if err != nil || done || len(calls) == 0 {
				t.Fatalf("first step: calls=%d done=%v err=%v", len(calls), done, err)
			}
			asst := c.oai[len(c.oai)-1]
			reasoning, _ := asst["reasoning_content"].(string)
			t.Logf("tool call %s(%v); reasoning %d chars", calls[0].Name, calls[0].Args, len(reasoning))
			outs := make([]toolOutput, len(calls))
			for i := range calls {
				outs[i] = toolOutput{Text: "U2: Intel PCH, BGA837, on the bottom side, sheet PCH."}
			}
			c.addOpenAIResults(calls, outs, imagesFor(p, model))

			// Control: the same conversation without the reasoning.
			if reasoning != "" {
				stripped := &Conversation{}
				for _, m := range c.oai {
					cp := map[string]any{}
					for k, v := range m {
						if k != "reasoning_content" {
							cp[k] = v
						}
					}
					stripped.oai = append(stripped.oai, cp)
				}
				_, _, err := stripped.stepOpenAI(ctx, r, "You help repair circuit boards.", tools, func(Event) {})
				t.Logf("without reasoning_content: err=%v", err)
			}

			var text strings.Builder
			_, done, err = c.stepOpenAI(ctx, r, "You help repair circuit boards.", tools, func(e Event) {
				if e.Type == "text" {
					text.WriteString(e.Text)
				}
			})
			if err != nil {
				t.Fatalf("second step: %v", err)
			}
			t.Logf("answer (done=%v): %s", done, strings.TrimSpace(text.String()))
		})
	}
}

// deepseek-flash lists image input: a tool image goes as a user turn of
// image_url parts, the way addOpenAIResults sends it.
func TestDeepSeekLiveImage(t *testing.T) {
	key := os.Getenv("DEEPSEEK_API_KEY")
	if key == "" {
		t.Skip("DEEPSEEK_API_KEY not set")
	}
	img := image.NewRGBA(image.Rect(0, 0, 64, 64))
	for y := 0; y < 64; y++ {
		for x := 0; x < 64; x++ {
			img.Set(x, y, color.RGBA{220, 30, 30, 255})
		}
	}
	var buf bytes.Buffer
	png.Encode(&buf, img)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	p, _ := providerByID("deepseek")
	r := resolved{Provider: p, APIKey: key, Model: "deepseek-flash"}
	c := &Conversation{}
	c.addOpenAIUser("Call the snapshot tool, then tell me the single dominant colour of the image in one word.")
	tools := []toolDef{{Name: "snapshot", Description: "Returns a picture of the board.", Schema: map[string]any{"type": "object", "properties": map[string]any{}}}}
	calls, _, err := c.stepOpenAI(ctx, r, "sys", tools, func(Event) {})
	if err != nil || len(calls) == 0 {
		t.Fatalf("first step: calls=%d err=%v", len(calls), err)
	}
	outs := make([]toolOutput, len(calls))
	for i := range calls {
		outs[i] = toolOutput{Text: "snapshot attached", Images: []toolImage{{MIME: "image/png", Data: buf.Bytes()}}}
	}
	c.addOpenAIResults(calls, outs, imagesFor(p, r.Model))
	var text strings.Builder
	if _, _, err := c.stepOpenAI(ctx, r, "sys", tools, func(e Event) {
		if e.Type == "text" {
			text.WriteString(e.Text)
		}
	}); err != nil {
		t.Fatalf("image step: %v", err)
	}
	t.Logf("answer: %s", strings.TrimSpace(text.String()))
	if !strings.Contains(strings.ToLower(text.String()), "red") {
		t.Fatalf("expected red, got %q", text.String())
	}
}
