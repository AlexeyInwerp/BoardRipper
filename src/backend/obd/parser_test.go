package obd

import (
	"os"
	"strings"
	"testing"
)

func loadFixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return string(b)
}

func TestParse_HappyPath(t *testing.T) {
	data, err := Parse(loadFixture(t, "sample.obd.txt"))
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}

	if data.Header.ID == nil || *data.Header.ID != "demo-id-42" {
		t.Errorf("Header.ID = %v, want demo-id-42", data.Header.ID)
	}
	if data.Header.Brand == nil || *data.Header.Brand != "apple" {
		t.Errorf("Header.Brand = %v, want apple", data.Header.Brand)
	}
	if !strings.Contains(data.Diagnosis, "Won't power on") {
		t.Errorf("Diagnosis missing expected line: %q", data.Diagnosis)
	}

	// C1804 has three attrs.
	var c1804 *Component
	for i := range data.Components {
		if data.Components[i].Refdes == "C1804" {
			c1804 = &data.Components[i]
			break
		}
	}
	if c1804 == nil {
		t.Fatal("C1804 not found in components")
	}
	if got := c1804.Attrs["m"]; got != "6.3V" {
		t.Errorf("C1804 m = %q, want 6.3V", got)
	}
	if got := c1804.Attrs["p"]; got != "0201" {
		t.Errorf("C1804 p = %q, want 0201", got)
	}

	// PP3V3_S0_REG has all three scalars + alias + comment.
	var pp *Net
	for i := range data.Nets {
		if data.Nets[i].Name == "PP3V3_S0_REG" {
			pp = &data.Nets[i]
			break
		}
	}
	if pp == nil {
		t.Fatal("PP3V3_S0_REG not found in nets")
	}
	if pp.Diode == nil || *pp.Diode != "0.450" {
		t.Errorf("Diode = %v, want 0.450", pp.Diode)
	}
	if pp.Voltage == nil || *pp.Voltage != "3.30" {
		t.Errorf("Voltage = %v, want 3.30", pp.Voltage)
	}
	if pp.Resistance == nil || *pp.Resistance != "47k" {
		t.Errorf("Resistance = %v, want 47k", pp.Resistance)
	}
	if len(pp.Aliases) != 1 || pp.Aliases[0] != "PP3V3_REG" {
		t.Errorf("Aliases = %v, want [PP3V3_REG]", pp.Aliases)
	}
	if len(pp.Comments) != 1 {
		t.Errorf("Comments len = %d, want 1", len(pp.Comments))
	}
}

func TestParse_RejectsMissingMagic(t *testing.T) {
	if _, err := Parse("not an OBDATA file\n"); err == nil {
		t.Error("expected error on missing OBDATA_V002 magic, got nil")
	}
}

func TestParse_SkipsCommentsAndBlanks(t *testing.T) {
	src := `OBDATA_V002
BRAND apple

### inline doc comment

NETS_DATA_START
### docs
A/Default d 0.1 ''
NETS_DATA_END
`
	data, err := Parse(src)
	if err != nil {
		t.Fatalf("Parse error: %v", err)
	}
	if len(data.Nets) != 1 || data.Nets[0].Name != "A" {
		t.Errorf("Expected single net A, got %v", data.Nets)
	}
}

func TestParse_DuplicateAttr_LastWins(t *testing.T) {
	src := `OBDATA_V002
COMPONENTS_DATA_START
C1 m FIRST
C1 m SECOND
COMPONENTS_DATA_END
`
	data, err := Parse(src)
	if err != nil {
		t.Fatalf("Parse error: %v", err)
	}
	if len(data.Components) != 1 || data.Components[0].Attrs["m"] != "SECOND" {
		t.Errorf("Expected last-write-wins, got %v", data.Components)
	}
}

func TestParse_UnknownNetType_Dropped(t *testing.T) {
	src := `OBDATA_V002
NETS_DATA_START
A/Default d 0.1 ''
A/Default x 999 ''
NETS_DATA_END
`
	data, err := Parse(src)
	if err != nil {
		t.Fatalf("Parse error: %v", err)
	}
	if len(data.Nets) != 1 || data.Nets[0].Diode == nil {
		t.Errorf("Expected one net with diode set, got %v", data.Nets)
	}
}

