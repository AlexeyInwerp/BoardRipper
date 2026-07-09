package mcpserver

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"time"

	"github.com/coder/websocket"
)

// wsMsg is the envelope for browser->backend messages on the bridge.
type wsMsg struct {
	Type    string          `json:"type"` // hello | board_changed | focus | reply
	Session string          `json:"session"`
	Secret  string          `json:"secret,omitempty"` // per-install MCP secret, hello only
	Board   json.RawMessage `json:"board,omitempty"`
	Reply   *bridgeReply    `json:"reply,omitempty"`
}

// ServeWS returns the WebSocket bridge handler. The bridge is authenticated and
// gated (M14): it is inert (404) whenever MCP is disabled, and the first
// app-level frame MUST be a hello carrying the per-install MCP secret before any
// session is registered — so no unauthenticated LAN peer can register a session
// or inject replies. Origin is additionally restricted to the same-origin SPA
// (coder/websocket authorizes the request host by default; localhost patterns
// cover split dev servers). The SDK Gate is intentionally NOT applied here —
// external MCP clients never touch the bridge; only the backend's own live-board
// tools call into it.
func (b *Bridge) ServeWS(st *State, secret string) http.HandlerFunc {
	secretB := []byte(secret)
	return func(w http.ResponseWriter, r *http.Request) {
		// Inert when MCP is off — mirror the main /api/mcp handler's invisibility.
		if st == nil || !st.Enabled() {
			http.NotFound(w, r)
			return
		}
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			OriginPatterns: []string{"localhost:*", "127.0.0.1:*"},
		})
		if err != nil {
			return
		}
		// Binary tool replies (pdf_download ≈ 4/3 × up to 50 MiB, pdf_page_image /
		// board_snapshot PNGs) far exceed coder/websocket's 32 KiB default read
		// limit; raise it or every large reply tears down the bridge session.
		c.SetReadLimit(72 << 20) // 72 MiB: 50 MiB PDF base64-inflated (~67 MiB) + JSON envelope headroom
		defer c.CloseNow()

		ctx := r.Context()

		// First frame must be an authenticated hello with a session id. Reject
		// (policy-violation close) if the feature flipped off, the frame is not a
		// hello, the session id is empty, or the secret does not match the
		// per-install MCP secret. Only after the hello validates is the session
		// registered.
		var hello wsMsg
		if err := readJSON(ctx, c, &hello); err != nil ||
			!st.Enabled() ||
			hello.Type != "hello" ||
			hello.Session == "" ||
			subtle.ConstantTimeCompare([]byte(hello.Secret), secretB) != 1 {
			_ = c.Close(websocket.StatusPolicyViolation, "unauthorized")
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
					// Attribute the reply to this socket's authenticated session
					// (hello.Session, not the client-controlled per-frame field) so
					// a reply can only satisfy a request routed to the same session.
					_ = b.deliverFrom(hello.Session, *m.Reply)
				}
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
