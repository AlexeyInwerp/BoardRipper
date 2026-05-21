// Wire-format contract: see docs/PDF_VIEWER.md#api
// State machine: see docs/PDF_VIEWER.md#state-machine
package handlers

import (
	"encoding/json"
	"errors"
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
		Filename      string                  `json:"filename"`
		Path          string                  `json:"path"`
		IsDonor       bool                    `json:"is_donor"`
		BoardBindings []databank.BoardBinding `json:"board_bindings"`
		Copies        []string                `json:"copies"`
	}
	// Collapse byte-identical hits to one result per content group + page. This
	// honors the dedup contract even when duplicates were indexed individually
	// (before a dedup pass) and still hold their own pdf_pages rows. The group
	// key is the content_hash (or "id:<fileID>" for a singleton) plus page; the
	// representative is the lowest file_id in the group (deterministic, and the
	// global canonical when it is itself a match). Copies on each result list
	// the other paths in the group.
	groupKey := func(fileID int64, page int) string {
		if hx := meta[fileID].ContentHash; hx != "" {
			return hx + "#" + strconv.Itoa(page)
		}
		return "id:" + strconv.FormatInt(fileID, 10) + "#" + strconv.Itoa(page)
	}
	rep := make(map[string]int64, len(hits)) // group key -> lowest file_id seen
	for _, hh := range hits {
		k := groupKey(hh.FileID, hh.PageNum)
		if cur, ok := rep[k]; !ok || hh.FileID < cur {
			rep[k] = hh.FileID
		}
	}
	results := make([]result, 0, len(hits))
	emitted := make(map[string]bool, len(hits))
	for _, hh := range hits {
		k := groupKey(hh.FileID, hh.PageNum)
		if rep[k] != hh.FileID || emitted[k] {
			continue // not the representative for this group+page, or already shown
		}
		emitted[k] = true
		m := meta[hh.FileID]
		results = append(results, result{
			SearchHit:     hh,
			Filename:      m.Filename,
			Path:          m.Path,
			IsDonor:       m.IsDonor,
			BoardBindings: m.Bindings,
			Copies:        copies[hh.FileID],
		})
	}
	writeJSON(w, map[string]interface{}{"results": results, "total": len(results), "query": q})
}
