// Wire-format contract: see docs/PDF_VIEWER.md#api
// State machine: see docs/PDF_VIEWER.md#state-machine
package handlers

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"

	"boardripper/databank"
	"boardripper/pdfindex"
)

type PdfIndexHandler struct {
	db   *pdfindex.DB
	ix   *pdfindex.Indexer
	bank *databank.DB
}

func NewPdfIndexHandler(db *pdfindex.DB, ix *pdfindex.Indexer, bank *databank.DB) *PdfIndexHandler {
	return &PdfIndexHandler{db: db, ix: ix, bank: bank}
}

func pathID(r *http.Request) (int64, error) {
	return strconv.ParseInt(r.PathValue("id"), 10, 64)
}

// GET /api/pdfindex/status/{id}
func (h *PdfIndexHandler) Status(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	st, err := h.db.Status(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if st.Status == "" {
		http.Error(w, "not indexed", http.StatusNotFound)
		return
	}
	writeJSON(w, st)
}

// GET /api/pdfindex/stats
func (h *PdfIndexHandler) Stats(w http.ResponseWriter, r *http.Request) {
	s, err := h.db.Stats()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, s)
}

// POST /api/pdfindex/run
func (h *PdfIndexHandler) Run(w http.ResponseWriter, r *http.Request) {
	if err := h.ix.Run(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, h.ix.Progress())
}

// POST /api/pdfindex/stop
func (h *PdfIndexHandler) Stop(w http.ResponseWriter, r *http.Request) {
	h.ix.Stop()
	writeJSON(w, h.ix.Progress())
}

// GET /api/pdfindex/progress
func (h *PdfIndexHandler) ProgressEndpoint(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, h.ix.Progress())
}

// POST /api/pdfindex/reindex
// POST /api/databank/reset-pdf — wipe all extracted PDF text + index status so
// the user can re-run extraction. Stops any running sweep first so workers
// don't write into a just-cleared DB.
func (h *PdfIndexHandler) ResetPdf(w http.ResponseWriter, r *http.Request) {
	h.ix.Stop()
	if err := h.db.ResetAll(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]string{"status": "reset"})
}

func (h *PdfIndexHandler) Reindex(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Scope string `json:"scope"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	n, err := h.db.ResetForReindex(body.Scope)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = h.ix.Run()
	writeJSON(w, map[string]interface{}{"reset": n, "running": true})
}

// POST /api/pdfindex/reindex-watermark — reset all terminal rows to pending +
// run so newly-added watermark terms are applied to previously-indexed files.
func (h *PdfIndexHandler) ReindexWatermark(w http.ResponseWriter, r *http.Request) {
	n, err := h.db.ResetForReindex("all")
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = h.ix.Run()
	writeJSON(w, map[string]interface{}{"reset": n, "running": true})
}

// POST /api/pdfindex/files/{id}/index — priority enqueue (backend fallback path)
func (h *PdfIndexHandler) PriorityIndex(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	st, _ := h.db.Status(id)
	if st.Status == "indexing" {
		http.Error(w, "already indexing", http.StatusConflict)
		return
	}
	_ = h.ix.Run()
	h.ix.Enqueue(id)
	writeJSON(w, map[string]string{"status": "queued"})
}

// POST /api/pdfindex/files/{id}/begin — fast-path claim
func (h *PdfIndexHandler) Begin(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	// Dedup: if this file is a non-canonical duplicate, never extract it via the
	// fast-path — mark it and 409 so its pages don't bloat the index. The
	// canonical carries the searchable text. (No-op until a dedup pass has
	// assigned content hashes.)
	if h.bank != nil {
		if hash, _ := h.bank.ContentHashOf(id); len(hash) > 0 {
			if canon, err := h.bank.CanonicalForHash(hash); err == nil && canon != 0 && canon != id {
				_ = h.db.MarkDuplicate(id, canon)
				http.Error(w, "duplicate", http.StatusConflict)
				return
			}
		}
	}
	won, err := h.db.Claim(id, "pdfjs")
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if !won {
		http.Error(w, "already claimed", http.StatusConflict)
		return
	}
	writeJSON(w, map[string]string{"status": "indexing"})
}

// PUT /api/pdfindex/files/{id}/pages — fast-path batch upload
func (h *PdfIndexHandler) Pages(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16<<20)
	var body struct {
		Pages []struct {
			N    int    `json:"n"`
			Text string `json:"text"`
		} `json:"pages"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad json: "+err.Error(), http.StatusBadRequest)
		return
	}
	pages := make([]pdfindex.Page, 0, len(body.Pages))
	for _, p := range body.Pages {
		pages = append(pages, pdfindex.Page{Num: p.N, Text: p.Text})
	}
	if err := h.db.UpsertPages(id, pages); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]int{"accepted": len(pages)})
}

// POST /api/pdfindex/files/{id}/finalize
func (h *PdfIndexHandler) Finalize(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	st, err := h.db.Finalize(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, st)
}

