//go:build windows

package handlers

import "golang.org/x/sys/windows"

// freeBytes returns the bytes available to the caller on the volume hosting
// `path` (Windows), or 0 on any error. Only reached on the Electron desktop
// Windows build; library sync (its sole caller) is hidden in the desktop UI,
// so this is effectively informational. Uses GetDiskFreeSpaceEx via
// golang.org/x/sys/windows (already a module dependency).
func freeBytes(path string) uint64 {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0
	}
	var availToCaller uint64
	if err := windows.GetDiskFreeSpaceEx(p, &availToCaller, nil, nil); err != nil {
		return 0
	}
	return availToCaller
}
