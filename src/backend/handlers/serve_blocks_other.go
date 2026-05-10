//go:build !(linux || darwin || freebsd || netbsd || openbsd || dragonfly)

package handlers

import "os"

// statBlocks fallback on platforms that don't expose st_blocks via
// syscall.Stat_t (Windows). Diagnostic-only; see serve_blocks_unix.go.
func statBlocks(info os.FileInfo) (int64, bool) {
	return 0, false
}
