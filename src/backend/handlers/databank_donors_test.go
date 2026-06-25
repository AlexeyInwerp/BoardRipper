package handlers

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"boardripper/databank"
)

type fakeDonorIndexer struct {
	ensured  [][]int64
	statuses map[int64]string
}

func (f *fakeDonorIndexer) EnsureIndexed(ids []int64) { f.ensured = append(f.ensured, ids) }
func (f *fakeDonorIndexer) StatusFor(ids []int64) map[int64]string { return f.statuses }

// donorTestHandler opens a temp databank, migrates the donor table, inserts one
// PDF file, and returns the handler + the file id.
func donorTestHandler(t *testing.T) (*DatabankHandler, *databank.DB, int64) {
	t.Helper()
	db, err := databank.Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := db.MigratePdfIndexV1(); err != nil {
		t.Fatalf("MigratePdfIndexV1: %v", err)
	}
	id, err := db.InsertFile(&databank.FileRecord{
		Path: "docs/x.pdf", Filename: "x.pdf", Extension: ".pdf", FileType: "pdf",
	})
	if err != nil {
		t.Fatalf("InsertFile: %v", err)
	}
	return NewDatabankHandler(db, nil, t.TempDir()), db, id
}

func TestAddDonorTriggersEnsureIndexed(t *testing.T) {
	h, _, id := donorTestHandler(t)
	fi := &fakeDonorIndexer{}
	h.SetDonorIndexer(fi)

	req := httptest.NewRequest("PUT", "/api/databank/donors/"+strconv.FormatInt(id, 10), nil)
	req.SetPathValue("id", strconv.FormatInt(id, 10))
	rec := httptest.NewRecorder()
	h.AddDonor(rec, req)

	if rec.Code != 200 {
		t.Fatalf("AddDonor status = %d body=%s", rec.Code, rec.Body.String())
	}
	if len(fi.ensured) != 1 || len(fi.ensured[0]) != 1 || fi.ensured[0][0] != id {
		t.Fatalf("EnsureIndexed calls = %v, want [[%d]]", fi.ensured, id)
	}
}

func TestListDonorsEnrichesIndexStatus(t *testing.T) {
	h, db, id := donorTestHandler(t)
	if err := db.AddDonor(id); err != nil {
		t.Fatalf("AddDonor: %v", err)
	}
	h.SetDonorIndexer(&fakeDonorIndexer{statuses: map[int64]string{id: "indexed"}})

	req := httptest.NewRequest("GET", "/api/databank/donors", nil)
	rec := httptest.NewRecorder()
	h.ListDonors(rec, req)

	var got []databank.DonorEntry
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v body=%s", err, rec.Body.String())
	}
	if len(got) != 1 || got[0].IndexStatus != "indexed" {
		t.Fatalf("donors = %+v, want one with index_status=indexed", got)
	}
}

func TestListDonorsNilIndexerOmitsStatus(t *testing.T) {
	h, db, id := donorTestHandler(t)
	if err := db.AddDonor(id); err != nil {
		t.Fatalf("AddDonor: %v", err)
	}
	// No SetDonorIndexer → donorIndexer is nil.
	req := httptest.NewRequest("GET", "/api/databank/donors", nil)
	rec := httptest.NewRecorder()
	h.ListDonors(rec, req)
	var got []databank.DonorEntry
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if len(got) != 1 || got[0].IndexStatus != "" {
		t.Fatalf("donors = %+v, want one with empty index_status", got)
	}
}

