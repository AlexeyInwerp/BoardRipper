//go:build linux || darwin || freebsd || netbsd || openbsd || dragonfly

package handlers

import (
	"os"
	"syscall"
)

// statBlocks returns (st_blocks, true) on platforms where it's available.
// On non-Unix platforms or when the type assertion fails, returns (0, false).
//
// DIAGNOSTIC ONLY. Do NOT use the return value to gate behavior — a placeholder
// signal (size>0 && blocks==0) is also produced by native macOS files that
// io.ReadAll can read just fine after a brief block. See commit 4b9c722 for
// the full rationale on why pre-flight gating was reverted. The value is
// useful in logs and the /api/files/probe response so operators can correlate
// failures to placeholders.
func statBlocks(info os.FileInfo) (int64, bool) {
	sys, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return int64(sys.Blocks), true
}
