package handlers

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"boardripper/databank"
)

func zipBytes(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(body))
	}
	zw.Close()
	return buf.Bytes()
}

type archiveResp struct {
	Status  string `json:"status"`
	Folder  string `json:"folder"`
	Skipped int    `json:"skipped"`
	Files   []struct {
		Name, Path, Status, FileType string
		ID                           int64
	} `json:"files"`
}

func TestUpload_ArchiveUnpacksBoardsIntoItsOwnFolder(t *testing.T) {
	root := t.TempDir()
	var indexed []string
	h := NewFileHandler(root, func() string { return root }, nil, func(rel string, _ []byte) (*databank.FileRecord, error) {
		indexed = append(indexed, rel)
		ft := "board"
		if filepath.Ext(rel) == ".pdf" {
			ft = "pdf"
		}
		return &databank.FileRecord{ID: int64(len(indexed)), FileType: ft, Path: rel}, nil
	})
	body := zipBytes(t, map[string]string{
		"X1190/820-01041.brd":     "BRD",
		"X1190/sch/820-01041.pdf": "%PDF",
		"X1190/BoardViewer.exe":   "MZ",
	})
	w := httptest.NewRecorder()
	h.Upload(w, multipartUpload(t, "X1190 Rev 1.0.zip", body))
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var r archiveResp
	if err := json.Unmarshal(w.Body.Bytes(), &r); err != nil {
		t.Fatal(err)
	}
	if r.Status != "unpacked" || r.Folder != "incoming/X1190 Rev 1.0" || r.Skipped != 1 || len(r.Files) != 2 {
		t.Fatalf("response %+v", r)
	}
	for _, rel := range []string{"X1190 Rev 1.0/820-01041.brd", "X1190 Rev 1.0/sch/820-01041.pdf"} {
		if _, err := os.Stat(filepath.Join(root, "incoming", filepath.FromSlash(rel))); err != nil {
			t.Fatalf("%s not written: %v", rel, err)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "incoming", "X1190 Rev 1.0", "BoardViewer.exe")); err == nil {
		t.Fatal("the exe must stay in the archive")
	}
	if len(indexed) != 2 {
		t.Fatalf("indexed %v", indexed)
	}
	// Nothing hidden left behind: no archive copy, no staging folder.
	entries, _ := os.ReadDir(filepath.Join(root, "incoming"))
	if len(entries) != 1 || entries[0].Name() != "X1190 Rev 1.0" {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("incoming/ holds %v", names)
	}
}

func TestUpload_ArchiveOfDuplicatesLeavesNoFolder(t *testing.T) {
	root := t.TempDir()
	h := NewFileHandler(root, func() string { return root }, nil, nil)
	h.SetDedupFunc(func(string, int64) (*databank.FileRecord, []byte, error) {
		return &databank.FileRecord{ID: 5, FileType: "board", Path: "Apple/a.brd"}, nil, nil
	})
	w := httptest.NewRecorder()
	h.Upload(w, multipartUpload(t, "again.zip", zipBytes(t, map[string]string{"a.brd": "B"})))
	var r archiveResp
	json.Unmarshal(w.Body.Bytes(), &r)
	if len(r.Files) != 1 || r.Files[0].Status != "exists" || r.Files[0].Path != "Apple/a.brd" {
		t.Fatalf("response %+v", r)
	}
	if _, err := os.Stat(filepath.Join(root, "incoming", "again")); !os.IsNotExist(err) {
		t.Fatalf("an all-duplicate archive must not leave a folder (err=%v)", err)
	}
}

func TestUpload_ArchiveFolderNameCollisionGetsANumber(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "incoming", "LA-L663P Rev 1.0"), 0o755)
	h := NewFileHandler(root, func() string { return root }, nil, nil)
	w := httptest.NewRecorder()
	h.Upload(w, multipartUpload(t, "LA-L663P Rev 1.0.zip", zipBytes(t, map[string]string{"b.fz": "F"})))
	var r archiveResp
	json.Unmarshal(w.Body.Bytes(), &r)
	if r.Folder != "incoming/LA-L663P Rev 1.0 (2)" {
		t.Fatalf("folder %q", r.Folder)
	}
}

func TestUpload_ArchiveWithoutBoardsSaysSo(t *testing.T) {
	root := t.TempDir()
	h := NewFileHandler(root, func() string { return root }, nil, nil)
	w := httptest.NewRecorder()
	h.Upload(w, multipartUpload(t, "bios.zip", zipBytes(t, map[string]string{"A1286.bin": "x"})))
	var r archiveResp
	json.Unmarshal(w.Body.Bytes(), &r)
	if w.Code != http.StatusOK || len(r.Files) != 0 || r.Skipped != 1 {
		t.Fatalf("%d %+v", w.Code, r)
	}
	if _, err := os.Stat(filepath.Join(root, "incoming", "bios")); !os.IsNotExist(err) {
		t.Fatal("no folder for an archive with nothing to keep")
	}
}

func TestUpload_BrokenArchiveIsA400(t *testing.T) {
	root := t.TempDir()
	h := NewFileHandler(root, func() string { return root }, nil, nil)
	w := httptest.NewRecorder()
	h.Upload(w, multipartUpload(t, "broken.zip", []byte("not a zip")))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
	}
	entries, _ := os.ReadDir(filepath.Join(root, "incoming"))
	if len(entries) != 0 {
		t.Fatalf("incoming/ should be empty, got %d entries", len(entries))
	}
}
