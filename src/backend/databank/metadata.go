package databank

import (
	"boardripper/boarddb"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Board extensions recognized by the databank scanner. Must stay in sync
// with FormatDescriptor.extensions across src/frontend/src/parsers/*. Any
// extension here without a frontend parser is dead — the scanner indexes
// files no viewer can open.
var boardExtensions = map[string]bool{
	".bvr": true, // BVR1, BVR3
	".bv":  true, // BVR1, BVR3
	".brd": true, // BRD (Apple/Mac), BDV, Allegro
	".bdv": true, // BDV, BDV ASC
	".fz":  true, // FZ (ASUS)
	".cad": true, // GenCAD 1.4, Mentor Boardstation Neutral
	".pcb": true, // XZZ
	".tvw": true, // Teboview
}

// PDF extension.
var pdfExtensions = map[string]bool{
	".pdf": true,
}

// ExtensionsFingerprint returns a stable string of all supported extensions.
// Used to detect when supported formats change across code updates.
func ExtensionsFingerprint() string {
	exts := make([]string, 0, len(boardExtensions)+len(pdfExtensions))
	for e := range boardExtensions {
		exts = append(exts, e)
	}
	for e := range pdfExtensions {
		exts = append(exts, e)
	}
	sort.Strings(exts)
	return strings.Join(exts, ",")
}

// IsSupportedFile returns true if the extension is a board or PDF file.
func IsSupportedFile(name string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	return boardExtensions[ext] || pdfExtensions[ext]
}

// IsBoardFile returns true if the extension is a recognized board format.
// PDFs do not count.
func IsBoardFile(name string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	return boardExtensions[ext]
}

// BoardExtensionList returns a sorted, comma-separated list of board
// extensions for human-readable error messages.
func BoardExtensionList() string {
	exts := make([]string, 0, len(boardExtensions))
	for e := range boardExtensions {
		exts = append(exts, e)
	}
	sort.Strings(exts)
	return strings.Join(exts, ", ")
}

// FileTypeFromExt returns "board", "pdf", or "" for unsupported.
func FileTypeFromExt(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	if boardExtensions[ext] {
		return "board"
	}
	if pdfExtensions[ext] {
		return "pdf"
	}
	return ""
}

// Metadata holds extracted metadata from a filename.
type Metadata struct {
	BoardNumber       string
	Manufacturer      string
	Model             string
	BoardManufacturer string // ODM: "Compal", "Quanta", etc.
	ResolutionStatus  string // "resolved", "pattern_matched", "unresolved"
	BoardUUID         string // From boarddb.BoardMatch.UUID (resolver-derived)
	BoardColor        string // From boarddb.BoardMatch.Color (canonical lowercase name)
	BoardColorHex     string // From boarddb.BoardMatch.ColorHex (substrate tint, e.g. #1a4a2a)
}

var (
	// Apple board number pattern: 820-XXXXX (5 digits) with optional suffix like -05
	appleBoardRe = regexp.MustCompile(`(820-\d{5})(?:-\d+)?`)

	// Common manufacturer keywords in filenames
	manufacturerKeywords = []struct {
		keyword string
		name    string
	}{
		{"apple", "Apple"},
		{"asus", "Asus"},
		{"quanta", "Quanta"},
		{"compal", "Compal"},
		{"wistron", "Wistron"},
		{"inventec", "Inventec"},
		{"pegatron", "Pegatron"},
		{"foxconn", "Foxconn"},
		{"lenovo", "Lenovo"},
		{"dell", "Dell"},
		{"hp", "HP"},
		{"acer", "Acer"},
		{"msi", "MSI"},
		{"gigabyte", "Gigabyte"},
		{"toshiba", "Toshiba"},
		{"samsung", "Samsung"},
		{"clevo", "Clevo"},
	}

	// Asus model pattern: e.g. "G532LWS", "FA507RM"
	asusModelRe = regexp.MustCompile(`\b([A-Z][A-Z0-9]{3,8}[A-Z])\b`)

	// Revision suffix: R10, R20, Rev1, Rev01, etc. at end of token
	revisionSuffixRe = regexp.MustCompile(`(?i)R(?:ev)?\d{1,2}$`)
)

// ExtractMetadata extracts board number, manufacturer, and model from a filename and its directory path.
func ExtractMetadata(relPath string) Metadata {
	m := Metadata{}

	filename := filepath.Base(relPath)
	dir := filepath.Dir(relPath)
	lowerFile := strings.ToLower(filename)
	lowerDir := strings.ToLower(dir)
	combined := lowerDir + "/" + lowerFile

	// Extract Apple board number (820-XXXXX)
	if match := appleBoardRe.FindStringSubmatch(filename); match != nil {
		m.BoardNumber = match[1]
		m.Manufacturer = "Apple"
	}

	// Detect manufacturer from filename or directory
	if m.Manufacturer == "" {
		for _, mk := range manufacturerKeywords {
			if strings.Contains(combined, mk.keyword) {
				m.Manufacturer = mk.name
				break
			}
		}
	}

	// If still no manufacturer, use parent directory name as hint
	if m.Manufacturer == "" && dir != "." && dir != "" {
		// Use the top-level directory as manufacturer hint
		parts := strings.SplitN(dir, string(filepath.Separator), 2)
		if parts[0] != "" {
			m.Manufacturer = parts[0]
		}
	}

	// Extract model hints
	if m.Manufacturer == "Asus" {
		// Try to find Asus model pattern
		if match := asusModelRe.FindString(filename); match != "" {
			m.Model = match
		}
	}

	// For Quanta boards, the board code is often the filename prefix (e.g., "NJM")
	if m.Manufacturer == "Quanta" {
		if idx := strings.Index(lowerFile, "quanta"); idx >= 0 {
			// Extract code after "Quanta "
			rest := filename[idx+6:]
			rest = strings.TrimSpace(rest)
			if spaceIdx := strings.IndexAny(rest, " _-."); spaceIdx > 0 {
				m.Model = rest[:spaceIdx]
			} else if len(rest) > 0 {
				m.Model = rest
			}
		}
	}

	return m
}

// ExtractMetadataWithBoardDB uses the board reference database for ODM-aware metadata extraction.
// Falls back to ExtractMetadata if boarddb is nil or no patterns match.
func ExtractMetadataWithBoardDB(relPath string, bdb *boarddb.DB) Metadata {
	filename := filepath.Base(relPath)

	if bdb != nil && bdb.Available() {
		extracted := boarddb.ExtractBoardNumbers(filename)
		if len(extracted) == 0 {
			// Try directory components too
			extracted = boarddb.ExtractBoardNumbers(relPath)
		}
		if len(extracted) > 0 {
			best := extracted[0]
			m := Metadata{
				BoardNumber:       best.Number,
				BoardManufacturer: best.ODM,
				ResolutionStatus:  "pattern_matched",
			}

			match := bdb.Resolve(best.Number)
			if match != nil {
				m.BoardNumber = match.BoardNumber // canonical from DB
				m.Manufacturer = match.Brand
				m.Model = match.Model
				m.BoardManufacturer = match.ODM
				m.ResolutionStatus = "resolved"
				m.BoardUUID = match.UUID
				m.BoardColor = match.Color
				m.BoardColorHex = match.ColorHex
			}
			return m
		}
	}

	// Fallback: tokenize filename and try alias lookups (catches codenames, model names)
	if bdb != nil && bdb.Available() {
		base := strings.TrimSuffix(filename, filepath.Ext(filename))
		// Split on common separators: space, underscore, dash, dot, comma, parens
		tokens := strings.FieldsFunc(base, func(r rune) bool {
			return r == ' ' || r == '_' || r == '-' || r == '.' || r == ',' || r == '(' || r == ')' || r == '[' || r == ']'
		})
		for _, tok := range tokens {
			if len(tok) < 3 {
				continue
			}
			// Try the token as-is
			if match := bdb.ResolveByAlias(tok); match != nil {
				return Metadata{
					BoardNumber: match.BoardNumber, Manufacturer: match.Brand,
					Model: match.Model, BoardManufacturer: match.ODM, ResolutionStatus: "resolved",
					BoardUUID: match.UUID, BoardColor: match.Color, BoardColorHex: match.ColorHex,
				}
			}
			// Strip trailing revision (R10, R20, Rev1, etc.) and retry
			stripped := revisionSuffixRe.ReplaceAllString(tok, "")
			if stripped != tok && len(stripped) >= 3 {
				if match := bdb.ResolveByAlias(stripped); match != nil {
					return Metadata{
						BoardNumber: match.BoardNumber, Manufacturer: match.Brand,
						Model: match.Model, BoardManufacturer: match.ODM, ResolutionStatus: "resolved",
						BoardUUID: match.UUID, BoardColor: match.Color, BoardColorHex: match.ColorHex,
					}
				}
				// Also try resolving as a board number (for NME471 → NM-E471)
				if match := bdb.Resolve(stripped); match != nil {
					return Metadata{
						BoardNumber: match.BoardNumber, Manufacturer: match.Brand,
						Model: match.Model, BoardManufacturer: match.ODM, ResolutionStatus: "resolved",
						BoardUUID: match.UUID, BoardColor: match.Color, BoardColorHex: match.ColorHex,
					}
				}
			}
		}
		// Last resort: try regex extraction on the entire base name without any separators
		// This catches compound tokens like "JY575NME471R10" where board numbers are glued together
		lastTry := boarddb.ExtractBoardNumbers(base)
		for _, e := range lastTry {
			if match := bdb.Resolve(e.Number); match != nil {
				return Metadata{
					BoardNumber: match.BoardNumber, Manufacturer: match.Brand,
					Model: match.Model, BoardManufacturer: match.ODM, ResolutionStatus: "resolved",
					BoardUUID: match.UUID, BoardColor: match.Color, BoardColorHex: match.ColorHex,
				}
			}
		}
	}

	// Final fallback: keyword-based extraction
	m := ExtractMetadata(relPath)
	if m.BoardNumber == "" && m.Manufacturer == "" {
		m.ResolutionStatus = "unresolved"
	} else {
		m.ResolutionStatus = "pattern_matched"
	}
	return m
}

// BoardNumberTokens extracts the significant tokens from a board filename
// for auto-matching with PDFs. E.g. "820-02020.bvr" -> ["820-02020"].
func BoardNumberTokens(filename string) []string {
	var tokens []string

	// Apple board numbers
	if matches := appleBoardRe.FindAllString(filename, -1); matches != nil {
		tokens = append(tokens, matches...)
	}

	// Also extract the base name without extension as a fallback token
	base := strings.TrimSuffix(filename, filepath.Ext(filename))
	// Normalize separators
	base = strings.ReplaceAll(base, "_", " ")
	base = strings.ReplaceAll(base, "-", " ")
	if base != "" {
		tokens = append(tokens, base)
	}

	return tokens
}

// MatchScore returns a simple score for how well a PDF filename matches a board filename.
// Higher score = better match. Returns 0 for no match.
func MatchScore(boardFilename, pdfFilename string) int {
	boardBase := strings.ToLower(strings.TrimSuffix(boardFilename, filepath.Ext(boardFilename)))
	pdfBase := strings.ToLower(strings.TrimSuffix(pdfFilename, filepath.Ext(pdfFilename)))

	// Exact base match (ignoring extension)
	if boardBase == pdfBase {
		return 100
	}

	// Check if board number appears in PDF name
	if match := appleBoardRe.FindString(boardFilename); match != "" {
		if strings.Contains(pdfBase, strings.ToLower(match)) {
			return 80
		}
	}

	// Check if PDF base contains board base or vice versa
	if strings.Contains(pdfBase, boardBase) || strings.Contains(boardBase, pdfBase) {
		return 50
	}

	// Token overlap
	boardTokens := strings.Fields(strings.ReplaceAll(strings.ReplaceAll(boardBase, "-", " "), "_", " "))
	pdfTokens := strings.Fields(strings.ReplaceAll(strings.ReplaceAll(pdfBase, "-", " "), "_", " "))

	overlap := 0
	for _, bt := range boardTokens {
		for _, pt := range pdfTokens {
			if bt == pt && len(bt) >= 3 {
				overlap++
			}
		}
	}

	if overlap > 0 {
		return overlap * 20
	}

	return 0
}
