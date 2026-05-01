package obd

// Index is the manifest written by a successful scrape of
// openboarddata.org's category listing pages.
type Index struct {
	SyncedAt   string       `json:"synced_at"`        // RFC3339
	Source     string       `json:"source"`           // "https://openboarddata.org"
	Boards     []IndexEntry `json:"boards"`
}

// IndexEntry is one row of the manifest.
type IndexEntry struct {
	Bpath    string `json:"bpath"`    // e.g. "laptops/apple/820-00045"
	Brand    string `json:"brand"`    // 2nd path segment
	Category string `json:"category"` // 1st path segment
}

// Match is what /api/obd/match returns for one matched bpath. Computed
// at request time — not persisted in index.json.
type Match struct {
	Bpath      string  `json:"bpath"`
	Brand      string  `json:"brand"`
	Category   string  `json:"category"`
	Fetched    bool    `json:"fetched"`
	FetchedAt  *string `json:"fetched_at,omitempty"` // RFC3339, nil when not fetched
}

// ObdData is the parsed OBDATA_V002 payload returned by /api/obd/fetch
// and cached as <bpath>.parsed.json.
type ObdData struct {
	Bpath      string             `json:"bpath"`
	SourceURL  string             `json:"source_url"`
	FetchedAt  string             `json:"fetched_at"` // RFC3339
	Header     Header             `json:"header"`
	Diagnosis  string             `json:"diagnosis"` // raw diagnosis text — kept for round-trip + fallback display
	Sections   []DiagnosisSection `json:"sections"`  // structured sections/notes parsed from DIAGNOSIS_DATA
	Components []Component        `json:"components"`
	Nets       []Net              `json:"nets"`
}

// DiagnosisSection groups one or more notes under a heading
// (e.g. "Power Rails", "Power Sequence", "Backlight").
type DiagnosisSection struct {
	Title string         `json:"title"`
	Notes []DiagnosisNote `json:"notes"`
}

// DiagnosisNote is one note within a section. Body is preserved verbatim
// — including inline references like [n:NET_NAME] and [p:PART_NAME:PIN]
// which the frontend renders as clickable chips.
type DiagnosisNote struct {
	Title string `json:"title"`
	Body  string `json:"body"`
}

type Header struct {
	Timestamp *string `json:"timestamp"`
	ID        *string `json:"id"`
	Brand     *string `json:"brand"`
	Category  *string `json:"category"`
	Comment   *string `json:"comment"`
}

type Component struct {
	Refdes string            `json:"refdes"`
	Attrs  map[string]string `json:"attrs"`
}

type Net struct {
	Name       string   `json:"name"`
	Qualifier  string   `json:"qualifier"`
	Diode      *string  `json:"diode"`
	Voltage    *string  `json:"voltage"`
	Resistance *string  `json:"resistance"`
	Aliases    []string `json:"aliases"`
	Comments   []string `json:"comments"`
}
