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
	st, err := h.db.StatusContext(r.Context(), id)
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
	s, err := h.db.Stats(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, s)
}

// POST /api/pdfindex/run
func (h *PdfIndexHandler) Run(w http.ResponseWriter, r *http.Request) {
	if err := h.ix.RequestRun(); err != nil {
		writeRunError(w, err)
		return
	}
	writeJSON(w, h.ix.Progress())
}

// writeRunError answers a sweep start that could not happen. An extractor
// that failed to initialise is the server's state, not a bad request: 503
// with the reason, which the UI shows.
func writeRunError(w http.ResponseWriter, err error) {
	if errors.Is(err, pdfindex.ErrEngineUnavailable) {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	http.Error(w, err.Error(), http.StatusInternalServerError)
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
	// StopAndWait, not Stop: a worker still draining its file would write
	// into the database recreated below.
	h.ix.StopAndWait()
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
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	_ = json.NewDecoder(r.Body).Decode(&body)
	n, err := h.db.ResetForReindex(body.Scope)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	// RequestRun, not Run: a running sweep enumerated its list before these
	// rows were reset and would never reach them; Run() was a silent no-op.
	if err := h.ix.RequestRun(); err != nil {
		writeRunError(w, err)
		return
	}
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
	if err := h.ix.RequestRun(); err != nil {
		writeRunError(w, err)
		return
	}
	writeJSON(w, map[string]interface{}{"reset": n, "running": true})
}

// POST /api/pdfindex/restart — stop the current sweep, requeue any in-flight
// ('indexing') rows so they aren't skipped, then start a fresh pass over all
// pending work. Keeps already-indexed files (NOT a hard reset). StopAndWait
// guarantees no draining worker races the requeue.
func (h *PdfIndexHandler) Restart(w http.ResponseWriter, r *http.Request) {
	h.ix.StopAndWait()
	if _, err := h.db.RequeueIndexing(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := h.ix.Run(); err != nil {
		writeRunError(w, err)
		return
	}
	writeJSON(w, h.ix.Progress())
}

// pdfAutoResumeKey is the databank config key gating background auto-resume.
// Default ON: only the literal string "false" disables it, so existing installs
// (no row) auto-resume pending PDFs on boot / after a scan adds PDFs.
const pdfAutoResumeKey = "pdf_index_auto_run"

// PdfAutoResumeEnabled reports whether background auto-resume is on. Exported so
// the boot path (main.go) and the handler agree on the default-ON rule.
func PdfAutoResumeEnabled(bank *databank.DB) bool {
	if bank == nil {
		return false
	}
	v, _ := bank.GetConfig(pdfAutoResumeKey)
	return v != "false"
}

// GET /api/pdfindex/auto-resume
func (h *PdfIndexHandler) GetAutoResume(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]bool{"enabled": PdfAutoResumeEnabled(h.bank)})
}

