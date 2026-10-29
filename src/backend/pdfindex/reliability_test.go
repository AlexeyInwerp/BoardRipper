package pdfindex

// Tests for the 2026-10-29 indexer fixes (docs/specs/2026-10-14-pdf-index-search-review.md,
// findings I1–I9): attempts and giving up, partial extraction, follow-up
// sweeps, the heartbeat, and a failed extractor.

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func countingSource(n int) *fakeSource {
	src := &fakeSource{data: map[string][]byte{}}
	for i := 1; i <= n; i++ {
		p := "f" + string(rune('a'+i-1)) + ".pdf"
		src.files = append(src.files, PdfFile{ID: int64(i), Path: p})
		src.data[p] = []byte("text of " + p)
	}
	return src
}

// failingExtractor fails every file and counts calls per path.
type failingExtractor struct {
	mu    sync.Mutex
	calls map[string]int
}

func (f *failingExtractor) ExtractFile(b []byte) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.calls == nil {
		f.calls = map[string]int{}
	}
	f.calls[string(b)]++
	return nil, errors.New("incorrect format")
}

func (f *failingExtractor) total() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		n += c
	}
	return n
}

func runAndWait(t *testing.T, ix *Indexer) {
	t.Helper()
	if err := ix.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	waitFor(t, func() bool { p := ix.Progress(); return !p.Running })
}

// I1: a failing file is retried by sweeps up to MaxAttempts times, then left
// alone; "Retry failed" (ResetForReindex) makes it eligible again.
func TestSweepsGiveUpAfterMaxAttempts(t *testing.T) {
	db := openTestDB(t)
	ext := &failingExtractor{}
	ix := NewIndexer(db, ext, countingSource(1), func() []string { return nil }, 1)

	for i := 0; i < MaxAttempts+2; i++ {
		runAndWait(t, ix)
	}
	if got := ext.total(); got != MaxAttempts {
		t.Fatalf("extract calls = %d, want %d (sweeps must stop retrying)", got, MaxAttempts)
	}
	st, _ := db.Status(1)
	if st.Status != "failed" || st.Attempts != MaxAttempts {
		t.Fatalf("status = %+v, want failed with %d attempts", st, MaxAttempts)
	}
	s, _ := db.Stats(context.Background())
	if s.GivenUp != 1 || s.Failed != 1 {
		t.Fatalf("stats = %+v, want failed 1 / given_up 1", s)
	}
	if n, _ := db.ResetForReindex("failed"); n != 1 {
		t.Fatalf("reset = %d, want 1", n)
	}
	runAndWait(t, ix)
	if got := ext.total(); got != MaxAttempts+1 {
		t.Fatalf("after Retry failed, extract calls = %d, want %d", got, MaxAttempts+1)
	}
}

// I4: a claim that never finishes (the process died under it) counts as an
// attempt; after MaxAttempts the boot requeue marks it failed instead of
// putting the same file first in line again.
func TestRequeueGivesUpOnRepeatedOrphans(t *testing.T) {
	db := openTestDB(t)
	for i := 1; i <= MaxAttempts; i++ {
		if won, _ := db.Claim(7, "pdfium"); !won {
			t.Fatalf("claim %d lost", i)
		}
		if _, err := db.RequeueIndexing(); err != nil { // the "boot"
			t.Fatal(err)
		}
		st, _ := db.Status(7)
		want := "pending"
		if i == MaxAttempts {
			want = "failed"
		}
		if st.Status != want {
			t.Fatalf("after orphan %d: status %q, want %q", i, st.Status, want)
		}
	}
	st, _ := db.Status(7)
	if !strings.Contains(st.Error, "without finishing") {
		t.Fatalf("error = %q, want the abandoned note", st.Error)
	}
	skip, _ := db.DoneOrActiveFileIDs()
	if !skip[7] {
		t.Fatal("a given-up file must be skipped by sweeps")
	}
	// A changed file on disk starts over.
	if err := db.MarkPending(7); err != nil {
		t.Fatal(err)
	}
	st, _ = db.Status(7)
	if st.Status != "pending" || st.Attempts != 0 {
		t.Fatalf("after MarkPending: %+v, want pending with 0 attempts", st)
	}
}

