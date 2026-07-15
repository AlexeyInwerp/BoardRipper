//go:build !windows

package handlers

import "syscall"

// freeBytes returns the available bytes on the filesystem hosting `path`.
// Uses syscall.Statfs, available on Linux + Darwin (the Docker/NAS runtimes).
// Returns 0 on any error. This is the original implementation, relocated
// verbatim from sync.go so cross-compilation to Windows succeeds.
func freeBytes(path string) uint64 {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0
	}
	// Bavail = blocks available to non-superuser; on Linux+Darwin Bsize is
	// uint32/int64 respectively, so explicitly widen to uint64 first.
	return uint64(st.Bavail) * uint64(st.Bsize)
}
