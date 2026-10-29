package pdfindex

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Search design (2026-10-29, docs/specs/2026-10-14-pdf-index-search-review.md):
//
// The query used to be `… MATCH ? ORDER BY rank LIMIT 1000`. FTS5 has to score
// every matching page before it can return the first one, and on a schematic
// corpus a term like 10UF, 25V or PP3V3 matches nearly every page — the cost
// was the size of the index, not of the answer: 96 s for "10UF 25V" on a
// 1.9 M-page NAS index, single letters never returned. The page rank was never
// shown (the UI lists one row per file), so it is not paid for any more.
//
// A search now walks the matches in rowid order — FTS5's native order, free —
// in chunks of searchChunk rows. Each chunk is a separate statement resumed
// with `rowid > last`, so the cursor is closed between chunks: the snippet
// lookups for the chunk's new files run on the same connection, the context
// is checked, and a search never holds two connections of the reader pool.
// It stops at MaxFiles distinct files, MaxPages matching pages or Deadline,
// whichever comes first, and says so (Partial). Snippets are built in Go from
// the page text of the first page shown per file only.
//
// Donor scope is a filter on pdf_pages.file_id after the FTS5 scan, through
// json_each (no 32,766-variable ceiling). The old `pdf_text.rowid IN
// (subselect)` made FTS5 probe one rowid at a time: 87 s for 2,000 donors.

// ErrQueryTooShort is returned when no search term has at least
// MinTermLength letters or digits.
var ErrQueryTooShort = errors.New("search terms must have at least 2 letters or digits")

// MinTermLength is the shortest term searched. A one-character prefix term
// expands to every token starting with that character — the whole index.
const MinTermLength = 2

// SearchOptions bounds one search. Zero fields take the defaults.
type SearchOptions struct {
	MaxFiles int           // distinct files reported (default 500)
	MaxPages int           // matching pages read (default 50,000)
	Deadline time.Duration // wall-clock budget (default 10 s)
}

func (o SearchOptions) withDefaults() SearchOptions {
	if o.MaxFiles <= 0 {
		o.MaxFiles = 500
	}
	if o.MaxPages <= 0 {
		o.MaxPages = 50_000
	}
	if o.Deadline <= 0 {
		o.Deadline = 10 * time.Second
	}
	return o
}

// searchChunk is how many matching pages one statement returns.
const searchChunk = 2000

// SearchHit is one matching page.
type SearchHit struct {
	FileID  int64  `json:"file_id"`
	PageNum int    `json:"page_num"`
	Snippet string `json:"snippet"`
}

// SearchSummary describes a finished search.
type SearchSummary struct {
	// Counts holds matching pages per reported file. Exact unless Partial.
	Counts map[int64]int
	// Order lists reported files in the order they were found.
	Order []int64
	// Pages is how many matching pages were read.
	Pages int
	// Partial is true when a cap or the deadline stopped the search before
	// every match was read; Reason names which ("files", "pages", "time").
	Partial bool
	Reason  string
	// Ignored lists query terms dropped as too short.
	Ignored []string
}

