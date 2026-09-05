package databank

import (
	"regexp"
	"strconv"
	"strings"
)

// Apple phone and tablet boardviews are named by model, not by board number:
// "iPhone16_16Plus AP+BB Boardview.pcb", "iPhone14Pro_ProMAX Boardview
// 820-02588-10 820-02672-12.pcb", "iPhoneXSMAX boardview(Diode value).pcb",
// "XR.pcb" inside an "iPhoneXR/" folder. The boards database resolves by
// 820-number and knows no iPhone families, so without this every one of them
// fell into the library's "Unrecognized" bucket under its top folder.
//
// appleDeviceModel reads the model out of the path — deepest folder first,
// because folder names are the cleanest ("iPhone13ProMAX"), then the file
// name — and normalises it to Apple's spelling: "iPhone 16 / 16 Plus",
// "iPhone 14 Pro / Pro Max", "iPhone XS Max", "iPhone SE 2", "iPad Pro 12.9".
// A file that names two models keeps both, joined with " / ", because such a
// file (an "AP+BB" pack or a shared boardview) really covers both.

var (
	// "iPhone", then the first model token glued on or after a separator.
	// No `\b` after the variant: "_" is a word character, and the variant is
	// glued to the next token in "iPhone14Pro_ProMAX".
	appleDeviceRe = regexp.MustCompile(`(?i)\b(iphone|ipad)\s*[-_ ]?\s*((?:\d{1,2}|xs|xr|x|se)(?:\s*(?:pro\s*max|promax|pro|plus|mini|max|air|e))?(?:\s*\d)?|pro|air|mini)`)
	// Extra model tokens that may follow, separated by "_", "&", "/" or a
	// space: "16Plus", "ProMAX", "12Pro", "Pro Max".
	appleVariantRe = regexp.MustCompile(`(?i)^(?:(\d{1,2}(?:\.\d)?|xs|xr|x|se)\s*)?(pro\s*max|promax|pro|plus|mini|max|air|e)?(?:\s*(\d))?$`)
)

// appleDeviceModel returns the normalised model name found in relPath and
// true, or "" and false when the path names no iPhone / iPad.
func appleDeviceModel(relPath string) (string, bool) {
	// Deepest folder first, then the file name.
	parts := strings.FieldsFunc(relPath, func(r rune) bool { return r == '/' || r == '\\' })
	if len(parts) == 0 {
		return "", false
	}
	order := make([]string, 0, len(parts))
	for i := len(parts) - 2; i >= 0; i-- {
		order = append(order, parts[i])
	}
	order = append(order, parts[len(parts)-1])
	for _, seg := range order {
		if m, ok := appleModelFromSegment(seg); ok {
			return m, true
		}
	}
	return "", false
}

func appleModelFromSegment(seg string) (string, bool) {
	loc := appleDeviceRe.FindStringSubmatchIndex(seg)
	if loc == nil {
		return "", false
	}
	device := strings.ToLower(seg[loc[2]:loc[3]])
	first := seg[loc[4]:loc[5]]
	rest := seg[loc[1]:]

	family := "iPhone"
	if device == "ipad" {
		family = "iPad"
	}
	models := []string{normaliseAppleModel(first)}

	// Following tokens: "_16Plus", "&ProMAX", "/ 12 Pro". Stop at the first
	// token that is not a model or variant — "AP", "Boardview", "820-…".
	for _, tok := range strings.FieldsFunc(rest, func(r rune) bool {
		return r == '_' || r == '&' || r == '/' || r == ' ' || r == '-' || r == '+' || r == ','
	}) {
		if tok == "" {
			continue
		}
		m := appleVariantRe.FindStringSubmatch(tok)
		if m == nil || (m[1] == "" && m[2] == "" && m[3] == "") {
			break
		}
		if m[1] == "" {
			// A bare variant ("ProMAX", "Plus") belongs to the same base
			// model: "14 Pro" + "Pro Max" → "14 Pro / Pro Max"; "16" + "Plus"
			// → "16 / 16 Plus".
			base := strings.SplitN(models[len(models)-1], " ", 2)[0]
			v := normaliseAppleVariant(m[2], m[3])
			if v == "" {
				break
			}
			if base == "Pro" || base == "Air" || base == "mini" {
				models = append(models, v)
			} else if strings.HasPrefix(strings.ToLower(v), "pro") && strings.Contains(models[len(models)-1], "Pro") {
				models = append(models, v)
			} else {
				models = append(models, base+" "+v)
			}
			continue
		}
		// An iPad size after its line: "Pro" + "12.9" → "Pro 12.9".
		last := models[len(models)-1]
		if family == "iPad" && m[2] == "" && (last == "Pro" || last == "Air" || last == "mini") {
			models[len(models)-1] = last + " " + normaliseAppleModel(tok)
			continue
		}
		models = append(models, normaliseAppleModel(tok))
	}
	// De-duplicate while keeping order.
	seen := map[string]bool{}
	out := make([]string, 0, len(models))
	for _, m := range models {
		if m == "" || seen[m] {
			continue
		}
		seen[m] = true
		out = append(out, m)
	}
	return family + " " + strings.Join(out, " / "), true
}

// normaliseAppleModel turns "13ProMAX", "xsmax", "SE2", "16e", "12 Pro" into
// "13 Pro Max", "XS Max", "SE 2", "16E", "12 Pro".
func normaliseAppleModel(tok string) string {
	m := appleVariantRe.FindStringSubmatch(strings.TrimSpace(tok))
	if m == nil {
		return strings.TrimSpace(tok)
	}
	base := strings.ToUpper(m[1])
	if base == "SE" || base == "X" || base == "XS" || base == "XR" {
		// Roman-ish names stay upper-case.
	} else if n, err := strconv.Atoi(base); err == nil {
		base = strconv.Itoa(n)
	}
	v := normaliseAppleVariant(m[2], m[3])
	switch {
	case base == "" && v != "":
		return v
	case v == "":
		return base
	case base == "SE" && m[2] == "" && m[3] != "":
		return base + " " + m[3]
	case strings.EqualFold(m[2], "e") && m[3] == "":
		return base + "E"
	default:
		return base + " " + v
	}
}

func normaliseAppleVariant(variant, gen string) string {
	v := strings.ToLower(strings.Join(strings.Fields(variant), ""))
	var out string
	switch v {
	case "promax":
		out = "Pro Max"
	case "pro":
		out = "Pro"
	case "plus":
		out = "Plus"
	case "mini":
		out = "mini"
	case "max":
		out = "Max"
	case "air":
		out = "Air"
	case "e":
		out = "E"
	}
	if gen != "" {
		if out == "" {
			return gen
		}
		return out + " " + gen
	}
	return out
}
