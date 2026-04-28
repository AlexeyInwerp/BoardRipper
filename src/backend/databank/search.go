package databank

import (
	"context"
	"fmt"
	"strings"
)

// SearchResult represents a single search hit in a PDF page.
type SearchResult struct {
	FileID        int64          `json:"file_id"`
	Filename      string         `json:"filename"`
	Path          string         `json:"path"`
	PageNum       int            `json:"page_num"`
	Snippet       string         `json:"snippet"`
	BoardBindings []BoardBinding `json:"board_bindings"`
}

// BoardBinding is a board file linked to a PDF search result.
type BoardBinding struct {
	BoardFileID   int64  `json:"board_file_id"`
	BoardFilename string `json:"board_filename"`
	DonorPool     bool   `json:"donor_pool"`
}

// SearchResponse wraps search results with metadata.
type SearchResponse struct {
	Results []SearchResult `json:"results"`
	Total   int            `json:"total"`
	Query   string         `json:"query"`
}

// Search performs a full-text search across all indexed PDF pages.
// Supports multi-term queries (all terms must match).
// If donorOnly is true, only returns results from PDFs bound to donor-pool boards.
func (db *DB) Search(ctx context.Context, query string, donorOnly bool) (*SearchResponse, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return &SearchResponse{Results: []SearchResult{}, Query: query}, nil
	}

	// Build FTS5 query: each word becomes a term, all must match
	ftsQuery := buildFTS5Query(query)

	// Query FTS5 with snippet extraction
	sqlQuery := `
		SELECT pt.file_id, pt.page_num, snippet(pdf_text, 2, '<b>', '</b>', '...', 32) as snippet,
		       f.filename, f.path
		FROM pdf_text pt
		JOIN files f ON f.id = pt.file_id
		WHERE pdf_text MATCH ?
		ORDER BY rank
		LIMIT 1000
	`

	rows, err := db.reader.QueryContext(ctx, sqlQuery, ftsQuery)
	if err != nil {
		return nil, fmt.Errorf("search query failed: %w", err)
	}
	defer rows.Close()

	var results []SearchResult
	for rows.Next() {
		var r SearchResult
		if err := rows.Scan(&r.FileID, &r.PageNum, &r.Snippet, &r.Filename, &r.Path); err != nil {
			return nil, err
		}
		results = append(results, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Enrich with board bindings
	for i := range results {
		bindings, err := db.getSearchBindings(results[i].FileID)
		if err == nil {
			results[i].BoardBindings = bindings
		}
	}

	// Filter by donor pool if requested
	if donorOnly {
		filtered := make([]SearchResult, 0, len(results))
		for _, r := range results {
			hasDonor := false
			for _, b := range r.BoardBindings {
				if b.DonorPool {
					hasDonor = true
					break
				}
			}
			if hasDonor {
				filtered = append(filtered, r)
			}
		}
		results = filtered
	}

	if results == nil {
		results = []SearchResult{}
	}

	return &SearchResponse{
		Results: results,
		Total:   len(results),
		Query:   query,
	}, nil
}

// buildFTS5Query converts a user query into an FTS5 match expression.
// Multi-term queries use AND — all terms must appear on the same page.
// This acts as a broad filter; the PDF viewer's spatial proximity search
// provides precise column-based matching when the user opens a result.
// "10UF 25V 0603" -> "10UF" AND "25V" AND "0603"
// "connector"     -> "connector"
func buildFTS5Query(query string) string {
	// Split on whitespace
	terms := strings.Fields(query)
	if len(terms) == 0 {
		return query
	}

	// Wrap each term in quotes to handle special characters in part numbers
	quoted := make([]string, 0, len(terms))
	for _, t := range terms {
		// Remove any existing quotes
		t = strings.Trim(t, `"'`)
		if t == "" {
			continue
		}
		// Escape embedded double quotes for FTS5 (double them)
		t = strings.ReplaceAll(t, `"`, `""`)
		// Quote the term for FTS5
		quoted = append(quoted, `"`+t+`"`)
	}

	if len(quoted) == 1 {
		return quoted[0]
	}

	// All terms must appear on the page (AND).
	// FTS5 implicit AND: just space-separate quoted terms.
	return strings.Join(quoted, " ")
}

// getSearchBindings returns board bindings for a PDF file, enriched with donor status.
func (db *DB) getSearchBindings(pdfFileID int64) ([]BoardBinding, error) {
	rows, err := db.reader.Query(`
		SELECT b.board_file_id, f.filename, f.donor_pool
		FROM bindings b
		JOIN files f ON f.id = b.board_file_id
		WHERE b.pdf_file_id = ?
	`, pdfFileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var bindings []BoardBinding
	for rows.Next() {
		var b BoardBinding
		var donor int
		if err := rows.Scan(&b.BoardFileID, &b.BoardFilename, &donor); err != nil {
			return nil, err
		}
		b.DonorPool = donor != 0
		bindings = append(bindings, b)
	}

	if bindings == nil {
		bindings = []BoardBinding{}
	}
	return bindings, rows.Err()
}
