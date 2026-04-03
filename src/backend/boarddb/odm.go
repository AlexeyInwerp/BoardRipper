package boarddb

import "regexp"

// ODMPattern maps a compiled regex to the ODM (board manufacturer) that uses it.
type ODMPattern struct {
	ODM     string
	Type    string
	Pattern *regexp.Regexp
}

// odmPatterns is the registry of all known board number patterns,
// ordered by specificity (most distinctive first).
var odmPatterns = []ODMPattern{
	{ODM: "Apple", Type: "apple_820", Pattern: regexp.MustCompile(`(?i)\b820-\d{4,5}(?:-[A-Z])?\b`)},
	{ODM: "Apple", Type: "apple_661", Pattern: regexp.MustCompile(`\b661-\d{5}\b`)},
	// NM-D821 or NMD821 (LCFC files often omit the hyphen and append revision like R10)
	{ODM: "LCFC", Type: "lenovo_nm", Pattern: regexp.MustCompile(`(?i)NM-?[A-Z]\d{3,4}`)},
	{ODM: "Compal", Type: "compal_la", Pattern: regexp.MustCompile(`(?i)\bLA-[A-Z]?\d{3,4}[A-Z]?\b`)},
	{ODM: "Quanta", Type: "quanta_da0", Pattern: regexp.MustCompile(`(?i)\bDA[0A-Z][A-Z0-9]{2,8}MB[0-9A-Z]{2,5}\b`)},
	{ODM: "ASUS", Type: "asus_60nb", Pattern: regexp.MustCompile(`(?i)\b60N[BR][A-Z0-9]{4}-MB[A-Z0-9]{4,5}\b`)},
	{ODM: "Wistron", Type: "wistron_448", Pattern: regexp.MustCompile(`\b448\.\d{2}[A-Z]\d{2}\.\d{3,4}\b`)},
	{ODM: "Inventec", Type: "inventec_6050a", Pattern: regexp.MustCompile(`\b6050A\d{7,10}\b`)},
	{ODM: "Acer", Type: "acer_mb", Pattern: regexp.MustCompile(`\bMB\.[A-Z0-9]{5}\.\d{3}\b`)},
	{ODM: "Lenovo", Type: "lenovo_fru_new", Pattern: regexp.MustCompile(`\b5B\d{2}[A-Z]\d{5}\b`)},
	{ODM: "Lenovo", Type: "lenovo_fru_old", Pattern: regexp.MustCompile(`\b\d{2}X\d{4,5}\b`)},
	{ODM: "MSI", Type: "msi_ms", Pattern: regexp.MustCompile(`(?i)\bMS-\d{4,5}\b`)},
	{ODM: "Sony", Type: "sony_mbx", Pattern: regexp.MustCompile(`(?i)\bMBX-\d{2,3}\b`)},
	{ODM: "Samsung", Type: "samsung_ba", Pattern: regexp.MustCompile(`\bBA4[12]-\d{5}\b`)},
	{ODM: "Razer", Type: "razer_rz", Pattern: regexp.MustCompile(`(?i)\bRZ09-\d{4}\b`)},
	{ODM: "Clevo", Type: "clevo", Pattern: regexp.MustCompile(`(?i)\bN[HPB]\d{2}[A-Z]{2,4}\b`)},
	{ODM: "HP", Type: "hp_spare", Pattern: regexp.MustCompile(`\b[A-Z]\d{5,6}-\d{3}\b`)},
	{ODM: "Wistron", Type: "wistron_numeric", Pattern: regexp.MustCompile(`\b\d{5,6}-\d[A-Z]?\b`)},
}
