package obd

import (
	"errors"
	"log"
	"strings"
)

// Parse reads an OBDATA_V002 text body and returns the parsed payload.
// Returns an error only when the magic line is missing or malformed —
// unknown keys / duplicate writes are tolerated and logged.
func Parse(src string) (*ObdData, error) {
	lines := strings.Split(src, "\n")
	if len(lines) == 0 || !strings.HasPrefix(strings.TrimSpace(lines[0]), "OBDATA_V002") {
		return nil, errors.New("obd: missing OBDATA_V002 magic line")
	}

	out := &ObdData{
		Components: []Component{},
		Nets:       []Net{},
	}
	componentsIdx := map[string]int{} // refdes → index in out.Components
	netsIdx := map[string]int{}        // "name|qualifier" → index in out.Nets

	type section int
	const (
		secNone section = iota
		secDiagnosis
		secComponents
		secNets
	)
	cur := secNone
	var diagnosisBuf []string

	for i, raw := range lines {
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
		case "DIAGNOSIS_DATA_START":
			cur = secDiagnosis
			continue
		case "DIAGNOSIS_DATA_END":
			out.Diagnosis = strings.TrimSpace(strings.Join(diagnosisBuf, "\n"))
			diagnosisBuf = nil
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
		case secDiagnosis:
			diagnosisBuf = append(diagnosisBuf, line)
		case secComponents:
			parseComponentLine(out, componentsIdx, trimmed, i)
		case secNets:
			parseNetLine(out, netsIdx, trimmed, i)
		case secNone:
			// Header line: "KEY VALUE..."
			parseHeaderLine(out, trimmed, i)
		}
	}

	return out, nil
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
