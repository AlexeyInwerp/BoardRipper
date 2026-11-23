// Package archive unpacks ZIP, 7z and RAR files into a folder, keeping only
// the entries a caller wants. It is used by drop-to-library today; it takes a
// path on disk and a destination, nothing about uploads, so unpacking an
// archive already in the library can call it the same way.
//
// Every entry name is treated as hostile: absolute paths, `..` components and
// drive letters are refused (no zip-slip), and the total size, the size of one
// file and the number of files are capped (no archive bomb) — counted on the
// bytes actually written, not on the sizes the archive claims.
package archive

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/bodgit/sevenzip"
	"github.com/nwaples/rardecode/v2"
	"golang.org/x/text/encoding/simplifiedchinese"
)

// Kind names the archive format by extension: "zip", "7z", "rar" or "".
func Kind(name string) string {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".zip":
		return "zip"
	case ".7z":
		return "7z"
	case ".rar":
		return "rar"
	}
	return ""
}

// Limits bound one extraction.
type Limits struct {
	MaxFiles      int   // entries kept
	MaxTotalBytes int64 // bytes written, all entries
	MaxFileBytes  int64 // bytes written, one entry
}

// DefaultLimits suit a board archive: a few thousand files, a few GB.
var DefaultLimits = Limits{MaxFiles: 5000, MaxTotalBytes: 4 << 30, MaxFileBytes: 1 << 30}

var (
	// ErrEncrypted: the archive or an entry needs a password.
	ErrEncrypted = errors.New("the archive is password-protected")
	// ErrTooLarge: a limit was reached; what was written so far stays.
	ErrTooLarge = errors.New("the archive unpacks to more than the allowed size or file count")
)

// Entry is one extracted file.
type Entry struct {
	Rel  string // slash path inside the destination folder
	Path string // absolute path on disk
	Size int64
}

// Extract unpacks src into destDir. keep decides by entry path which entries
// are written; the rest are counted in skipped. The folders every kept
// entry shares are dropped (an archive of `X/board.brd` dropped as X.zip
// lands as `<dest>/board.brd`, not `<dest>/X/board.brd`). destDir is created
// on the first write.
func Extract(src, destDir string, keep func(rel string) bool, lim Limits) (written []Entry, skipped []string, err error) {
	var items []item
	switch Kind(src) {
	case "zip":
		items, err = zipItems(src)
	case "7z":
		items, err = sevenZipItems(src)
	case "rar":
		items, err = rarItems(src, func(name string) bool {
			rel, ok := cleanRel(name)
			return ok && !isJunk(rel) && keep(rel)
		}, lim)
	default:
		return nil, nil, fmt.Errorf("not an archive: %s", filepath.Base(src))
	}
	if err != nil {
		return nil, nil, normalise(err)
	}
	defer func() {
		for _, it := range items {
			if it.close != nil {
				it.close()
				break // one closer per archive, carried by the first item
			}
		}
	}()

	var kept []item
	for _, it := range items {
		rel, ok := cleanRel(it.name)
		if !ok || isJunk(rel) {
			continue
		}
		if !keep(rel) {
			skipped = append(skipped, rel)
			continue
		}
		it.name = rel
		kept = append(kept, it)
	}
	prefix := commonTop(kept)

	var total int64
	for _, it := range kept {
		if len(written) >= lim.MaxFiles {
			return written, skipped, ErrTooLarge
		}
		rel := strings.TrimPrefix(it.name, prefix)
		dst := filepath.Join(destDir, filepath.FromSlash(rel))
		if !within(destDir, dst) {
			continue
		}
		n, err := writeEntry(it, dst, min(lim.MaxFileBytes, lim.MaxTotalBytes-total))
		total += n
		if err != nil {
			return written, skipped, normalise(err)
		}
		written = append(written, Entry{Rel: rel, Path: dst, Size: n})
	}
	return written, skipped, nil
}

// item is one regular-file entry, opened lazily.
type item struct {
	name  string
	open  func() (io.ReadCloser, error)
	close func() error
}

func writeEntry(it item, dst string, limit int64) (int64, error) {
	if limit <= 0 {
		return 0, ErrTooLarge
	}
	rc, err := it.open()
	if err != nil {
		return 0, err
	}
	defer rc.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return 0, err
	}
	f, err := os.CreateTemp(filepath.Dir(dst), "."+filepath.Base(dst)+".*.part")
	if err != nil {
		return 0, err
	}
	tmp := f.Name()
	n, err := io.Copy(f, io.LimitReader(rc, limit+1))
	if err == nil && n > limit {
		err = ErrTooLarge
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(tmp)
		return 0, err
	}
	os.Chmod(tmp, 0o644)
	if err := os.Rename(tmp, dst); err != nil {
		os.Remove(tmp)
		return 0, err
	}
	return n, nil
}

func zipItems(src string) ([]item, error) {
	r, err := zip.OpenReader(src)
	if err != nil {
		return nil, err
	}
	var out []item
	for _, f := range r.File {
		if f.FileInfo().IsDir() || !f.Mode().IsRegular() {
			continue
		}
		if f.Flags&0x1 != 0 {
			r.Close()
			return nil, ErrEncrypted
		}
		out = append(out, item{name: zipName(f), open: f.Open})
	}
	if len(out) > 0 {
		out[0].close = r.Close
	} else {
		r.Close()
	}
	return out, nil
}

