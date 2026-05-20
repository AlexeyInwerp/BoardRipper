package databank

import (
	"crypto/sha256"
	"encoding/binary"
	"os"
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