// A success clears the attempt count and the error of earlier attempts.
func TestFinalizeClearsAttemptsAndError(t *testing.T) {
	db := openTestDB(t)
	db.Claim(3, "pdfium")
	db.Fail(3, "boom")
	db.Claim(3, "pdfium")
	db.UpsertPages(3, []Page{{1, "text"}})
	st, _ := db.Finalize(3)
	if st.Status != "indexed" || st.Attempts != 0 || st.Error != "" {
		t.Fatalf("after success: %+v", st)
	}
}

// partialExtractor returns the first page and a PartialError, as the engine
// does when the deadline lands on page 2 of 3.
type partialExtractor struct{}

func (partialExtractor) ExtractFile(b []byte) ([]string, error) {
	return []string{"first page " + string(b), "", ""},
		&PartialError{Reached: 1, Total: 3, After: 2 * time.Minute}
}

// I2: a document cut off by its deadline is indexed for the pages that were
// read, marked partial, and not retried by the next sweep.
func TestPartialExtractionIsIndexedNotRetried(t *testing.T) {
	db := openTestDB(t)
	ix := NewIndexer(db, partialExtractor{}, countingSource(1), func() []string { return nil }, 1)
	runAndWait(t, ix)
	st, _ := db.Status(1)
	if st.Status != "indexed" || st.PageCount != 1 || !strings.Contains(st.Error, "partial") {
		t.Fatalf("status = %+v, want indexed, 1 page, partial note", st)
	}
	hits, err := db.SearchPages(context.Background(), "first", nil, 10)
	if err != nil || len(hits) != 1 {
		t.Fatalf("search = %v, %v; want the partial page searchable", hits, err)
	}
	skip, _ := db.DoneOrActiveFileIDs()
	if !skip[1] {
		t.Fatal("a partial file must not be re-extracted by every sweep")
	}
}

// I5: rows reset while a sweep runs are reached by a follow-up sweep. Run()
// alone was a silent no-op, so a watermark change mid-sweep never applied.
func TestRequestRunWhileRunningFollowsUp(t *testing.T) {
	db := openTestDB(t)
	gate := make(chan struct{})
	src := countingSource(1)
	ix := NewIndexer(db, gatedExtractor{gate}, src, func() []string { return nil }, 1)
	if err := ix.Run(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { p := ix.Progress(); return p.Running && p.ActiveWorkers == 1 })

	// File 2 appears and becomes pending after the sweep enumerated its list.
	src.add(PdfFile{ID: 2, Path: "late.pdf"}, []byte("late"))
	if err := db.MarkPending(2); err != nil {
		t.Fatal(err)
	}
	if err := ix.RequestRun(); err != nil {
		t.Fatalf("RequestRun while running: %v", err)
	}
	close(gate)
	waitFor(t, func() bool { st, _ := db.Status(2); return st.Status == "indexed" })
	waitFor(t, func() bool { return !ix.Progress().Running })
}

// An id in the priority lane is processed by a sweep whose own list has
// nothing pending. (The follow-up for an id that arrives after the workers
// left — I6 — is a timing window this test cannot open on demand; the sweep's
// deferred cleanup checks len(ix.priority) for it.)
func TestLaneIdProcessedBySweepWithNothingPending(t *testing.T) {
	db := openTestDB(t)
	src := countingSource(2)
	ix := NewIndexer(db, fakeExtractor{}, src, func() []string { return nil }, 1)
	// Nothing is running: put the id in the lane directly, then run a sweep
	// over an empty list (file 1 already done) — as if the id arrived late.
	db.Claim(1, "pdfium")
	db.UpsertPages(1, []Page{{1, "x"}})
	db.Finalize(1)
	db.Claim(2, "pdfium")
	db.UpsertPages(2, []Page{{1, "y"}})
	db.Finalize(2)
	src.add(PdfFile{ID: 3, Path: "lane.pdf"}, []byte("lane"))
	ix.Enqueue(3)
	if err := ix.RunFiles([]int64{1}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { st, _ := db.Status(3); return st.Status == "indexed" })
}