func TestResetWritesDonorSnapshotThenRestore(t *testing.T) {
	dataDir := t.TempDir()
	db, err := databank.Open(dataDir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := db.MigratePdfIndexV1(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	id, _ := db.InsertFile(&databank.FileRecord{Path: "docs/keep.pdf", Filename: "keep.pdf", Extension: ".pdf", FileType: "pdf"})
	if err := db.AddDonor(id); err != nil {
		t.Fatalf("AddDonor: %v", err)
	}

	scanner := databank.NewScanner(db, dataDir, "")
	h := NewDatabankHandler(db, scanner, dataDir)
	fi := &fakeDonorIndexer{}
	h.SetDonorIndexer(fi)

	// Reset: snapshot first, then wipe.
	rec := httptest.NewRecorder()
	h.Reset(rec, httptest.NewRequest("POST", "/api/databank/reset", nil))
	if rec.Code != 200 {
		t.Fatalf("Reset = %d body=%s", rec.Code, rec.Body.String())
	}
	infos, _ := databank.ListDonorSnapshots(filepath.Join(dataDir, "backups"))
	if len(infos) != 1 || infos[0].Count != 1 {
		t.Fatalf("snapshots after reset = %+v, want one with count 1", infos)
	}

	// Re-insert the same path with a NEW id (simulates a rescan after reset).
	// Insert a dummy row first to bump SQLite's max-rowid counter so the real
	// insert gets a different id (SQLite without AUTOINCREMENT reuses max+1).
	db.InsertFile(&databank.FileRecord{Path: "dummy/bump.pdf", Filename: "bump.pdf", Extension: ".pdf", FileType: "pdf"})
	newID, _ := db.InsertFile(&databank.FileRecord{Path: "docs/keep.pdf", Filename: "keep.pdf", Extension: ".pdf", FileType: "pdf"})
	if newID == id {
		t.Fatal("expected a fresh autoincrement id after reset")
	}

	// Restore latest.
	rec = httptest.NewRecorder()
	h.RestoreDonors(rec, httptest.NewRequest("POST", "/api/databank/donors/restore", strings.NewReader(`{}`)))
	if rec.Code != 200 {
		t.Fatalf("Restore = %d body=%s", rec.Code, rec.Body.String())
	}
	var res struct {
		Restored int      `json:"restored"`
		Skipped  []string `json:"skipped"`
	}
	json.Unmarshal(rec.Body.Bytes(), &res)
	if res.Restored != 1 {
		t.Fatalf("restored = %+v, want 1", res)
	}
	donors, _ := db.ListDonors()
	if len(donors) != 1 || donors[0].FileID != newID {
		t.Fatalf("donors after restore = %+v, want new id %d", donors, newID)
	}
}

func TestImportSkipsMissingPath(t *testing.T) {
	h, _, _ := donorTestHandler(t)
	h.SetDonorIndexer(&fakeDonorIndexer{})
	body := `{"version":1,"created_at":1,"donors":[{"path":"docs/x.pdf","added_at":1},{"path":"gone/missing.pdf","added_at":2}]}`
	rec := httptest.NewRecorder()
	h.ImportDonors(rec, httptest.NewRequest("POST", "/api/databank/donors/import", strings.NewReader(body)))
	var res struct {
		Restored int      `json:"restored"`
		Skipped  []string `json:"skipped"`
	}
	json.Unmarshal(rec.Body.Bytes(), &res)
	if res.Restored != 1 || len(res.Skipped) != 1 || res.Skipped[0] != "gone/missing.pdf" {
		t.Fatalf("import result = %+v, want restored 1 / skipped [gone/missing.pdf]", res)
	}
}

// TestImportContentHashNonPdfSkipped verifies that the content_hash fallback in
// resolveDonorPath refuses to resolve when the canonical file for that hash is
// not a PDF. We insert the non-PDF first so it gets the lower id (MIN) and
// becomes the canonical; the PDF gets a higher id. The snapshot entry has a
// missing path and a content_hash pointing at that shared hash. The import must
// skip the entry (canonical is brd, not pdf). We also confirm the donor list
// never contains the non-pdf file id.
func TestImportContentHashNonPdfSkipped(t *testing.T) {
	db, err := databank.Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := db.MigratePdfIndexV1(); err != nil {
		t.Fatalf("MigratePdfIndexV1: %v", err)
	}

	// Insert non-PDF first → lower id → becomes canonical (MIN id).
	brdID, err := db.InsertFile(&databank.FileRecord{
		Path: "boards/x.brd", Filename: "x.brd", Extension: ".brd", FileType: "brd",
	})
	if err != nil {
		t.Fatalf("InsertFile brd: %v", err)
	}
	// Insert PDF second → higher id.
	pdfID, err := db.InsertFile(&databank.FileRecord{
		Path: "docs/x.pdf", Filename: "x.pdf", Extension: ".pdf", FileType: "pdf",
	})
	if err != nil {
		t.Fatalf("InsertFile pdf: %v", err)
	}
	if brdID >= pdfID {
		t.Fatalf("expected brdID(%d) < pdfID(%d) for canonical test", brdID, pdfID)
	}

	// Give both files the same content_hash.
	sharedHash := []byte("deadbeefdeadbeefdeadbeef12345678") // 32-byte arbitrary
	if err := db.SetContentHash(brdID, sharedHash); err != nil {
		t.Fatalf("SetContentHash brd: %v", err)
	}
	if err := db.SetContentHash(pdfID, sharedHash); err != nil {
		t.Fatalf("SetContentHash pdf: %v", err)
	}

	h := NewDatabankHandler(db, nil, t.TempDir())
	h.SetDonorIndexer(&fakeDonorIndexer{})

	// Snapshot entry: missing path (forces hash fallback), hash points to shared hash.
	hashHex := fmt.Sprintf("%x", sharedHash)
	body := `{"version":1,"created_at":1,"donors":[{"path":"gone/missing.pdf","content_hash":"` + hashHex + `","added_at":1}]}`
	rec := httptest.NewRecorder()
	h.ImportDonors(rec, httptest.NewRequest("POST", "/api/databank/donors/import", strings.NewReader(body)))

	var res struct {
		Restored int      `json:"restored"`
		Skipped  []string `json:"skipped"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatalf("decode: %v body=%s", err, rec.Body.String())
	}
	if res.Restored != 0 {
		t.Fatalf("restored = %d, want 0 (canonical is non-pdf, must skip)", res.Restored)
	}

	// Confirm the non-pdf file id was never added as a donor.
	donors, err := db.ListDonors()
	if err != nil {
		t.Fatalf("ListDonors: %v", err)
	}
	for _, d := range donors {
		if d.FileID == brdID {
			t.Fatalf("donor list contains brd file id %d — non-pdf must never be a donor", brdID)
		}
	}
}