// SearchFiles runs one search and calls onFile once per file, the first time
// a page of it matches, with that page and its snippet. If onFile returns an
// error the search stops and returns it. A cancelled ctx stops it too (and
// interrupts the statement in flight).
func (db *DB) SearchFiles(ctx context.Context, query string, restrictTo []int64, opt SearchOptions,
	onFile func(SearchHit) error) (SearchSummary, error) {
	opt = opt.withDefaults()
	q := parseQuery(query)
	sum := SearchSummary{Counts: map[int64]int{}, Ignored: q.ignored}
	if q.fts == "" {
		if len(q.ignored) > 0 {
			return sum, ErrQueryTooShort
		}
		return sum, nil
	}

	sctx, cancel := context.WithTimeout(ctx, opt.Deadline)
	defer cancel()
	conn, err := db.r().Conn(sctx)
	if err != nil {
		return sum, deadlineOr(ctx, sctx, err, &sum)
	}
	defer conn.Close()

	stmt := `SELECT p.rowid, p.file_id, p.page_num
		FROM pdf_text CROSS JOIN pdf_pages AS p ON p.rowid = pdf_text.rowid
		WHERE pdf_text MATCH ?1 AND pdf_text.rowid > ?2`
	args := []any{q.fts, int64(0)}
	if len(restrictTo) > 0 {
		ids, _ := json.Marshal(restrictTo)
		stmt += ` AND p.file_id IN (SELECT value FROM json_each(?3))`
		args = append(args, string(ids))
	}
	stmt += ` ORDER BY pdf_text.rowid LIMIT ` + strconv.Itoa(searchChunk)

	type row struct {
		rowid, fileID int64
		page          int
	}
	chunk := make([]row, 0, searchChunk)
	var last int64
	for {
		args[1] = last
		chunk = chunk[:0]
		rows, err := conn.QueryContext(sctx, stmt, args...)
		if err != nil {
			return sum, deadlineOr(ctx, sctx, err, &sum)
		}
		for rows.Next() {
			var r row
			if err := rows.Scan(&r.rowid, &r.fileID, &r.page); err != nil {
				rows.Close()
				return sum, err
			}
			chunk = append(chunk, r)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return sum, deadlineOr(ctx, sctx, err, &sum)
		}

		for _, r := range chunk {
			last = r.rowid
			sum.Pages++
			if _, seen := sum.Counts[r.fileID]; seen {
				sum.Counts[r.fileID]++
			} else if len(sum.Order) < opt.MaxFiles {
				sum.Counts[r.fileID] = 1
				sum.Order = append(sum.Order, r.fileID)
				hit := SearchHit{FileID: r.fileID, PageNum: r.page,
					Snippet: pageSnippet(sctx, conn, r.rowid, q.tokens)}
				if err := onFile(hit); err != nil {
					return sum, err
				}
			} else if !sum.Partial {
				// Past the file cap: keep counting the files already shown
				// (their counts stay exact until another cap ends the scan).
				sum.Partial, sum.Reason = true, "files"
			}
			if sum.Pages >= opt.MaxPages {
				sum.Partial, sum.Reason = true, "pages"
				return sum, nil
			}
		}
		if len(chunk) < searchChunk {
			return sum, nil // every match read
		}
		if err := sctx.Err(); err != nil {
			return sum, deadlineOr(ctx, sctx, err, &sum)
		}
	}
}

// deadlineOr turns the search's own deadline into a partial result; a
// cancelled caller (client gone) or any other error is returned as is.
func deadlineOr(parent, sctx context.Context, err error, sum *SearchSummary) error {
	// The driver may report the deadline (context.DeadlineExceeded, or
	// SQLite's "interrupted") a moment before sctx itself is marked done; on
	// the NAS every search ended with a raw "context deadline exceeded"
	// error instead of the partial result.
	deadline := sctx.Err() != nil || errors.Is(err, context.DeadlineExceeded) ||
		(err != nil && strings.Contains(err.Error(), "interrupted"))
	if parent.Err() == nil && deadline {
		sum.Partial, sum.Reason = true, "time"
		return nil
	}
	if parent.Err() != nil {
		return parent.Err()
	}
	return err
}

// SearchPages returns up to limit matching pages (not collapsed per file),
// each with its own snippet. Used by the MCP pdf_search tool, which reports
// pages. Same scan and bounds as SearchFiles.
func (db *DB) SearchPages(ctx context.Context, query string, restrictTo []int64, limit int) ([]SearchHit, error) {
	if limit <= 0 {
		limit = 200
	}
	q := parseQuery(query)
	if q.fts == "" {
		if len(q.ignored) > 0 {
			return nil, ErrQueryTooShort
		}
		return []SearchHit{}, nil
	}
	sctx, cancel := context.WithTimeout(ctx, SearchOptions{}.withDefaults().Deadline)
	defer cancel()
	conn, err := db.r().Conn(sctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	stmt := `SELECT p.rowid, p.file_id, p.page_num
		FROM pdf_text CROSS JOIN pdf_pages AS p ON p.rowid = pdf_text.rowid
		WHERE pdf_text MATCH ?1`
	args := []any{q.fts}
	if len(restrictTo) > 0 {
		ids, _ := json.Marshal(restrictTo)
		stmt += ` AND p.file_id IN (SELECT value FROM json_each(?2))`
		args = append(args, string(ids))
	}
	stmt += ` ORDER BY pdf_text.rowid LIMIT ` + strconv.Itoa(limit)
	rows, err := conn.QueryContext(sctx, stmt, args...)
	if err != nil {
		return nil, err
	}
	type row struct {
		rowid int64
		hit   SearchHit
	}
	var found []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.rowid, &r.hit.FileID, &r.hit.PageNum); err != nil {
			rows.Close()
			return nil, err
		}
		found = append(found, r)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	out := make([]SearchHit, 0, len(found))
	for _, r := range found {
		r.hit.Snippet = pageSnippet(sctx, conn, r.rowid, q.tokens)
		out = append(out, r.hit)
	}
	return out, nil
}

