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
	Bpath     string     `json:"bpath"`
	SourceURL string     `json:"source_url"`
	FetchedAt string     `json:"fetched_at"` // RFC3339
	Header    Header     `json:"header"`
	Diagnosis string     `json:"diagnosis"`
	Components []Component `json:"components"`
	Nets      []Net       `json:"nets"`
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
