package obd

import (
	"errors"
	"log"
	"strings"
)

// Parse reads an OBDATA_V002 text body and returns the parsed payload.
// Returns an error only when the magic line is missing — unknown keys
// and duplicate writes are tolerated and logged.
//
// The real format opens with `HEADER_DATA_START` followed by the
// `OBDATA_V002 …` magic line. Headers (TIMESTAMP, BOARDPATH, etc.)
// live INSIDE that bracketed block, not as bare lines. We accept the
// magic anywhere inside the first `HEADER_DATA` section as well as on
// any unbracketed lead-in (some files in the wild may not use the
// bracketed form).
func Parse(src string) (*ObdData, error) {
	if !strings.Contains(src[:min500(src)], "OBDATA_V002") {
		return nil, errors.New("obd: missing OBDATA_V002 magic in first 500 bytes")
	}

	out := &ObdData{
		Components: []Component{},
		Nets:       []Net{},
		Sections:   []DiagnosisSection{},
	}
	componentsIdx := map[string]int{} // refdes → index in out.Components
	netsIdx := map[string]int{}        // "name|qualifier" → index in out.Nets
	// Structured DIAGNOSIS state: SECT_START → currentSection, NOTE_START →
	// currentNote, lines accumulate into noteBodyBuf until NOTE_END flushes.
	var currentSection *DiagnosisSection
	var currentNoteTitle string
	var noteBodyBuf []string
	inNote := false

	type section int
	const (
		secNone section = iota
		secHeader
		secDiagnosis
		secComponents
		secNets
	)
	cur := secNone
	var diagnosisBuf []string

	for i, raw := range strings.Split(src, "\n") {
		line := strings.TrimRight(raw, "\r")
		trimmed := strings.TrimSpace(line)

		// Skip inline-doc comments and blanks (but keep blanks inside DIAGNOSIS).
		if strings.HasPrefix(trimmed, "###") {
			continue
		}
		if trimmed == "" && cur != secDiagnosis {
			continue
		}

		// Section delimiters.
		switch trimmed {
		case "HEADER_DATA_START":
			cur = secHeader
			continue
		case "HEADER_DATA_END":
			cur = secNone
			continue
		case "DIAGNOSIS_DATA_START":
			cur = secDiagnosis
			continue
		case "DIAGNOSIS_DATA_END":
			out.Diagnosis = strings.TrimSpace(strings.Join(diagnosisBuf, "\n"))
			diagnosisBuf = nil
			// Flush any unterminated structured note/section that the
			// upstream file forgot to close before DIAGNOSIS_DATA_END.
			if inNote && currentSection != nil {
				currentSection.Notes = append(currentSection.Notes, DiagnosisNote{
					Title: currentNoteTitle,
					Body:  strings.TrimSpace(strings.Join(noteBodyBuf, "\n")),
				})
				noteBodyBuf = nil
				inNote = false
			}
			if currentSection != nil {
				out.Sections = append(out.Sections, *currentSection)
				currentSection = nil
			}
			cur = secNone
			continue
		case "COMPONENTS_DATA_START":
			cur = secComponents
			continue
		case "COMPONENTS_DATA_END":
			cur = secNone
			continue
		case "NETS_DATA_START":
			cur = secNets
			continue
		case "NETS_DATA_END":
			cur = secNone
			continue
		}

		switch cur {
		case secHeader, secNone:
			// Header K/V — both inside HEADER_DATA and (for legacy / future
			// variants) on bare lines outside any section.
			parseHeaderLine(out, trimmed, i)
		case secDiagnosis:
			// Always feed the raw buffer so the legacy `Diagnosis` string
			// stays populated for callers that don't use the structured shape.
			diagnosisBuf = append(diagnosisBuf, line)

			// Structured parse: SECT_START / NOTE_START / NOTE_END / SECT_END.
			// Anything else inside a note appends to the note body.
			if strings.HasPrefix(trimmed, "SECT_START ") || trimmed == "SECT_START" {
				if currentSection != nil {
					// Implicit close of previous section without SECT_END.
					out.Sections = append(out.Sections, *currentSection)
				}
				title := strings.TrimSpace(strings.TrimPrefix(trimmed, "SECT_START"))
				currentSection = &DiagnosisSection{Title: title, Notes: []DiagnosisNote{}}
				inNote = false
				continue
			}
			if trimmed == "SECT_END" {
				if inNote && currentSection != nil {
					// Implicit close of trailing note within section.
					currentSection.Notes = append(currentSection.Notes, DiagnosisNote{
						Title: currentNoteTitle,
						Body:  strings.TrimSpace(strings.Join(noteBodyBuf, "\n")),
					})
					noteBodyBuf = nil
					inNote = false
				}
				if currentSection != nil {
					out.Sections = append(out.Sections, *currentSection)
					currentSection = nil
				}
				continue
			}
			if strings.HasPrefix(trimmed, "NOTE_START ") || trimmed == "NOTE_START" {
				if inNote && currentSection != nil {
					currentSection.Notes = append(currentSection.Notes, DiagnosisNote{
						Title: currentNoteTitle,
						Body:  strings.TrimSpace(strings.Join(noteBodyBuf, "\n")),
					})
				}
				currentNoteTitle = strings.TrimSpace(strings.TrimPrefix(trimmed, "NOTE_START"))
				noteBodyBuf = nil
				inNote = true
				continue
			}
			if trimmed == "NOTE_END" {
				if currentSection == nil {
					// Stray NOTE_END outside a section — synthesise a fallback section.
					currentSection = &DiagnosisSection{Title: "", Notes: []DiagnosisNote{}}
				}
				currentSection.Notes = append(currentSection.Notes, DiagnosisNote{
					Title: currentNoteTitle,
					Body:  strings.TrimSpace(strings.Join(noteBodyBuf, "\n")),
				})
				noteBodyBuf = nil
				inNote = false
				continue
			}
			if inNote {
				noteBodyBuf = append(noteBodyBuf, line)
			}
		case secComponents:
			parseComponentLine(out, componentsIdx, trimmed, i)
		case secNets:
			parseNetLine(out, netsIdx, trimmed, i)
		}
	}

	// Close any unterminated section/note at EOF — defensively handles
	// upstream files that drop a trailing SECT_END.
	if inNote && currentSection != nil {
		currentSection.Notes = append(currentSection.Notes, DiagnosisNote{
			Title: currentNoteTitle,
			Body:  strings.TrimSpace(strings.Join(noteBodyBuf, "\n")),
		})
	}
	if currentSection != nil {
		out.Sections = append(out.Sections, *currentSection)
	}

	// Normalise nil slices to empty so JSON emits [] not null. Frontend
	// code does `n.comments.length` and similar on every hover; nil →
	// "Cannot read properties of null" in the browser otherwise.
	for i := range out.Nets {
		if out.Nets[i].Aliases == nil {
			out.Nets[i].Aliases = []string{}
		}
		if out.Nets[i].Comments == nil {
			out.Nets[i].Comments = []string{}
		}
	}

	return out, nil
}

