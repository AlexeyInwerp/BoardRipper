package mcpserver

import (
	"context"
	"crypto/rand"
	"encoding/binary"
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

// pendingReq is an in-flight bridge request awaiting a reply. session records
// which browser session the request was routed to, so a reply arriving on a
// different session can never satisfy it (cross-session confused-deputy defence).
type pendingReq struct {
	session string
	ch      chan bridgeReply
}

// Bridge tracks connected browser pages and correlates request/response so
// live-board MCP tools can be answered by the focused tab.
type Bridge struct {
	mu       sync.Mutex
	sessions map[string]*session
	pending  map[int64]pendingReq
	nextID   int64
}

func NewBridge() *Bridge {
	return &Bridge{
		sessions: map[string]*session{},
		pending:  map[int64]pendingReq{},
		// Seed the request-id counter with a random offset so ids are not
		// predictable sequential integers (defense-in-depth against id-guessing;
		// per-session reply correlation in deliverFrom is the primary defence).
		nextID: randomInitialID(),
	}
}

// randomInitialID returns a non-negative random seed for the request-id counter.
// Masked to 48 bits so the ++ counter has ample headroom before overflow.
func randomInitialID() int64 {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return 0
	}
	return int64(binary.BigEndian.Uint64(b[:]) & 0xFFFFFFFFFFFF)
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

// deliver routes a reply to its pending request by id WITHOUT verifying the
// owning session. Retained for the in-process test harness; the production
// bridge (ServeWS reader loop) uses deliverFrom, which enforces session match.
func (b *Bridge) deliver(r bridgeReply) error {
	return b.route("", r, false)
}

// deliverFrom routes a reply to its pending request and verifies the reply
// arrived on the same session the request was routed to. A reply from session A
// can never satisfy a request routed to session B.
func (b *Bridge) deliverFrom(sessionID string, r bridgeReply) error {
	return b.route(sessionID, r, true)
}

func (b *Bridge) route(sessionID string, r bridgeReply, checkSession bool) error {
	b.mu.Lock()
	p, ok := b.pending[r.ID]
	if !ok {
		b.mu.Unlock()
		return errors.New("no pending request for id")
	}
	if checkSession && p.session != sessionID {
		// Reply arrived on a different session than the request was routed to.
		// Leave the pending entry intact so the legitimate session can still
		// answer, and drop the spoofed reply.
		b.mu.Unlock()
		return errors.New("reply session mismatch")
	}
	delete(b.pending, r.ID)
	b.mu.Unlock()
	p.ch <- r
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
	b.pending[id] = pendingReq{session: s.id, ch: reply}
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
