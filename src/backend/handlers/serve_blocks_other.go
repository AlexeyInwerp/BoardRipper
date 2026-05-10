//go:build !(linux || darwin || freebsd || netbsd || openbsd || dragonfly)

package handlers

import "os"

func statBlocks(info os.FileInfo) (int64, bool) {
	return 0, false
}
