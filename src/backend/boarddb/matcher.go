package boarddb

import "strings"

// ExtractBoardNumbers applies all ODM regex patterns against a filename
// and returns all matched board numbers with their ODM classification.
// Results are ordered by pattern priority (most distinctive first).
func ExtractBoardNumbers(filename string) []ExtractedNumber {
	var results []ExtractedNumber
	seen := map[string]bool{}

	for _, odm := range odmPatterns {
		matches := odm.Pattern.FindAllString(filename, -1)
		for _, m := range matches {
			upper := strings.ToUpper(m)
			if seen[upper] {
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
