package handlers

import "boardripper/pdfindex"

// pdfDonorIndexer adapts the pdfindex Indexer + status store to the
// DonorIndexer interface consumed by DatabankHandler.
type pdfDonorIndexer struct {
	ix    *pdfindex.Indexer
	store *pdfindex.DB
}

// NewPdfDonorIndexer builds the adapter. Wired from main.go when pdfindex is up.
func NewPdfDonorIndexer(ix *pdfindex.Indexer, store *pdfindex.DB) DonorIndexer {
	return &pdfDonorIndexer{ix: ix, store: store}
}

// EnsureIndexed kicks a scoped sweep of exactly these IDs and bumps each into
// the priority lane so an already-running sweep also picks them up. Async.
func (a *pdfDonorIndexer) EnsureIndexed(ids []int64) {
	if a.ix == nil || len(ids) == 0 {
		return
	}
	_ = a.ix.RunFiles(ids) // idempotent; nil on ErrAlreadyRunning
	for _, id := range ids {
		a.ix.Enqueue(id)
	}
}

// StatusFor returns file_id → status. A file with no status row (never indexed)
// maps to "pending" so the UI shows it as queued rather than blank.
func (a *pdfDonorIndexer) StatusFor(ids []int64) map[int64]string {
	out := make(map[int64]string, len(ids))
	if a.store == nil {
		return out
	}
	for _, id := range ids {
		st, err := a.store.Status(id)
		if err != nil {
			continue
		}
		s := st.Status
		if s == "" {
			s = "pending"
		}
		out[id] = s
	}
	return out
}
