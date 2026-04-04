package boarddb

import "regexp"

// ODMPattern maps a compiled regex to the ODM (board manufacturer) that uses it.
type ODMPattern struct {
	ODM     string
	Type    string
	Pattern *regexp.Regexp
}

// Board number patterns use (?:^|[\s_\-/.,(]) as a left boundary instead of \b,
// because Go's \b treats underscores as word characters — filenames like
// "Quanta_Z8IA_DAZ8IAMBAC0" would fail to match with \b before DA.
// Right boundaries are omitted where revision suffixes may follow (e.g., R10, Rev1.0).

const lb = `(?:^|[\s_\-/.,(\[=])` // left boundary: start-of-string or common filename separators (incl. = for Apple archives)

// odmPatterns is the registry of all known board number patterns,
// ordered by specificity (most distinctive first).
var odmPatterns = []ODMPattern{
	{ODM: "Apple", Type: "apple_820", Pattern: regexp.MustCompile(`(?i)` + lb + `(820-\d{4,5}(?:-[A-Z0-9]+)?)`)},
	{ODM: "Apple", Type: "apple_661", Pattern: regexp.MustCompile(lb + `(661-\d{5})`)},
	// NM-D821 or NMD821 (LCFC files often omit the hyphen and append revision like R10)
	// Left boundary includes digits because LCFC project codes (JY575) end with digits before NM
	{ODM: "LCFC", Type: "lenovo_nm", Pattern: regexp.MustCompile(`(?i)(?:^|[\s_\-/.,(\[0-9])(NM-?[A-Z]\d{3,4})`)},
	{ODM: "Compal", Type: "compal_la", Pattern: regexp.MustCompile(`(?i)` + lb + `(LA-[A-Z]?\d{3,4}[A-Z]?)`)},
	{ODM: "Quanta", Type: "quanta_da0", Pattern: regexp.MustCompile(`(?i)` + lb + `(DA[0A-Z][A-Z0-9]{2,8}MB[0-9A-Z]{2,5})`)},
	{ODM: "ASUS", Type: "asus_60nb", Pattern: regexp.MustCompile(`(?i)` + lb + `(60N[BR][A-Z0-9]{4}-MB[A-Z0-9]{4,5})`)},
	{ODM: "Wistron", Type: "wistron_448", Pattern: regexp.MustCompile(lb + `(448\.\d{2}[A-Z]\d{2}\.\d{3,4})`)},
	{ODM: "Inventec", Type: "inventec_6050a", Pattern: regexp.MustCompile(lb + `(6050A\d{7,10})`)},
	{ODM: "Acer", Type: "acer_mb", Pattern: regexp.MustCompile(lb + `(MB\.[A-Z0-9]{5}\.\d{3})`)},
	{ODM: "Lenovo", Type: "lenovo_fru_new", Pattern: regexp.MustCompile(lb + `(5B\d{2}[A-Z]\d{5})`)},
	{ODM: "Lenovo", Type: "lenovo_fru_old", Pattern: regexp.MustCompile(lb + `(\d{2}X\d{4,5})`)},
	{ODM: "MSI", Type: "msi_ms", Pattern: regexp.MustCompile(`(?i)` + lb + `(MS-\d{4,5})`)},
	{ODM: "Sony", Type: "sony_mbx", Pattern: regexp.MustCompile(`(?i)` + lb + `(MBX-\d{2,3})`)},
	{ODM: "Samsung", Type: "samsung_ba", Pattern: regexp.MustCompile(lb + `(BA4[12]-\d{5})`)},
	{ODM: "Razer", Type: "razer_rz", Pattern: regexp.MustCompile(`(?i)` + lb + `(RZ09-\d{4})`)},
	{ODM: "Clevo", Type: "clevo", Pattern: regexp.MustCompile(`(?i)` + lb + `(N[HPB]\d{2}[A-Z]{2,4})`)},
	{ODM: "HP", Type: "hp_spare", Pattern: regexp.MustCompile(lb + `([A-Z]\d{5,6}-\d{3})`)},
	{ODM: "Samsung", Type: "samsung_sm", Pattern: regexp.MustCompile(`(?i)` + lb + `(SM-[A-Z]\d{3,4}[A-Z]?)`)},
	{ODM: "Wistron", Type: "wistron_numeric", Pattern: regexp.MustCompile(lb + `(\d{5,6}-\d[A-Z]?)`)},
}
