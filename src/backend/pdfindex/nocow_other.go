//go:build !linux

package pdfindex

// setNoCOW is a no-op off Linux: copy-on-write fragmentation is a btrfs
// matter (see nocow_linux.go).
func setNoCOW(string) error { return nil }