// POST /api/pdfindex/auto-resume  body {"enabled": bool}
// Persists the toggle. When enabling, kicks a background run so pending work
// starts immediately without waiting for the next boot/scan.
func (h *PdfIndexHandler) SetAutoResume(w http.ResponseWriter, r *http.Request) {
	if h.bank == nil {
		http.Error(w, "databank unavailable", http.StatusServiceUnavailable)
		return
	}
	var body struct {
		Enabled bool `json:"enabled"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad json: "+err.Error(), http.StatusBadRequest)
		return
	}
	val := "false"
	if body.Enabled {
		val = "true"
	}
	if err := h.bank.SetConfig(pdfAutoResumeKey, val); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if body.Enabled {
		_ = h.ix.RequestRun()
	}
	writeJSON(w, map[string]bool{"enabled": body.Enabled})
}

// POST /api/pdfindex/files/{id}/index — priority enqueue (backend fallback path)
func (h *PdfIndexHandler) PriorityIndex(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	st, _ := h.db.StatusContext(r.Context(), id)
	if st.Status == "indexing" {
		http.Error(w, "already indexing", http.StatusConflict)
		return
	}
	// Submit indexes exactly this file: the priority lane when a sweep runs,
	// a one-file sweep otherwise. It used to start a full-library sweep
	// (every failed file included) regardless of the auto-resume setting.
	if err := h.ix.Submit(id); err != nil {
		writeRunError(w, err)
		return
	}
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
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
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
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
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

// searchRestrict resolves the scope parameter. ok=false means the scope is
// empty (donor scope with no donors): the answer is "no results" without a
// query.
func (h *PdfIndexHandler) searchRestrict(scope string) (ids []int64, ok bool, err error) {
	if scope != "donor" {
		return nil, true, nil
	}
	ids, err = h.bank.DonorFileIDs()
	if err != nil {
		return nil, false, err
	}
	return ids, len(ids) > 0, nil
}

// GET /api/databank/search?q=...&scope=all|donor
//
// One row per file (content group), in the order found, with hit_count and
// the first matching page. `partial` is true when a cap or the deadline
// stopped the scan (see pdfindex.SearchFiles).
func (h *PdfIndexHandler) Search(w http.ResponseWriter, r *http.Request) {
	empty := func(q string) {
		writeJSON(w, map[string]interface{}{"results": []interface{}{}, "total": 0, "query": q})
	}
	if h.bank == nil {
		empty("")
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		empty(q)
		return
	}
	restrict, ok, err := h.searchRestrict(r.URL.Query().Get("scope"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if !ok {
		empty(q)
		return
	}
	var hits []pdfindex.SearchHit
	sum, err := h.db.SearchFiles(r.Context(), q, restrict, pdfindex.SearchOptions{}, func(hit pdfindex.SearchHit) error {
		hits = append(hits, hit)
		return nil
	})
	if errors.Is(err, pdfindex.ErrQueryTooShort) {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	meta, err := h.bank.SearchMeta(sum.Order)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
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
	// Collapse byte-identical copies (same content_hash) into one row: the
	// lowest file id represents the group, its copies are listed. Copies hold
	// the same pages, so the group's count is the largest member count, not
	// the sum. Groups keep first-found order.
	fileKey := func(fileID int64) string {
		if hx := meta[fileID].ContentHash; hx != "" {
			return hx
		}
		return "id:" + strconv.FormatInt(fileID, 10)
	}
	type group struct {
		hit   pdfindex.SearchHit
		count int
	}
	groups := map[string]*group{}
	var order []string
	for _, hit := range hits {
		k := fileKey(hit.FileID)
		g := groups[k]
		if g == nil {
			groups[k] = &group{hit: hit, count: sum.Counts[hit.FileID]}
			order = append(order, k)
			continue
		}
		if hit.FileID < g.hit.FileID {
			g.hit.FileID = hit.FileID
		}
		if hit.PageNum < g.hit.PageNum {
			g.hit.PageNum, g.hit.Snippet = hit.PageNum, hit.Snippet
		}
		if c := sum.Counts[hit.FileID]; c > g.count {
			g.count = c
		}
	}
	results := make([]result, 0, len(order))
	for _, k := range order {
		g := groups[k]
		m := meta[g.hit.FileID]
		var copies []string
		if m.ContentHash != "" {
			if copies, err = h.bank.CopyPathsForFile(g.hit.FileID); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
		}
		if copies == nil {
			copies = []string{}
		}
		results = append(results, result{
			SearchHit: g.hit, HitCount: g.count, Filename: m.Filename, Path: m.Path,
			IsDonor: m.IsDonor, BoardBindings: m.Bindings, Copies: copies,
		})
	}
	writeJSON(w, map[string]interface{}{
		"results": results, "total": len(results), "query": q,
		"partial": sum.Partial, "partial_reason": sum.Reason, "ignored": nonNil(sum.Ignored),
	})
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// GET /api/databank/search/stream?q=...&scope=all|donor
//
// Streaming sibling of Search. Emits NDJSON (one JSON object per line):
//
//	{"type":"result", file_id, page_num, snippet, filename, path, is_donor, board_bindings, copies, hit_count}
//	{"type":"counts", "counts": {"<file_id>": N, ...}}
//	{"type":"done",   "total": N, "partial": bool, "partial_reason": "files|pages|time", "ignored": [...]}
//	{"type":"error",  "error": "...", "code": "too_short|search"}   (instead of counts/done)
//
// One "result" line per file the moment the scan first meets it; "counts"
// corrects each row's hit_count once the scan ends. Every stream ends with
// exactly one "done" or one "error" line, so a client that sees neither knows
// the stream was cut.
//
// The request context bounds the scan: a client that aborts (a superseded
// search) stops the query on the server too. Before, it ran to the end and
// held a reader connection the whole time.
//
// Registered WITHOUT the read()/write() timeout wrappers so the http.Flusher is
// reachable; pdfindex.SearchFiles carries its own deadline.
func (h *PdfIndexHandler) SearchStream(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-cache")
	// Ask nginx-style reverse proxies not to buffer the stream, which would
	// turn progressive rows into one block at the end.
	w.Header().Set("X-Accel-Buffering", "no")
	f, _ := w.(http.Flusher)
	enc := json.NewEncoder(w)
	emit := func(obj interface{}) error {
		if err := enc.Encode(obj); err != nil {
			return err // client gone
		}
		if f != nil {
			f.Flush()
		}
		return nil
	}
	done := func(total int, sum pdfindex.SearchSummary) {
		_ = emit(map[string]interface{}{"type": "done", "total": total,
			"partial": sum.Partial, "partial_reason": sum.Reason, "ignored": nonNil(sum.Ignored)})
	}

	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" || h.bank == nil {
		done(0, pdfindex.SearchSummary{})
		return
	}
	restrict, ok, err := h.searchRestrict(r.URL.Query().Get("scope"))
	if err != nil {
		_ = emit(map[string]interface{}{"type": "error", "code": "search", "error": err.Error()})
		return
	}
	if !ok {
		done(0, pdfindex.SearchSummary{})
		return
	}

	sum, err := h.db.SearchFiles(r.Context(), q, restrict, pdfindex.SearchOptions{}, func(hit pdfindex.SearchHit) error {
		metaMap, merr := h.bank.SearchMeta([]int64{hit.FileID})
		if merr != nil {
			// Resilient: don't abort the whole stream on a single enrich hiccup.
			log.Printf("SearchStream: SearchMeta(%d): %v", hit.FileID, merr)
		}
		m := metaMap[hit.FileID]
		cp := []string{}
		if m.ContentHash != "" {
			if paths, cerr := h.bank.CopyPathsForFile(hit.FileID); cerr != nil {
				log.Printf("SearchStream: CopyPathsForFile(%d): %v", hit.FileID, cerr)
			} else if paths != nil {
				cp = paths
			}
		}
		return emit(map[string]interface{}{
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
	})
	switch {
	case r.Context().Err() != nil:
		return // client gone; nobody to tell
	case errors.Is(err, pdfindex.ErrQueryTooShort):
		_ = emit(map[string]interface{}{"type": "error", "code": "too_short", "error": err.Error()})
		return
	case err != nil:
		log.Printf("SearchStream: q=%q: %v", q, err)
		_ = emit(map[string]interface{}{"type": "error", "code": "search", "error": err.Error()})
		return
	}
	if sum.Partial {
		log.Printf("SearchStream: q=%q partial (%s) after %d pages, %d files", q, sum.Reason, sum.Pages, len(sum.Order))
	}
	counts := make(map[string]int, len(sum.Order))
	for _, id := range sum.Order {
		counts[strconv.FormatInt(id, 10)] = sum.Counts[id]
	}
	_ = emit(map[string]interface{}{"type": "counts", "counts": counts})
	done(len(sum.Order), sum)
}
