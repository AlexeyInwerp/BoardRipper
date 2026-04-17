// scan-allegro: one-time helper to find small Allegro BRD files in a directory.
//
// Walks a directory tree, reads the first 4 bytes of every .brd file, and
// matches the magic against Cadence Allegro version codes (same table as
// src/frontend/src/parsers/allegro/allegro-header.ts). Prints matches sorted
// by size ascending.
//
// Usage:
//   go run pldhelper/scan-allegro.go --root /library
//   go run pldhelper/scan-allegro.go --root /library --version 16.4 --n 30
package main

import (
	"encoding/binary"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type hit struct {
	path    string
	size    int64
	version string
	magic   uint32
}

func versionFromMagic(magic uint32) string {
	switch magic & 0xFFFFFF00 {
	case 0x00130000:
		return "16.0"
	case 0x00130400:
		return "16.2"
	case 0x00130C00:
		return "16.4"
	case 0x00131000:
		return "16.5"
	case 0x00131500:
		return "16.6"
	case 0x00140400, 0x00140500, 0x00140600, 0x00140700:
		return "17.2"
	case 0x00140900, 0x00140E00:
		return "17.4"
	case 0x00141500:
		return "17.5"
	case 0x00150000:
		return "18.0"
	}
	if (magic>>16)&0xFFFF <= 0x0012 {
		return "pre-16"
	}
	return ""
}

func readMagic(path string) (uint32, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	var buf [4]byte
	n, err := f.Read(buf[:])
	if err != nil || n < 4 {
		return 0, errors.New("short read")
	}
	return binary.LittleEndian.Uint32(buf[:]), nil
}

func main() {
	root := flag.String("root", ".", "directory to scan (recursive)")
	versionFilter := flag.String("version", "", "filter by version string, e.g. 16.4")
	limit := flag.Int("n", 20, "number of smallest results to print (0 = all)")
	verbose := flag.Bool("v", false, "print scan progress to stderr")
	flag.Parse()

	var hits []hit
	scanned := 0
	err := filepath.WalkDir(*root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if *verbose {
				fmt.Fprintln(os.Stderr, "skip:", p, err)
			}
			if d != nil && d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if !strings.EqualFold(filepath.Ext(p), ".brd") {
			return nil
		}
		scanned++
		magic, err := readMagic(p)
		if err != nil {
			return nil
		}
		ver := versionFromMagic(magic)
		if ver == "" {
			return nil
		}
		if *versionFilter != "" && ver != *versionFilter {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		hits = append(hits, hit{p, info.Size(), ver, magic})
		return nil
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "walk error:", err)
		os.Exit(1)
	}

	sort.Slice(hits, func(i, j int) bool { return hits[i].size < hits[j].size })

	show := len(hits)
	if *limit > 0 && *limit < show {
		show = *limit
	}

	fmt.Fprintf(os.Stderr, "scanned %d .brd files, %d matched%s\n",
		scanned, len(hits),
		func() string {
			if *versionFilter != "" {
				return " version " + *versionFilter
			}
			return ""
		}())
	fmt.Printf("%-12s %-8s %-12s %s\n", "SIZE", "VERSION", "MAGIC", "PATH")
	for _, h := range hits[:show] {
		fmt.Printf("%-12d %-8s 0x%08x   %s\n", h.size, h.version, h.magic, h.path)
	}
}
