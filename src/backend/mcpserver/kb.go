package mcpserver

import (
	"embed"
	"fmt"
	"sort"
	"strings"
)

//go:embed kb/*.md
var kbFS embed.FS

type kbChunk struct {
	ID        string   `json:"id"`
	Title     string   `json:"title"`
	Tags      []string `json:"tags"`
	AppliesTo []string `json:"applies_to"`
	Status    string   `json:"status"`
	Body      string   `json:"body"`
}

// loadKB parses every embedded kb/*.md chunk once.
func loadKB() ([]kbChunk, error) {
	entries, err := kbFS.ReadDir("kb")
	if err != nil {
		return nil, err
	}
	var out []kbChunk
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		raw, err := kbFS.ReadFile("kb/" + e.Name())
		if err != nil {
			return nil, err
		}
		c, err := parseChunk(string(raw))
		if err != nil {
			return nil, fmt.Errorf("%s: %w", e.Name(), err)
		}
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// parseChunk splits leading ---frontmatter--- from the markdown body.
func parseChunk(raw string) (kbChunk, error) {
	s := strings.TrimLeft(raw, "\uFEFF \t\r\n")
	if !strings.HasPrefix(s, "---") {
		return kbChunk{}, fmt.Errorf("no frontmatter")
	}
	rest := s[3:]
	end := strings.Index(rest, "\n---")
	if end < 0 {
		return kbChunk{}, fmt.Errorf("unterminated frontmatter")
	}
	front := rest[:end]
	body := strings.TrimLeft(rest[end+4:], "\r\n")
	c := kbChunk{Body: strings.TrimSpace(body)}
	for _, line := range strings.Split(front, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		k = strings.TrimSpace(k)
		v = strings.TrimSpace(v)
		switch k {
		case "id":
			c.ID = v
		case "title":
			c.Title = v
		case "status":
			c.Status = v
		case "tags":
			c.Tags = parseList(v)
		case "applies_to":
			c.AppliesTo = parseList(v)
		}
	}
	if c.ID == "" || c.Title == "" {
		return kbChunk{}, fmt.Errorf("missing id or title")
	}
	return c, nil
}

func parseList(v string) []string {
	v = strings.TrimSpace(v)
	v = strings.TrimPrefix(v, "[")
	v = strings.TrimSuffix(v, "]")
	var out []string
	for _, p := range strings.Split(v, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// searchKB scores chunks by query-term hits (title×3, tags×2, body×1),
// optionally filtered to chunks carrying ALL given tags, and returns the top k.
func searchKB(chunks []kbChunk, query string, tags []string, k int) []kbChunk {
	if k <= 0 || k > 50 {
		k = 5
	}
	terms := strings.Fields(strings.ToLower(query))
	type scored struct {
		c     kbChunk
		score int
	}
	var ranked []scored
	for _, c := range chunks {
		if !hasAllTags(c, tags) {
			continue
		}
		title := strings.ToLower(c.Title)
		tagStr := strings.ToLower(strings.Join(c.Tags, " "))
		body := strings.ToLower(c.Body)
		score := 0
		for _, t := range terms {
			score += 3 * strings.Count(title, t)
			score += 2 * strings.Count(tagStr, t)
			score += strings.Count(body, t)
		}
		if score > 0 || len(terms) == 0 {
			ranked = append(ranked, scored{c, score})
		}
	}
	sort.SliceStable(ranked, func(i, j int) bool {
		if ranked[i].score != ranked[j].score {
			return ranked[i].score > ranked[j].score
		}
		return ranked[i].c.ID < ranked[j].c.ID
	})
	out := make([]kbChunk, 0, k)
	for i := 0; i < len(ranked) && i < k; i++ {
		out = append(out, ranked[i].c)
	}
	return out
}

func hasAllTags(c kbChunk, tags []string) bool {
	for _, want := range tags {
		want = strings.ToLower(strings.TrimSpace(want))
		if want == "" {
			continue
		}
		found := false
		for _, have := range c.Tags {
			if strings.ToLower(have) == want {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
