//go:build linux || darwin || freebsd || netbsd || openbsd || dragonfly

package handlers

import (
	"os"
	"syscall"
)

// statBlocks returns (st_blocks, true) on platforms where it's available.
// On non-Unix platforms or when the type assertion fails, returns (0, false)
// and the caller falls through to the eager-read path.
func statBlocks(info os.FileInfo) (int64, bool) {
	sys, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return int64(sys.Blocks), true
}