// slowExtractor takes slow for the file whose bytes contain slowMark and fast
// for every other one, and counts calls per file.
type slowExtractor struct {
	slow, fast time.Duration
	slowMark   string
	mu         sync.Mutex
	calls      map[string]int
}

func (s *slowExtractor) ExtractFile(b []byte) ([]string, error) {
	s.mu.Lock()
	if s.calls == nil {
		s.calls = map[string]int{}
	}
	s.calls[string(b)]++
	s.mu.Unlock()
	if strings.Contains(string(b), s.slowMark) {
		time.Sleep(s.slow)
	} else {
		time.Sleep(s.fast)
	}
	return []string{string(b)}, nil
}

func (s *slowExtractor) callsFor(mark string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for k, v := range s.calls {
		if strings.Contains(k, mark) {
			n += v
		}
	}
	return n
}

// I8: a long extraction heartbeats, so the watchdog does not hand a live job
// back to 'pending' and the other worker does not extract it again. Shape
// measured before the fix (2026-10-14, T5): five files, two workers, one slow
// file, a re-submit once the watchdog flips it — extracted twice.
func TestHeartbeatKeepsLiveJobFromReclaim(t *testing.T) {
	db := openTestDB(t)
	ext := &slowExtractor{slow: 3 * time.Second, fast: 500 * time.Millisecond, slowMark: "fa.pdf"}
	ix := NewIndexer(db, ext, countingSource(5), func() []string { return nil }, 2)
	ix.heartbeat = 200 * time.Millisecond
	reclaimed := atomic.Int64{}
	stop := ix.StartWatchdog(100*time.Millisecond, 1, func(n int64) {
		reclaimed.Add(n)
		_ = ix.Submit(1)
	})
	defer close(stop)
	runAndWait(t, ix)
	if n := ext.callsFor("fa.pdf"); n != 1 {
		t.Fatalf("slow file extracted %d times, want 1 (live job reclaimed %d time(s))", n, reclaimed.Load())
	}
}

// brokenEngine reports a failed init, like an Engine whose wasm compile failed.
type brokenEngine struct{ calls atomic.Int32 }

func (b *brokenEngine) ExtractFile([]byte) ([]string, error) {
	b.calls.Add(1)
	return nil, errors.New("pdfium unavailable")
}
func (b *brokenEngine) InitError() error { return errors.New("wasm compile failed") }

// I9: with a failed extractor a sweep does not start (no file is read or
// marked failed) and Progress names the reason.
func TestBrokenEngineRefusesSweep(t *testing.T) {
	db := openTestDB(t)
	eng := &brokenEngine{}
	ix := NewIndexer(db, eng, countingSource(3), func() []string { return nil }, 1)
	if err := ix.RequestRun(); !errors.Is(err, ErrEngineUnavailable) {
		t.Fatalf("RequestRun = %v, want ErrEngineUnavailable", err)
	}
	if err := ix.Submit(1); !errors.Is(err, ErrEngineUnavailable) {
		t.Fatalf("Submit = %v, want ErrEngineUnavailable", err)
	}
	if eng.calls.Load() != 0 {
		t.Fatal("no file may be extracted")
	}
	if st, _ := db.Status(1); st.Status != "" {
		t.Fatalf("status = %q, want untouched", st.Status)
	}
	if p := ix.Progress(); !strings.Contains(p.EngineError, "wasm compile failed") {
		t.Fatalf("progress engine_error = %q", p.EngineError)
	}
}

func TestEngineDeadlineScalesWithPages(t *testing.T) {
	e := &Engine{perFileTimeout: 2 * time.Minute, perPage: time.Second, maxFileTimeout: 20 * time.Minute}
	cases := []struct {
		pages int
		want  time.Duration
	}{
		{0, 2 * time.Minute},
		{100, 2*time.Minute + 100*time.Second},
		{5000, 20 * time.Minute},
	}
	for _, c := range cases {
		if got := e.deadline(c.pages); got != c.want {
			t.Errorf("deadline(%d) = %v, want %v", c.pages, got, c.want)
		}
	}
}
