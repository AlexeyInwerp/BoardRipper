package databank

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// sampleChunk is the size of each sampled window (head/middle/tail).
const sampleChunk = 64 * 1024

// fullHashLimit: files at or below this size are hashed in full (sampling would
// read them entirely anyway). Equals 3 sample windows.
const fullHashLimit = 3 * sampleChunk

// ContentKey computes the dedup content key for a file of the given size:
//   - size <= fullHashLimit: SHA-256 of the whole file.
//   - else: SHA-256 of ( size ‖ head 64K ‖ middle 64K ‖ tail 64K ).
//
// The size is always mixed in so different-sized files can never collide.
// Returns the 32-byte digest. Errors propagate (caller treats as "no hash").
func ContentKey(path string, size int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	h := sha256.New()
	var sizeBuf [8]byte
	binary.LittleEndian.PutUint64(sizeBuf[:], uint64(size))
	h.Write(sizeBuf[:])

	if size <= fullHashLimit {
		buf := make([]byte, size)
		if _, err := readFullAt(f, buf, 0); err != nil {
			return nil, err
		}
		h.Write(buf)
		return h.Sum(nil), nil
	}

	buf := make([]byte, sampleChunk)
	offsets := []int64{
		0,                      // head
		size/2 - sampleChunk/2, // middle (centered)
		size - sampleChunk,     // tail
	}
	for _, off := range offsets {
		if off < 0 {
			off = 0
		}
		if _, err := readFullAt(f, buf, off); err != nil {
			return nil, err
		}
		h.Write(buf)
	}
	return h.Sum(nil), nil
}

// readFullAt reads len(buf) bytes at off. For the full-hash path buf is sized to
// the file; for sampled reads buf is sampleChunk and the file is > fullHashLimit
// so a full chunk is always available at each offset.
func readFullAt(f *os.File, buf []byte, off int64) (int, error) {
	n := 0
	for n < len(buf) {
		m, err := f.ReadAt(buf[n:], off+int64(n))
		n += m
		if err != nil {
			if n == len(buf) {
				return n, nil
			}
			return n, err
		}
	}
	return n, nil
}

// HashCollisions hashes all un-hashed size-collision files using a pool of
// `workers` goroutines. Files sharing the same (size, base-filename) are
// treated as one cluster: the representative is read+hashed ONCE and its hash
// applied to every member (1 read instead of N). Files with a unique
// (size,name) within the collision set are hashed individually — so a
// byte-identical copy under a different name still hashes to the same value and
// merges into the same content group. Reads parallelize; SetContentHash
// serializes via the DB write mutex. cancelled() short-circuits; onProgress
// (nilable) is called as (done, total) in CLUSTERS.
func HashCollisions(db *DB, root string, files []CollisionFile, workers int, cancelled func() bool, onProgress func(done, total int64)) {
	if workers < 1 {
		workers = 4
	}
	type job struct {
		path string  // representative path to read
		size int64
		ids  []int64 // all file ids in the cluster to assign the hash to
	}
	// Cluster un-hashed candidates by (size, base name).
	clusters := make(map[string][]CollisionFile)
	var order []string
	for _, f := range files {
		if f.Hashed {
			continue
		}
		k := strconv.FormatInt(f.Size, 10) + "\x00" + filepath.Base(f.Path)
		if _, ok := clusters[k]; !ok {
			order = append(order, k)
		}
		clusters[k] = append(clusters[k], f)
	}
	jobs := make([]job, 0, len(order))
	for _, k := range order {
		cl := clusters[k]
		ids := make([]int64, len(cl))
		for i, f := range cl {
			ids[i] = f.ID
		}
		jobs = append(jobs, job{path: cl[0].Path, size: cl[0].Size, ids: ids}) // cl[0] = representative
	}
	total := int64(len(jobs))
	jobCh := make(chan job)
	var done atomic.Int64
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range jobCh {
				if !cancelled() {
					if key, err := ContentKey(filepath.Join(root, j.path), j.size); err != nil {
						log.Printf("dedup: hash %s: %v (left unhashed)", j.path, err)
					} else {
						for _, id := range j.ids {
							if err := db.SetContentHash(id, key); err != nil {
								log.Printf("dedup: store hash id=%d: %v", id, err)
							}
						}
					}
				}
				n := done.Add(1)
				if onProgress != nil {
					onProgress(n, total)
				}
			}
		}()
	}
	for _, j := range jobs {
		if cancelled() {
			break
		}
		jobCh <- j
	}
	close(jobCh)
	wg.Wait()
}

// DedupProgress is the observable state of an in-progress DedupRunner sweep.
type DedupProgress struct {
	Running     bool   `json:"running"`
	Total       int64  `json:"total"`
	Done        int64  `json:"done"`
	CurrentFile string `json:"current_file"`
	StartedAt   int64  `json:"started_at"`
}

// DedupRunner executes an on-demand dedup pass: it hashes all size-colliding
// files and writes their content_hash into the DB so duplicates can be surfaced.
type DedupRunner struct {
	db         *DB
	scanRootFn func() string
	mu         sync.Mutex
	running    bool
	cancel     context.CancelFunc
	prog       DedupProgress
}

// NewDedupRunner creates a DedupRunner backed by db. scanRootFn returns the
// library root used to resolve relative file paths from the DB.
func NewDedupRunner(db *DB, scanRootFn func() string) *DedupRunner {
	return &DedupRunner{db: db, scanRootFn: scanRootFn}
}

// Progress returns a snapshot of the current sweep state (safe for concurrent use).
func (r *DedupRunner) Progress() DedupProgress {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.prog
}

// Stop cancels a running sweep. It is a no-op if no sweep is in progress.
func (r *DedupRunner) Stop() {
	r.mu.Lock()
	if r.cancel != nil {
		r.cancel()
	}
	r.mu.Unlock()
}

// Run starts an async dedup sweep. If a sweep is already running it returns
// immediately without starting a second one.
func (r *DedupRunner) Run() error {
	r.mu.Lock()
	if r.running {
		r.mu.Unlock()
		return nil
	}
	files, err := r.db.SizeCollisionFiles()
	if err != nil {
		r.mu.Unlock()
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	r.cancel = cancel
	r.running = true
	r.prog = DedupProgress{Running: true, Total: int64(len(files)), StartedAt: time.Now().Unix()}
	r.mu.Unlock()
	go r.sweep(ctx, files)
	return nil
}

func (r *DedupRunner) sweep(ctx context.Context, files []CollisionFile) {
	root := r.scanRootFn()
	HashCollisions(r.db, root, files, 4,
		func() bool {
			select {
			case <-ctx.Done():
				return true
			default:
				return false
			}
		},
		func(done, total int64) {
			r.mu.Lock()
			r.prog.Done = done
			r.prog.Total = total
			r.mu.Unlock()
		},
	)
	r.mu.Lock()
	r.prog.Running = false
	r.running = false
	r.cancel = nil
	r.mu.Unlock()
}
