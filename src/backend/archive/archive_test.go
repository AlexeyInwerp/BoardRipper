package archive

import (
	"archive/zip"
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"golang.org/x/text/encoding/simplifiedchinese"
)

func boardsAndPdfs(rel string) bool {
	ext := strings.ToLower(filepath.Ext(rel))
	return ext == ".brd" || ext == ".bv" || ext == ".pdf"
}

type zentry struct {
	name    string
	body    string
	nonUTF8 bool
	flags   uint16
}

func writeZip(t *testing.T, entries []zentry) string {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, e := range entries {
		w, err := zw.CreateHeader(&zip.FileHeader{Name: e.name, NonUTF8: e.nonUTF8, Flags: e.flags, Method: zip.Deflate})
		if err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(e.body))
	}
	zw.Close()
	p := filepath.Join(t.TempDir(), "drop.zip")
	if err := os.WriteFile(p, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func rels(es []Entry) []string {
	var out []string
	for _, e := range es {
		out = append(out, e.Rel)
	}
	sort.Strings(out)
	return out
}

func TestExtractZipKeepsBoardsDropsTopFolderAndJunk(t *testing.T) {
	src := writeZip(t, []zentry{
		{name: "Board/a.brd", body: "A"},
		{name: "Board/sub/s.pdf", body: "P"},
		{name: "Board/readme.txt", body: "T"},
		{name: "__MACOSX/Board/._a.brd", body: "junk"},
		{name: "Board/.DS_Store", body: "junk"},
	})
	dest := t.TempDir()
	got, skipped, err := Extract(src, dest, boardsAndPdfs, DefaultLimits)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"a.brd", "sub/s.pdf"}; strings.Join(rels(got), ",") != strings.Join(want, ",") {
		t.Fatalf("written %v, want %v", rels(got), want)
	}
	if len(skipped) != 1 || skipped[0] != "Board/readme.txt" {
		t.Fatalf("skipped %v", skipped)
	}
	if b, _ := os.ReadFile(filepath.Join(dest, "sub", "s.pdf")); string(b) != "P" {
		t.Fatalf("s.pdf content %q", b)
	}
}

func TestExtractRefusesPathsOutsideTheFolder(t *testing.T) {
	src := writeZip(t, []zentry{
		{name: "../evil.brd", body: "x"},
		{name: "/abs.brd", body: "x"},
		{name: `C:\win.brd`, body: "x"},
		{name: "ok/../../up.brd", body: "x"},
		{name: "good.brd", body: "g"},
	})
	parent := t.TempDir()
	dest := filepath.Join(parent, "out")
	got, _, err := Extract(src, dest, boardsAndPdfs, DefaultLimits)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(rels(got), ",") != "good.brd" {
		t.Fatalf("written %v", rels(got))
	}
	for _, n := range []string{"evil.brd", "up.brd", "abs.brd", "win.brd"} {
		if _, err := os.Stat(filepath.Join(parent, n)); err == nil {
			t.Fatalf("%s escaped the destination", n)
		}
	}
}

func TestExtractReadsGBKNames(t *testing.T) {
	gbk, _ := simplifiedchinese.GBK.NewEncoder().String("M1 MAX点位图.brd")
	src := writeZip(t, []zentry{{name: gbk, body: "b", nonUTF8: true}})
	got, _, err := Extract(src, t.TempDir(), boardsAndPdfs, DefaultLimits)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Rel != "M1 MAX点位图.brd" {
		t.Fatalf("written %v", rels(got))
	}
}

func TestExtractReportsPasswordProtectedZip(t *testing.T) {
	src := writeZip(t, []zentry{{name: "a.brd", body: "x", flags: 0x1}})
	if _, _, err := Extract(src, t.TempDir(), boardsAndPdfs, DefaultLimits); !errors.Is(err, ErrEncrypted) {
		t.Fatalf("err = %v, want ErrEncrypted", err)
	}
}

func TestExtractStopsAtLimits(t *testing.T) {
	src := writeZip(t, []zentry{{name: "a.brd", body: strings.Repeat("x", 100)}, {name: "b.brd", body: "y"}})
	_, _, err := Extract(src, t.TempDir(), boardsAndPdfs, Limits{MaxFiles: 10, MaxTotalBytes: 1 << 20, MaxFileBytes: 50})
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("per-file: err = %v", err)
	}
	got, _, err := Extract(src, t.TempDir(), boardsAndPdfs, Limits{MaxFiles: 1, MaxTotalBytes: 1 << 20, MaxFileBytes: 1 << 20})
	if !errors.Is(err, ErrTooLarge) || len(got) != 1 {
		t.Fatalf("file count: err = %v, written %d", err, len(got))
	}
}

func TestExtract7z(t *testing.T) {
	// testdata/board.7z: Board/a.brd, Board/s.pdf, Board/readme.txt (written by bsdtar --format 7zip).
	got, skipped, err := Extract(filepath.Join("testdata", "board.7z"), t.TempDir(), boardsAndPdfs, DefaultLimits)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(rels(got), ",") != "a.brd,s.pdf" || len(skipped) != 1 {
		t.Fatalf("written %v skipped %v", rels(got), skipped)
	}
}

func TestCommonTopStripsEverySharedLevel(t *testing.T) {
	src := writeZip(t, []zentry{{name: "A/B/x.brd", body: "1"}, {name: "A/B/C/y.pdf", body: "2"}, {name: "A/B/D/z.brd", body: "3"}})
	got, _, _ := Extract(src, t.TempDir(), boardsAndPdfs, DefaultLimits)
	if strings.Join(rels(got), ",") != "C/y.pdf,D/z.brd,x.brd" {
		t.Fatalf("written %v", rels(got))
	}
}

func TestKind(t *testing.T) {
	for name, want := range map[string]string{"a.ZIP": "zip", "b.7z": "7z", "c.Rar": "rar", "d.brd": "", "e.tar": ""} {
		if Kind(name) != want {
			t.Errorf("Kind(%q) = %q, want %q", name, Kind(name), want)
		}
	}
}

// Real archives from the NAS, local only (samples/ is not in git).
func TestExtractLocalSamples(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "samples", "incoming", "archives")
	cases := []struct {
		file    string
		written int
		hasName string
	}{
		{"820-1372.rar", 52, "820-1372/LB# 820-1372  ''Board View'' file.bv"},
		{"A2442_820-02443 M1 MAX boardview.zip", 1, "A2442_820-02443 M1 MAX点位图.brd"},
		{"vinafix.vn_A1286 820-3330-B_8MB.rar", 0, ""},
	}
	for _, c := range cases {
		p := filepath.Join(dir, c.file)
		if _, err := os.Stat(p); err != nil {
			t.Logf("skip %s: not present", c.file)
			continue
		}
		got, skipped, err := Extract(p, t.TempDir(), boardsAndPdfs, DefaultLimits)
		if err != nil {
			t.Fatalf("%s: %v", c.file, err)
		}
		if len(got) != c.written {
			t.Fatalf("%s: written %d (%v), want %d; skipped %d", c.file, len(got), rels(got), c.written, len(skipped))
		}
		if c.hasName != "" && !strings.Contains(strings.Join(rels(got), "\n"), c.hasName) {
			t.Fatalf("%s: %q not among %v", c.file, c.hasName, rels(got)[:3])
		}
		t.Logf("%s: %d written, %d left out", c.file, len(got), len(skipped))
	}
}
