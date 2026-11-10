package worklists

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func doc(t *testing.T, raw json.RawMessage) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestPutGetListAndRevisions(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := s.Put("wl-1", []byte(`{"id":"wl-1","rev":0,"name":"No power","board":"820-02016"}`))
	if err != nil {
		t.Fatal(err)
	}
	d := doc(t, raw)
	if d["rev"].(float64) != 1 || d["name"] != "No power" || d["updatedAt"].(float64) <= 0 {
		t.Fatalf("stored doc = %v", d)
	}
	// The file is the document, byte for byte.
	onDisk, _ := os.ReadFile(filepath.Join(dir, "wl-1.json"))
	if string(onDisk) != string(raw) {
		t.Fatalf("disk %s != returned %s", onDisk, raw)
	}
	// A stale rev is a conflict and returns the server's copy.
	srv, err := s.Put("wl-1", []byte(`{"id":"wl-1","rev":0,"name":"other"}`))
	if !errors.Is(err, ErrConflict) || doc(t, srv)["name"] != "No power" {
		t.Fatalf("want conflict with server copy, got %v %s", err, srv)
	}
	// The right rev goes through and bumps it.
	raw, err = s.Put("wl-1", []byte(`{"id":"wl-1","rev":1,"name":"No power v2"}`))
	if err != nil || doc(t, raw)["rev"].(float64) != 2 {
		t.Fatalf("second put: %v %s", err, raw)
	}
	// A reopened store sees the same.
	s2, _ := Open(dir)
	g, err := s2.Get("wl-1")
	if err != nil || doc(t, g)["name"] != "No power v2" {
		t.Fatalf("reopen: %v %s", err, g)
	}
	// No temp files are left behind.
	ents, _ := os.ReadDir(dir)
	for _, e := range ents {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Fatalf("temp file left: %s", e.Name())
		}
	}
}

func TestSinceIsStrictlyIncreasing(t *testing.T) {
	s, _ := Open(t.TempDir())
	fixed := time.UnixMilli(1_000_000)
	s.now = func() time.Time { return fixed }
	a, _ := s.Put("a", []byte(`{"id":"a","rev":0}`))
	b, _ := s.Put("a", []byte(`{"id":"a","rev":1}`))
	ua, ub := doc(t, a)["updatedAt"].(float64), doc(t, b)["updatedAt"].(float64)
	if ub <= ua {
		t.Fatalf("updatedAt did not advance on a frozen clock: %v then %v", ua, ub)
	}
	docs, _ := s.List(int64(ua))
	if len(docs) != 1 {
		t.Fatalf("since=%v returned %d docs, want the later write", ua, len(docs))
	}
}

func TestDeleteIsATombstoneThenTrash(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir)
	s.Put("wl-x", []byte(`{"id":"wl-x","rev":0,"name":"gone"}`))
	if _, err := s.Delete("wl-x", 7); !errors.Is(err, ErrConflict) {
		t.Fatalf("delete with a stale rev: %v", err)
	}
	raw, err := s.Delete("wl-x", 1)
	if err != nil || doc(t, raw)["deleted"] == nil || doc(t, raw)["name"] != "gone" {
		t.Fatalf("tombstone: %v %s", err, raw)
	}
	// Other clients learn about it through List.
	docs, _ := s.List(0)
	if len(docs) != 1 || doc(t, docs[0])["deleted"] == nil {
		t.Fatalf("list after delete = %s", docs)
	}
	// After the TTL it moves to .trash at start-up.
	later, _ := openAt(dir, func() time.Time { return time.Now().Add(TombstoneTTL + time.Hour) })
	if _, err := later.Get("wl-x"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expired tombstone still live: %v", err)
	}
	trash, _ := os.ReadDir(filepath.Join(dir, ".trash"))
	if len(trash) != 1 {
		t.Fatalf("trash has %d files", len(trash))
	}
}

func TestRejectsBadIDsAndMismatchedBodies(t *testing.T) {
	s, _ := Open(t.TempDir())
	if _, err := s.Put("../evil", []byte(`{"id":"../evil"}`)); err == nil {
		t.Fatal("path traversal id accepted")
	}
	if _, err := s.Put("a", []byte(`{"id":"b","rev":0}`)); err == nil {
		t.Fatal("id mismatch accepted")
	}
	if _, err := s.Put("a", []byte(`not json`)); err == nil {
		t.Fatal("non-JSON accepted")
	}
}

func TestHandlerRoundTrip(t *testing.T) {
	s, _ := Open(t.TempDir())
	h := &Handler{Store: s}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/worklists", h.List)
	mux.HandleFunc("PUT /api/worklists/{id}", h.Put)
	mux.HandleFunc("DELETE /api/worklists/{id}", h.Delete)
	put := func(body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("PUT", "/api/worklists/w1", strings.NewReader(body))
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, r)
		return rec
	}
	if rec := put(`{"id":"w1","rev":0,"name":"A"}`); rec.Code != 200 {
		t.Fatalf("put = %d %s", rec.Code, rec.Body)
	}
	if rec := put(`{"id":"w1","rev":0,"name":"B"}`); rec.Code != 409 || !strings.Contains(rec.Body.String(), `"name":"A"`) {
		t.Fatalf("conflict = %d %s", rec.Code, rec.Body)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("GET", "/api/worklists?since=0", nil))
	var list struct {
		Docs []map[string]any `json:"docs"`
		Now  int64            `json:"now"`
	}
	if json.Unmarshal(rec.Body.Bytes(), &list) != nil || len(list.Docs) != 1 || list.Now == 0 {
		t.Fatalf("list = %s", rec.Body)
	}
}
