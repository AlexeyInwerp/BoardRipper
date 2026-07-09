package mcpserver

import (
	"testing"
	"testing/fstest"
)

func TestLoadKB(t *testing.T) {
	chunks := loadKB()
	if len(chunks) < 6 {
		t.Fatalf("want >=6 chunks, got %d", len(chunks))
	}
	byID := map[string]kbChunk{}
	for _, c := range chunks {
		if c.ID == "" || c.Title == "" || c.Body == "" {
			t.Fatalf("chunk missing id/title/body: %+v", c)
		}
		byID[c.ID] = c
	}
	m, ok := byID["diode-mode-usage"]
	if !ok {
		t.Fatal("missing diode-mode-usage chunk")
	}
	if m.Status != "authoritative" {
		t.Fatalf("diode-mode-usage status = %q, want authoritative", m.Status)
	}
	wantTag := false
	for _, tg := range m.Tags {
		if tg == "diode" {
			wantTag = true
		}
	}
	if !wantTag {
		t.Fatalf("diode-mode-usage tags missing 'diode': %v", m.Tags)
	}
}

func TestLoadChunksFromFS_SkipsBad(t *testing.T) {
	good := "---\nid: ok\ntitle: Good\ntags: [x]\nstatus: draft\n---\nbody text"
	bad := "no frontmatter here"
	fsys := fstest.MapFS{
		"kb/ok.md":  {Data: []byte(good)},
		"kb/bad.md": {Data: []byte(bad)},
	}
	chunks := loadChunksFromFS(fsys, "kb")
	if len(chunks) != 1 || chunks[0].ID != "ok" {
		t.Fatalf("want 1 good chunk, got %d: %+v", len(chunks), chunks)
	}
}

func TestSnippetOf_RuneSafe(t *testing.T) {
	s := snippetOf("ΩΩΩΩΩ", 3) // 5 two-byte runes, cap 3
	if s != "ΩΩΩ…" {
		t.Fatalf("snippetOf split a rune: %q", s)
	}
}

func TestSearchKB(t *testing.T) {
	chunks := loadKB()
	hits := searchKB(chunks, "diode mode on a power rail", nil, 3)
	if len(hits) == 0 {
		t.Fatal("no hits")
	}
	// the diode-mode guidance should rank at the top for this query.
	if hits[0].ID != "diode-mode-usage" && hits[0].ID != "diode-mode-why" {
		t.Fatalf("top hit = %q, want a diode-mode chunk", hits[0].ID)
	}
	// tag filter narrows results.
	safety := searchKB(chunks, "measurement", []string{"safety"}, 5)
	for _, h := range safety {
		found := false
		for _, tg := range h.Tags {
			if tg == "safety" {
				found = true
			}
		}
		if !found {
			t.Fatalf("tag filter leaked non-safety chunk %q", h.ID)
		}
	}
}