// parsedQuery is a user query turned into an FTS5 expression plus the
// lowercase tokens used to highlight snippets.
type parsedQuery struct {
	fts     string
	tokens  []string
	ignored []string
}

// parseQuery converts each whitespace-separated term to a quoted FTS5 PREFIX
// term ("term"*), implicitly ANDed. Prefix matching is essential for partial
// part numbers: "AOZ5332" must match the token "AOZ5332QI". Terms with fewer
// than MinTermLength letters/digits are dropped and reported.
func parseQuery(query string) parsedQuery {
	var pq parsedQuery
	var quoted []string
	for _, t := range strings.Fields(query) {
		t = strings.Trim(t, `"'`)
		if t == "" {
			continue
		}
		toks := tokenize(t)
		longest := 0
		for _, tk := range toks {
			if n := utf8.RuneCountInString(tk); n > longest {
				longest = n
			}
		}
		if longest < MinTermLength {
			pq.ignored = append(pq.ignored, t)
			continue
		}
		for _, tk := range toks {
			if utf8.RuneCountInString(tk) >= MinTermLength {
				pq.tokens = append(pq.tokens, tk)
			}
		}
		quoted = append(quoted, `"`+strings.ReplaceAll(t, `"`, `""`)+`"*`)
	}
	pq.fts = strings.Join(quoted, " ")
	return pq
}

// tokenize splits s into lowercase runs of letters and digits — the same
// boundaries FTS5's unicode61 tokenizer uses (`_`, `.`, `-` separate).
func tokenize(s string) []string {
	var out []string
	for _, span := range tokenSpans(s) {
		out = append(out, strings.ToLower(s[span[0]:span[1]]))
	}
	return out
}

func tokenSpans(s string) [][2]int {
	var spans [][2]int
	start := -1
	for i, r := range s {
		alnum := unicode.IsLetter(r) || unicode.IsDigit(r)
		switch {
		case alnum && start < 0:
			start = i
		case !alnum && start >= 0:
			spans = append(spans, [2]int{start, i})
			start = -1
		}
	}
	if start >= 0 {
		spans = append(spans, [2]int{start, len(s)})
	}
	return spans
}

// pageSnippet reads one page's text and returns a window of it around the
// first match, matches wrapped in <b>…</b> (the delimiters the Library
// renders; the text itself is never HTML). Empty on any error.
func pageSnippet(ctx context.Context, conn *sql.Conn, rowid int64, tokens []string) string {
	var text string
	if err := conn.QueryRowContext(ctx, `SELECT text_content FROM pdf_pages WHERE rowid = ?`, rowid).Scan(&text); err != nil {
		return ""
	}
	return makeSnippet(text, tokens, 32)
}

// makeSnippet cuts a window of at most width tokens out of text, starting a
// little before the first token that begins with any of the query tokens,
// and bolds every such token in the window. With no literal match (FTS5
// matched a stemmed form) the window is the start of the page.
func makeSnippet(text string, tokens []string, width int) string {
	spans := tokenSpans(text)
	if len(spans) == 0 {
		return ""
	}
	matches := func(sp [2]int) bool {
		w := strings.ToLower(text[sp[0]:sp[1]])
		for _, t := range tokens {
			if strings.HasPrefix(w, t) {
				return true
			}
		}
		return false
	}
	first := 0
	for i, sp := range spans {
		if matches(sp) {
			first = i
			break
		}
	}
	from := first - width/4
	if from < 0 {
		from = 0
	}
	to := from + width
	if to > len(spans) {
		to = len(spans)
	}
	var b strings.Builder
	if from > 0 {
		b.WriteString("...")
	}
	pos := spans[from][0]
	for _, sp := range spans[from:to] {
		b.WriteString(collapseSpace(text[pos:sp[0]]))
		if matches(sp) {
			b.WriteString("<b>" + text[sp[0]:sp[1]] + "</b>")
		} else {
			b.WriteString(text[sp[0]:sp[1]])
		}
		pos = sp[1]
	}
	if to < len(spans) {
		b.WriteString("...")
	}
	return b.String()
}

// collapseSpace turns every run of whitespace into one space, keeping the
// other separators (`_`, `-`, `.`) as they are.
func collapseSpace(s string) string {
	var b strings.Builder
	space := false
	for _, r := range s {
		if unicode.IsSpace(r) {
			if !space {
				b.WriteByte(' ')
			}
			space = true
			continue
		}
		space = false
		b.WriteRune(r)
	}
	return b.String()
}
