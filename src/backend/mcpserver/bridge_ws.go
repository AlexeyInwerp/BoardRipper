package mcpserver

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/coder/websocket"
)

// wsMsg is the envelope for browser->backend messages on the bridge.
type wsMsg struct {
	Type    string          `json:"type"` // hello | board_changed | focus | reply
	Session string          `json:"session"`
	Board   json.RawMessage `json:"board,omitempty"`
	Reply   *bridgeReply    `json:"reply,omitempty"`
}

// ServeWS upgrades the connection and runs the read/write loops. The bridge is
// reachable only by the same-origin SPA (coder/websocket authorizes the request
// host by default; localhost patterns are added for split dev servers). The SDK
// Gate is intentionally NOT applied here — external MCP clients never touch the
// bridge; only the backend's own live-board tools call into it.
func (b *Bridge) ServeWS(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: []string{"localhost:*", "127.0.0.1:*"},
	})
	if err != nil {
		return
	}
	defer c.CloseNow()

	ctx := r.Context()

	// First frame must be hello with a session id.
	var hello wsMsg
	if err := readJSON(ctx, c, &hello); err != nil || hello.Type != "hello" || hello.Session == "" {
		_ = c.Close(websocket.StatusPolicyViolation, "expected hello")
		return
	}
	s := b.register(hello.Session, hello.Board)
	defer b.unregister(hello.Session)

	// Writer goroutine: drain outbound request frames to the browser.
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
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

	// Reader loop: handle focus / board_changed / reply until the socket closes.
	for {
		var m wsMsg
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
				_ = b.deliver(*m.Reply)
			}
		}
	}
}

func readJSON(ctx context.Context, c *websocket.Conn, v any) error {
	rctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
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