// zipName decodes an entry name. Without the UTF-8 flag (bit 11) the bytes
// are in the creator's code page — GBK for the Chinese-made archives that
// carry most boardviews — so a name that is not valid UTF-8 is read as GB18030.
func zipName(f *zip.File) string {
	if f.NonUTF8 && !utf8.ValidString(f.Name) {
		if s, err := simplifiedchinese.GB18030.NewDecoder().String(f.Name); err == nil {
			return s
		}
	}
	return f.Name
}

func sevenZipItems(src string) ([]item, error) {
	r, err := sevenzip.OpenReader(src)
	if err != nil {
		return nil, err
	}
	var out []item
	for _, f := range r.File {
		if f.FileInfo().IsDir() || !f.Mode().IsRegular() {
			continue
		}
		out = append(out, item{name: f.Name, open: f.Open})
	}
	if len(out) > 0 {
		out[0].close = r.Close
	} else {
		r.Close()
	}
	return out, nil
}

// rarItems reads a RAR front to back: entries are only readable in order, so
// each wanted one is buffered to a temp file as the walk passes it (unwanted
// entries are not written, and the buffer obeys the same limits). That keeps
// Extract's filter-first shape for all three formats.
func rarItems(src string, want func(name string) bool, lim Limits) ([]item, error) {
	r, err := rardecode.OpenReader(src)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	tmpDir, err := os.MkdirTemp(filepath.Dir(src), ".rar-*")
	if err != nil {
		return nil, err
	}
	var out []item
	var buffered int64
	for i := 0; ; i++ {
		h, err := r.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			os.RemoveAll(tmpDir)
			return nil, err
		}
		if h.IsDir || !h.Mode().IsRegular() {
			continue
		}
		if !want(h.Name) {
			// Still listed, so Extract can count it as skipped; never opened.
			out = append(out, item{name: h.Name, open: func() (io.ReadCloser, error) { return nil, errors.New("not buffered") }})
			continue
		}
		if h.Encrypted {
			os.RemoveAll(tmpDir)
			return nil, ErrEncrypted
		}
		p := filepath.Join(tmpDir, fmt.Sprintf("%d", i))
		f, err := os.Create(p)
		if err != nil {
			os.RemoveAll(tmpDir)
			return nil, err
		}
		n, err := io.Copy(f, io.LimitReader(r, lim.MaxFileBytes+1))
		f.Close()
		buffered += n
		if err == nil && (n > lim.MaxFileBytes || buffered > lim.MaxTotalBytes) {
			err = ErrTooLarge
		}
		if err != nil {
			os.RemoveAll(tmpDir)
			return nil, err
		}
		out = append(out, item{name: h.Name, open: func() (io.ReadCloser, error) { return os.Open(p) }})
	}
	closer := func() error { return os.RemoveAll(tmpDir) }
	if len(out) > 0 {
		out[0].close = closer
	} else {
		closer()
	}
	return out, nil
}

// cleanRel turns an entry name into a safe relative slash path, or false.
func cleanRel(name string) (string, bool) {
	n := strings.ReplaceAll(name, `\`, "/")
	if len(n) >= 2 && n[1] == ':' { // C:/…
		return "", false
	}
	if strings.HasPrefix(n, "/") {
		return "", false
	}
	for _, part := range strings.Split(n, "/") {
		if part == ".." {
			return "", false
		}
	}
	n = path.Clean(n)
	if n == "." || n == "" {
		return "", false
	}
	return n, true
}

// isJunk: macOS resource forks and dot-files carry no boards.
func isJunk(rel string) bool {
	for _, part := range strings.Split(rel, "/") {
		if part == "__MACOSX" || strings.HasPrefix(part, ".") {
			return true
		}
	}
	return false
}

// commonTop returns the folder path every entry shares ("A/B/" for
// A/B/x.brd and A/B/C/y.pdf), so a deeply nested archive lands flat: the NAS
// archive 820-1372.rar wraps its 52 boards in
// OwnCloud/Schematics-BV-EFI/Apple Boards By Number/.
func commonTop(items []item) string {
	if len(items) == 0 {
		return ""
	}
	dir := func(n string) string {
		if i := strings.LastIndex(n, "/"); i >= 0 {
			return n[:i+1]
		}
		return ""
	}
	prefix := dir(items[0].name)
	for _, it := range items[1:] {
		d := dir(it.name)
		for !strings.HasPrefix(d, prefix) {
			prefix = dir(strings.TrimSuffix(prefix, "/"))
		}
		if prefix == "" {
			break
		}
	}
	return prefix
}

func within(dir, p string) bool {
	rel, err := filepath.Rel(dir, p)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// normalise maps each library's password errors onto ErrEncrypted.
func normalise(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, rardecode.ErrArchiveEncrypted) || errors.Is(err, rardecode.ErrArchivedFileEncrypted) ||
		errors.Is(err, rardecode.ErrBadPassword) || strings.Contains(strings.ToLower(err.Error()), "password") {
		return ErrEncrypted
	}
	return err
}