// TestParse_RealHeaderBlock verifies headers are read from inside the
// HEADER_DATA_START/END block — the actual shape openboarddata.org
// serves. The first physical line is the section delimiter, NOT the
// magic.
func TestParse_RealHeaderBlock(t *testing.T) {
	src := `HEADER_DATA_START
OBDATA_V002 https://openboarddata.org
TIMESTAMP 1777617215
BOARDPATH laptops/apple/820-00165
ID 820-00165
BRAND apple
HEADER_DATA_END
NETS_DATA_START
PP_X/Default d 0.5 ''
NETS_DATA_END
`
	data, err := Parse(src)
	if err != nil {
		t.Fatalf("Parse error: %v", err)
	}
	if data.Header.ID == nil || *data.Header.ID != "820-00165" {
		t.Errorf("Header.ID = %v, want 820-00165", data.Header.ID)
	}
	if data.Header.Brand == nil || *data.Header.Brand != "apple" {
		t.Errorf("Header.Brand = %v, want apple", data.Header.Brand)
	}
	if len(data.Nets) != 1 {
		t.Errorf("expected 1 net, got %v", data.Nets)
	}
}

// TestParse_StructuredDiagnosis verifies the SECT_START/NOTE_START
// hierarchy round-trips into ObdData.Sections. Body text including
// inline references is preserved verbatim — the frontend renders the
// `[n:NET]` and `[p:PART]` tokens as clickable chips.
func TestParse_StructuredDiagnosis(t *testing.T) {
	src := `OBDATA_V002
DIAGNOSIS_DATA_START
SECT_START Backlight
NOTE_START Diagnosing
Check your voltage on backlight output.
If 8.4V check EN signal on [p:U7701:3], if present, check [n:BKL_PWM].
NOTE_END
SECT_END
SECT_START Power Rails
NOTE_START S5
[n:PPBUS_G3H]
[n:PP3V42_G3H]
NOTE_END
NOTE_START S0
[n:PP1V05_S0]
[n:PPVCC_S0_CPU]
NOTE_END
SECT_END
DIAGNOSIS_DATA_END
`
	data, err := Parse(src)
	if err != nil {
		t.Fatalf("Parse error: %v", err)
	}
	if len(data.Sections) != 2 {
		t.Fatalf("expected 2 sections, got %d: %+v", len(data.Sections), data.Sections)
	}
	if data.Sections[0].Title != "Backlight" {
		t.Errorf("section 0 title = %q, want Backlight", data.Sections[0].Title)
	}
	if len(data.Sections[0].Notes) != 1 || data.Sections[0].Notes[0].Title != "Diagnosing" {
		t.Errorf("section 0 notes = %+v", data.Sections[0].Notes)
	}
	if !strings.Contains(data.Sections[0].Notes[0].Body, "[n:BKL_PWM]") {
		t.Errorf("note body lost the [n:BKL_PWM] reference: %q", data.Sections[0].Notes[0].Body)
	}
	if len(data.Sections[1].Notes) != 2 {
		t.Errorf("Power Rails should have 2 notes (S5, S0), got %d", len(data.Sections[1].Notes))
	}
	if data.Sections[1].Notes[0].Title != "S5" || data.Sections[1].Notes[1].Title != "S0" {
		t.Errorf("note titles = %+v", data.Sections[1].Notes)
	}
	if !strings.Contains(data.Diagnosis, "Check your voltage") {
		t.Errorf("legacy raw Diagnosis lost text: %q", data.Diagnosis)
	}
}

// TestParse_DiagnosisDefensive: section / note left unterminated at
// EOF should still flush — guards against malformed upstream files.
func TestParse_DiagnosisDefensive(t *testing.T) {
	src := `OBDATA_V002
DIAGNOSIS_DATA_START
SECT_START Loose
NOTE_START Trailing
some body text
` // no NOTE_END, no SECT_END, no DIAGNOSIS_DATA_END
	data, err := Parse(src)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if len(data.Sections) != 1 || len(data.Sections[0].Notes) != 1 {
		t.Fatalf("expected one section + one note, got %+v", data.Sections)
	}
	if !strings.Contains(data.Sections[0].Notes[0].Body, "some body text") {
		t.Errorf("body not flushed: %q", data.Sections[0].Notes[0].Body)
	}
}