func min500(s string) int {
	if len(s) < 500 {
		return len(s)
	}
	return 500
}

func parseHeaderLine(out *ObdData, line string, lineNum int) {
	// First token is the key; rest is the value (preserve internal spaces).
	sp := strings.IndexByte(line, ' ')
	if sp < 0 {
		return // ignore single-token header lines
	}
	key := line[:sp]
	val := strings.TrimSpace(line[sp+1:])
	switch key {
	case "OBDATA_V002":
		// Magic; the URL after it is informational, ignore.
	case "TIMESTAMP":
		out.Header.Timestamp = &val
	case "BOARDPATH":
		// We set Bpath from the request, not from the file body — but
		// keep it parseable for round-trips.
		if out.Bpath == "" {
			out.Bpath = val
		}
	case "ID":
		out.Header.ID = &val
	case "BRAND":
		out.Header.Brand = &val
	case "CATEGORY":
		out.Header.Category = &val
	case "COMMENT":
		out.Header.Comment = &val
	default:
		log.Printf("[obd] line %d: unknown header key %q dropped", lineNum, key)
	}
}

func parseComponentLine(out *ObdData, idx map[string]int, line string, lineNum int) {
	// "<refdes> <attr_key> <attr_value...>"
	parts := strings.SplitN(line, " ", 3)
	if len(parts) < 3 {
		log.Printf("[obd] line %d: malformed component %q", lineNum, line)
		return
	}
	refdes, key, val := parts[0], parts[1], strings.TrimSpace(parts[2])

	pos, ok := idx[refdes]
	if !ok {
		out.Components = append(out.Components, Component{
			Refdes: refdes,
			Attrs:  map[string]string{},
		})
		pos = len(out.Components) - 1
		idx[refdes] = pos
	}
	if _, dup := out.Components[pos].Attrs[key]; dup {
		log.Printf("[obd] line %d: duplicate attr %s on %s — last write wins", lineNum, key, refdes)
	}
	out.Components[pos].Attrs[key] = val
}

func parseNetLine(out *ObdData, idx map[string]int, line string, lineNum int) {
	// "<name>/<qualifier> <type> <value> '<comment>'"
	parts := strings.SplitN(line, " ", 4)
	if len(parts) < 3 {
		log.Printf("[obd] line %d: malformed net %q", lineNum, line)
		return
	}
	nameQual := parts[0]
	netType := parts[1]
	val := parts[2]

	name, qual := splitNetName(nameQual)
	key := name + "|" + qual
	pos, ok := idx[key]
	if !ok {
		out.Nets = append(out.Nets, Net{Name: name, Qualifier: qual})
		pos = len(out.Nets) - 1
		idx[key] = pos
	}
	n := &out.Nets[pos]

	switch netType {
	case "d":
		v := val
		n.Diode = &v
	case "v":
		v := val
		n.Voltage = &v
	case "r":
		v := val
		n.Resistance = &v
	case "a":
		n.Aliases = append(n.Aliases, val)
	case "t":
		// Comment can have spaces; reuse parts[2] onwards.
		comment := val
		if len(parts) == 4 {
			comment = strings.TrimSpace(val + " " + parts[3])
		}
		comment = strings.Trim(comment, "'")
		n.Comments = append(n.Comments, comment)
	default:
		log.Printf("[obd] line %d: unknown net type %q dropped", lineNum, netType)
	}
}

func splitNetName(s string) (name, qual string) {
	slash := strings.IndexByte(s, '/')
	if slash < 0 {
		return s, ""
	}
	return s[:slash], s[slash+1:]
}
