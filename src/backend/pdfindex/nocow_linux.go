//go:build linux

package pdfindex

import (
	"os"

	"golang.org/x/sys/unix"
)

// fsNoCOWFlag is FS_NOCOW_FL from linux/fs.h ("chattr +C").
const fsNoCOWFlag = 0x00800000

// setNoCOW creates path if needed and, while it is still empty, turns off
// copy-on-write for it. On btrfs — Synology's default — a SQLite file written
// with copy-on-write is rewritten out of place page by page and ends up in
// tens of thousands of fragments: the 13 GB index on the NAS read at 4 MB/s
// against 55 MB/s for a fresh file (2026-10-29). The flag only takes on an
// empty file and is ignored (error returned, harmless) on other filesystems.
func setNoCOW(path string) error {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	if st, err := f.Stat(); err != nil || st.Size() != 0 {
		return err
	}
	flags, err := unix.IoctlGetUint32(int(f.Fd()), unix.FS_IOC_GETFLAGS)
	if err != nil {
		return err
	}
	return unix.IoctlSetPointerInt(int(f.Fd()), unix.FS_IOC_SETFLAGS, int(flags|fsNoCOWFlag))
}
