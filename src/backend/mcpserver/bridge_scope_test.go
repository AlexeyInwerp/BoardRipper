package mcpserver

import (
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func TestBridge_ScopedPick(t *testing.T) {
	b := NewBridge()
	b.register("a1", json.RawMessage(`{"name":"A"}`), "alex", "Alex")
	time.Sleep(2 * time.Millisecond)
	b.register("m1", json.RawMessage(`{"name":"M"}`), "marc", "Marc")

	// marc's page registered last (freshest focus); an alex-scoped default
	// must still land on alex's page.
	s, err := b.pick("", Scope{ClientID: "alex"})
	if err != nil || s.id != "a1" {
		t.Fatalf("alex default pick = %v, %v; want a1", s, err)
	}
	// Shared default = install-wide most recent = m1 (today's behavior).
	s, err = b.pick("", Scope{})
	if err != nil || s.id != "m1" {
		t.Fatalf("shared default pick = %v, %v; want m1", s, err)
	}
	// Explicit foreign session refused for a scoped caller.
	if _, err = b.pick("m1", Scope{ClientID: "alex"}); !errors.Is(err, errForeignSession) {
		t.Fatalf("foreign explicit pick err = %v, want errForeignSession", err)
	}
	// Unknown explicit id for a scoped caller: same error (no existence leak).
	if _, err = b.pick("zz", Scope{ClientID: "alex"}); !errors.Is(err, errForeignSession) {
		t.Fatalf("unknown explicit (scoped) err = %v", err)
	}
	// Shared caller may address anyone explicitly.
	if s, err = b.pick("m1", Scope{}); err != nil || s.id != "m1" {
		t.Fatalf("shared explicit pick = %v, %v", s, err)
	}
	// Shared caller, unknown id.
	if _, err = b.pick("zz", Scope{}); !errors.Is(err, errUnknownSession) {
		t.Fatalf("unknown explicit (shared) err = %v", err)
	}
	// Scoped caller whose browser has no connected page.
	if _, err = b.pick("", Scope{ClientID: "nobody"}); !errors.Is(err, errNoPairedPage) {
		t.Fatalf("no-paired-page err = %v", err)
	}
}

func TestBridge_ReRegisterKeepsFocus(t *testing.T) {
	b := NewBridge()
	b.register("a1", json.RawMessage(`{}`), "alex", "Alex")
	b.register("b1", json.RawMessage(`{}`), "marc", "Marc")
	b.touchFocus("a1") // user is actively working in a1
	time.Sleep(2 * time.Millisecond)
	// b1's socket bounces (10-min idle read timeout → reconnect). The
	// re-register must carry the old focus recency, not reset it to now.
	b.register("b1", json.RawMessage(`{}`), "marc", "Marc")
	s, err := b.pick("", Scope{})
	if err != nil || s.id != "a1" {
		t.Fatalf("re-register stole the focus default: pick = %v, %v; want a1", s, err)
	}
}

func TestBridge_SessionsScoped(t *testing.T) {
	b := NewBridge()
	b.register("a1", json.RawMessage(`{"name":"A"}`), "alex", "Alex")
	b.register("m1", json.RawMessage(`{"name":"M"}`), "marc", "Marc")

	all := b.Sessions(Scope{})
	if len(all) != 2 {
		t.Fatalf("shared Sessions = %d entries, want 2", len(all))
	}
	mine := b.Sessions(Scope{ClientID: "alex"})
	if len(mine) != 1 {
		t.Fatalf("scoped Sessions = %d entries, want 1", len(mine))
	}
	si := mine[0]
	if si.ClientID != "alex" || si.ClientLabel != "Alex" {
		t.Fatalf("SessionInfo client = %q/%q", si.ClientID, si.ClientLabel)
	}
	if si.FocusedAtMs <= 0 {
		t.Fatal("SessionInfo missing FocusedAtMs")
	}
	if string(si.Board) != `{"name":"A"}` {
		t.Fatalf("SessionInfo board = %s", si.Board)
	}
}