// POST /api/pdfindex/files/{id}/fail
func (h *PdfIndexHandler) FailEndpoint(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	var body struct {
		Error string `json:"error"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if err := h.db.Fail(id, body.Error); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]string{"status": "failed"})
}

// GET /api/pdfindex/failed
func (h *PdfIndexHandler) Failed(w http.ResponseWriter, r *http.Request) {
	rows, err := h.db.ListFailed()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if rows == nil {
		rows = []pdfindex.StatusRow{}
	}
	// Enrich each row with filename + path from the databank — pdfindex.db
	// doesn't ATTACH databank.db (single-writer disciplines diverge), so we
	// do it in Go like the search handler does. A row whose file id was
	// since deleted from databank just keeps empty filename/path.
	if h.bank != nil && len(rows) > 0 {
		ids := make([]int64, 0, len(rows))
		for _, r := range rows {
			ids = append(ids, r.FileID)
		}
		records, _ := h.bank.ListFilesByIDs(r.Context(), ids)
		byID := make(map[int64]databank.FileRecord, len(records))
		for _, rec := range records {
			byID[rec.ID] = rec
		}
		for i := range rows {
			if rec, ok := byID[rows[i].FileID]; ok {
				rows[i].Filename = rec.Filename
				rows[i].Path = rec.Path
			}
		}
	}
	writeJSON(w, rows)
}

// POST /api/pdfindex/index-folder  body: {"path": "some/prefix"}
func (h *PdfIndexHandler) IndexFolder(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path string `json:"path"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if err := h.ix.RunFolder(body.Path); err != nil {
		if errors.Is(err, pdfindex.ErrAlreadyRunning) {
			http.Error(w, "index already running", http.StatusConflict)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, h.ix.Progress())
}

// DELETE /api/pdfindex/files/{id}
func (h *PdfIndexHandler) Delete(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	if err := h.db.DeleteFile(id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]string{"status": "deleted"})
}

// GET /api/databank/search?q=...&scope=all|donor
func (h *PdfIndexHandler) Search(w http.ResponseWriter, r *http.Request) {
	if h.bank == nil {
		writeJSON(w, map[string]interface{}{"results": []interface{}{}, "total": 0, "query": ""})
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	scope := r.URL.Query().Get("scope")
	if q == "" {
		writeJSON(w, map[string]interface{}{"results": []interface{}{}, "total": 0, "query": q})
		return
	}
	var restrict []int64
	if scope == "donor" {
		ids, err := h.bank.DonorFileIDs()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if len(ids) == 0 {
			writeJSON(w, map[string]interface{}{"results": []interface{}{}, "total": 0, "query": q})
			return
		}
		restrict = ids
	}
	hits, err := h.db.SearchPages(q, restrict, 1000)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	seen := map[int64]bool{}
	var ids []int64
	for _, hh := range hits {
		if !seen[hh.FileID] {
			seen[hh.FileID] = true
			ids = append(ids, hh.FileID)
		}
	}
	meta, err := h.bank.SearchMeta(ids)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	// Resolve duplicate copy locations once per distinct file (bounded by the
	// ≤1000 hit LIMIT). A file with no content hash returns an empty slice.
	copies := make(map[int64][]string, len(ids))
	for _, id := range ids {
		paths, err := h.bank.CopyPathsForFile(id)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		copies[id] = paths
	}
	type result struct {
		pdfindex.SearchHit
		HitCount      int                     `json:"hit_count"`
		Filename      string                  `json:"filename"`
		Path          string                  `json:"path"`
		IsDonor       bool                    `json:"is_donor"`
		BoardBindings []databank.BoardBinding `json:"board_bindings"`
		Copies        []string                `json:"copies"`
	}
	// Collapse hits to ONE result per file (content group), regardless of how
	// many pages matched. A PDF that matches on 36 pages becomes a single row
	// with hit_count = 36, navigating to the lowest matching page. The group key
	// is FILE-level (content_hash, or "id:<fileID>" for a unique-size singleton)
	// so byte-identical duplicates also collapse together; the representative is
	// the lowest file_id in the group (deterministic, and the global canonical
	// when it is itself a match). Copies on each result list the other paths in
	// the group. Groups are emitted in first-seen order, preserving FTS rank.
	fileKey := func(fileID int64) string {
		if hx := meta[fileID].ContentHash; hx != "" {
			return hx
		}
		return "id:" + strconv.FormatInt(fileID, 10)
	}
	type group struct {
		repFile int64          // lowest file_id seen in the group
		pages   map[int]string // distinct matching page -> first snippet seen
		order   int            // first-seen index (FTS rank)
	}
	groups := make(map[string]*group, len(hits))
	var groupOrder []string
	for _, hh := range hits {
		k := fileKey(hh.FileID)
		g := groups[k]
		if g == nil {
			g = &group{repFile: hh.FileID, pages: make(map[int]string), order: len(groupOrder)}
			groups[k] = g
			groupOrder = append(groupOrder, k)
		}
		if hh.FileID < g.repFile {
			g.repFile = hh.FileID
		}
		if _, ok := g.pages[hh.PageNum]; !ok {
			g.pages[hh.PageNum] = hh.Snippet // first snippet seen for this page
		}
	}
	results := make([]result, 0, len(groupOrder))
	for _, k := range groupOrder {
		g := groups[k]
		lowestPage := 0
		for p := range g.pages {
			if lowestPage == 0 || p < lowestPage {
				lowestPage = p
			}
		}
		m := meta[g.repFile]
		results = append(results, result{
			SearchHit:     pdfindex.SearchHit{FileID: g.repFile, PageNum: lowestPage, Snippet: g.pages[lowestPage]},
			HitCount:      len(g.pages),
			Filename:      m.Filename,
			Path:          m.Path,
			IsDonor:       m.IsDonor,
			BoardBindings: m.Bindings,
			Copies:        copies[g.repFile],
		})
	}
	writeJSON(w, map[string]interface{}{"results": results, "total": len(results), "query": q})
}

// GET /api/databank/search/stream?q=...&scope=all|donor
//
// Streaming sibling of Search. Emits NDJSON (one JSON object per line):
//
//	{"type":"result", file_id, page_num, snippet, filename, path, is_donor, board_bindings, copies, hit_count}
//	{"type":"counts", "counts": {"<file_id>": N, ...}}
//	{"type":"done",   "total": <distinct file count>}
//
// One "result" line is emitted per file the moment the FTS cursor first surfaces
// it (so the frontend builds the list progressively), carrying that file's
// best-rank page/snippet for navigation. The terminal "counts" line lets the
// frontend correct each row's hit_count once the full cursor is drained. The
// copy-paths query is skipped for files with no content hash (unique-size
// singletons) — that's the cold-start optimization over Search's per-id N+1.
//
// Registered WITHOUT the read()/write() timeout wrappers so the http.Flusher is
// reachable and per-row flushes aren't held back by a 30s context deadline.
func (h *PdfIndexHandler) SearchStream(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-cache")
	f, _ := w.(http.Flusher)
	enc := json.NewEncoder(w)
	emit := func(obj interface{}) {
		_ = enc.Encode(obj)
		if f != nil {
			f.Flush()
		}
	}

	q := strings.TrimSpace(r.URL.Query().Get("q"))
	scope := r.URL.Query().Get("scope")
	if q == "" || h.bank == nil {
		emit(map[string]interface{}{"type": "done", "total": 0})
		return
	}

	var restrict []int64
	if scope == "donor" {
		ids, err := h.bank.DonorFileIDs()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if len(ids) == 0 {
			emit(map[string]interface{}{"type": "done", "total": 0})
			return
		}
		restrict = ids
	}

	seen := map[int64]int{}
	var order []int64

	err := h.db.SearchPagesStream(q, restrict, 1000, func(hit pdfindex.SearchHit) error {
		if _, ok := seen[hit.FileID]; ok {
			seen[hit.FileID]++
			return nil
		}
		// First time this file is surfaced: enrich + emit immediately. The
		// page_num/snippet captured here are the best-rank hit for the file.
		seen[hit.FileID] = 1
		order = append(order, hit.FileID)

		metaMap, merr := h.bank.SearchMeta([]int64{hit.FileID})
		if merr != nil {
			// Resilient: don't abort the whole stream on a single enrich hiccup.
			log.Printf("SearchStream: SearchMeta(%d): %v", hit.FileID, merr)
		}
		m := metaMap[hit.FileID]

		var cp []string
		if m.ContentHash != "" {
			paths, cerr := h.bank.CopyPathsForFile(hit.FileID)
			if cerr != nil {
				log.Printf("SearchStream: CopyPathsForFile(%d): %v", hit.FileID, cerr)
			} else {
				cp = paths
			}
		}
		if cp == nil {
			cp = []string{}
		}

		emit(map[string]interface{}{
			"type":           "result",
			"file_id":        hit.FileID,
			"page_num":       hit.PageNum,
			"snippet":        hit.Snippet,
			"filename":       m.Filename,
			"path":           m.Path,
			"is_donor":       m.IsDonor,
			"board_bindings": m.Bindings,
			"copies":         cp,
			"hit_count":      1,
		})
		return nil
	})
	if err != nil {
		// Surface a hard cursor error as a trailing line; headers/results may
		// already be on the wire so we can't switch to a clean 5xx.
		log.Printf("SearchStream: cursor error: %v", err)
		emit(map[string]interface{}{"type": "error", "error": err.Error()})
	}

	counts := make(map[string]int, len(order))
	for _, id := range order {
		counts[strconv.FormatInt(id, 10)] = seen[id]
	}
	emit(map[string]interface{}{"type": "counts", "counts": counts})
	emit(map[string]interface{}{"type": "done", "total": len(order)})
}
