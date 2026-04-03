package boarddb

import "strings"

// ExtractBoardNumbers applies all ODM regex patterns against a filename
// and returns all matched board numbers with their ODM classification.
// Results are ordered by pattern priority (most distinctive first).
func ExtractBoardNumbers(filename string) []ExtractedNumber {
	var results []ExtractedNumber
	seen := map[string]bool{}

	for _, odm := range odmPatterns {
		// Patterns use a capturing group (1) for the actual board number,
		// with the left boundary in group 0.
		matches := odm.Pattern.FindAllStringSubmatch(filename, -1)
		for _, m := range matches {
			if len(m) < 2 {
				continue
			}
			upper := strings.ToUpper(strings.TrimSpace(m[1]))
			if upper == "" || seen[upper] {
				continue
			}
			seen[upper] = true
			results = append(results, ExtractedNumber{
				Number: upper,
				ODM:    odm.ODM,
				Type:   odm.Type,
			})
		}
	}
	return results
}
