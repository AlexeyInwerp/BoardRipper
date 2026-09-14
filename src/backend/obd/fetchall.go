package obd

import (
	"context"
	"errors"
	"log"
	"sync"
	"time"
)

// FetchAllProgress is the observable state of a fetch-all pass.
type FetchAllProgress struct {
	Running   bool   `json:"running"`
	Total     int    `json:"total"`
	Done      int    `json:"done"` // fetched + skipped + failed
	Fetched   int    `json:"fetched"`
	Skipped   int    `json:"skipped"` // already cached
	Failed    int    `json:"failed"`
	Current   string `json:"current,omitempty"`
	StartedAt int64  `json:"started_at,omitempty"`
	LastError string `json:"last_error,omitempty"`
}

// FetchAllRunner downloads every board in index.json that is not cached yet.
// The whole catalogue is ~110 boards at well under a second each, so this is
// a one-to-two-minute pass — offered at first run and in Settings. One
// request per second: the upstream is a small community site.
type FetchAllRunner struct {
	store   *Store
	scraper *Scraper
	pause   time.Duration

	mu      sync.Mutex
	running bool
	cancel  context.CancelFunc
	prog    FetchAllProgress
}

// ErrNoIndex is returned by Run when index.json has not been synced yet.
var ErrNoIndex = errors.New("no OBD index synced; sync first")

// NewFetchAllRunner creates a runner against the given store and scraper.
func NewFetchAllRunner(store *Store, scraper *Scraper) *FetchAllRunner {
	return &FetchAllRunner{store: store, scraper: scraper, pause: time.Second}
}

// Progress returns a snapshot of the pass (safe for concurrent use).
func (r *FetchAllRunner) Progress() FetchAllProgress {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.prog
}

// Stop cancels a running pass; a no-op when none runs.
func (r *FetchAllRunner) Stop() {
	r.mu.Lock()
	if r.cancel != nil {
		r.cancel()
	}
	r.mu.Unlock()
}

// Run starts the pass in the background. A second call while one runs is a
// no-op. Returns ErrNoIndex when there is nothing to walk.
func (r *FetchAllRunner) Run() error {
	idx, err := r.store.ReadIndex()
	if err != nil || idx == nil {
		return ErrNoIndex
	}
	r.mu.Lock()
	if r.running {
		r.mu.Unlock()
		return nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	r.cancel = cancel
	r.running = true
	r.prog = FetchAllProgress{Running: true, Total: len(idx.Boards), StartedAt: time.Now().Unix()}
	r.mu.Unlock()
	go r.walk(ctx, idx.Boards)
	return nil
}

func (r *FetchAllRunner) walk(ctx context.Context, boards []IndexEntry) {
	defer func() {
		r.mu.Lock()
		r.prog.Running = false
		r.prog.Current = ""
		r.running = false
		r.cancel = nil
		p := r.prog
		r.mu.Unlock()
		log.Printf("obd: fetch-all done — %d fetched, %d already cached, %d failed of %d", p.Fetched, p.Skipped, p.Failed, p.Total)
	}()
	for _, e := range boards {
		if ctx.Err() != nil {
			return
		}
		if fetched, _ := r.store.IsFetched(e.Bpath); fetched {
			r.mu.Lock()
			r.prog.Skipped++
			r.prog.Done++
			r.mu.Unlock()
			continue
		}
		r.mu.Lock()
		r.prog.Current = e.Bpath
		r.mu.Unlock()

		if err := r.fetchOne(e.Bpath); err != nil {
			log.Printf("obd: fetch-all %s: %v", e.Bpath, err)
			r.mu.Lock()
			r.prog.Failed++
			r.prog.Done++
			r.prog.LastError = e.Bpath + ": " + err.Error()
			r.mu.Unlock()
		} else {
			r.mu.Lock()
			r.prog.Fetched++
			r.prog.Done++
			r.mu.Unlock()
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(r.pause):
		}
	}
}

func (r *FetchAllRunner) fetchOne(bpath string) error {
	raw, err := r.scraper.FetchBoard(bpath)
	if err != nil {
		return err
	}
	parsed, err := Parse(raw)
	if err != nil {
		return err
	}
	parsed.Bpath = bpath
	parsed.SourceURL = r.scraper.BaseURL + "/?a=showboardsolutions&bpath=" + bpath
	parsed.FetchedAt = time.Now().UTC().Format(time.RFC3339)
	return r.store.WriteBoard(bpath, raw, parsed)
}

// CachedCount reports how many index entries are already on disk.
func (s *Store) CachedCount(idx *Index) int {
	if idx == nil {
		return 0
	}
	n := 0
	for _, e := range idx.Boards {
		if fetched, _ := s.IsFetched(e.Bpath); fetched {
			n++
		}
	}
	return n
}
