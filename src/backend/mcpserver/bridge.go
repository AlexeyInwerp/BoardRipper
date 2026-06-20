package mcpserver

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"
)

// bridgeFrame is sent from the backend to the browser tab (a request).
type bridgeFrame struct {
	ID     int64           `json:"id"`
	Op     string          `json:"op"`
	Params json.RawMessage `json:"params"`
}

// bridgeReply is sent from the browser tab back to the backend.
type bridgeReply struct {
	ID     int64           `json:"id"`
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  string          `json:"error,omitempty"`
}

type session struct {
	id        string
	board     json.RawMessage // descriptor from hello/board_changed
	outbound  chan bridgeFrame
	focusedAt time.Time
}

// Bridge tracks connected browser pages and correlates request/response so
// live-board MCP tools can be answered by the focused tab.
type Bridge struct {
	mu       sync.Mutex
	sessions map[string]*session
	pending  map[int64]chan bridgeReply
	nextID   int64
}

func NewBridge() *Bridge {
	return &Bridge{sessions: map[string]*session{}, pending: map[int64]chan bridgeReply{}}
}

func (b *Bridge) register(id string, board json.RawMessage) *session {
	b.mu.Lock()
	defer b.mu.Unlock()
	s := &session{id: id, board: board, outbound: make(chan bridgeFrame, 16), focusedAt: time.Now()}
	b.sessions[id] = s
	return s
}

func (b *Bridge) unregister(id string) {
	b.mu.Lock()
	delete(b.sessions, id)
	b.mu.Unlock()
}

func (b *Bridge) touchFocus(id string) {
	b.mu.Lock()
	if s := b.sessions[id]; s != nil {
		s.focusedAt = time.Now()
	}
	b.mu.Unlock()
}

func (b *Bridge) setBoard(id string, board json.RawMessage) {
	b.mu.Lock()
	if s := b.sessions[id]; s != nil {
		s.board = board
	}
	b.mu.Unlock()
}

// pick returns the target session: explicit id, else most-recently-focused.
func (b *Bridge) pick(sessionID string) *session {
	b.mu.Lock()
	defer b.mu.Unlock()
	if sessionID != "" {
		return b.sessions[sessionID]
	}
	var best *session
	for _, s := range b.sessions {
		if best == nil || s.focusedAt.After(best.focusedAt) {
			best = s
		}
	}
	return best
}

func (b *Bridge) deliver(r bridgeReply) error {
	b.mu.Lock()
	ch := b.pending[r.ID]
	delete(b.pending, r.ID)
	b.mu.Unlock()
	if ch == nil {
		return errors.New("no pending request for id")
	}
	ch <- r
	return nil
}

// Request sends op/params to the chosen tab and waits for a reply or timeout.
func (b *Bridge) Request(ctx context.Context, sessionID, op string, params any, timeout time.Duration) (json.RawMessage, error) {
	s := b.pick(sessionID)
	if s == nil {
		return nil, errors.New("no board open in BoardRipper — open a board in the browser first")
	}
	raw, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	b.mu.Lock()
	b.nextID++
	id := b.nextID
	reply := make(chan bridgeReply, 1)
	b.pending[id] = reply
	b.mu.Unlock()

	select {
	case s.outbound <- bridgeFrame{ID: id, Op: op, Params: raw}:
	case <-time.After(timeout):
		b.cancel(id)
		return nil, errors.New("bridge send timeout (tab not reading)")
	case <-ctx.Done():
		b.cancel(id)
		return nil, ctx.Err()
	}

	select {
	case r := <-reply:
		if !r.OK {
			if r.Error == "" {
				r.Error = "tab reported an error"
			}
			return nil, errors.New(r.Error)
		}
		return r.Result, nil
	case <-time.After(timeout):
		b.cancel(id)
		return nil, errors.New("bridge request timed out (no tab response)")
	case <-ctx.Done():
		b.cancel(id)
		return nil, ctx.Err()
	}
}

func (b *Bridge) cancel(id int64) {
	b.mu.Lock()
	delete(b.pending, id)
	b.mu.Unlock()
}

// Sessions returns descriptors of all connected boards (for board_sessions).
func (b *Bridge) Sessions() []json.RawMessage {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]json.RawMessage, 0, len(b.sessions))
	for _, s := range b.sessions {
		if s.board != nil {
			out = append(out, s.board)
		}
	}
	return out
}

// ClientCount reports how many browser pages are connected.
func (b *Bridge) ClientCount() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.sessions)
}
