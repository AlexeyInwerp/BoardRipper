package handlers

import (
	"encoding/json"
	"net/http/httptest"
	"strconv"
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
