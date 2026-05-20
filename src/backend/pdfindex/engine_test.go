package pdfindex

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func samplePdf(t *testing.T) []byte {
	t.Helper()
	p := filepath.Join("..", "..", "..", "samples", "820-00239", "820-00239.pdf")
	data, err := os.ReadFile(p)
	if err != nil {
		t.Skip("sample PDF absent — skipping engine test")
	}
	return data
}

func TestEngineExtractsText(t *testing.T) {
	data := samplePdf(t)
	eng, err := NewEngine(1)
	if err != nil {
		t.Fatalf("NewEngine: %v", err)
	}
	defer eng.Close()

	pages, err := eng.ExtractFile(data)
	if err != nil {
		t.Fatalf("ExtractFile: %v", err)
	}
	if len(pages) == 0 {
		t.Fatal("no pages extracted")
	}
	joined := strings.ToLower(strings.Join(pages, "\n"))
	for _, term := range []string{"connector", "schematic"} {
		if !strings.Contains(joined, term) {
			t.Errorf("expected extracted text to contain %q", term)
		}
	}
}
