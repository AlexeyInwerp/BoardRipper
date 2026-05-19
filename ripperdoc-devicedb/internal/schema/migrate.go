package schema

import (
	"database/sql"
	_ "embed"
	"fmt"
	"log"
)

//go:embed schema.sql
var schemaSQL string

// Apply runs the embedded schema.sql against the given database connection.
// Idempotent — every statement uses IF NOT EXISTS / INSERT OR IGNORE so it
// is safe to call on every boot.
func Apply(db *sql.DB) error {
	// modernc.org/sqlite executes one statement per Exec; we split on `;` at
	// statement granularity because schema.sql has no statement-internal
	// semicolons (no triggers, no procedural blocks).
	for _, stmt := range splitStatements(schemaSQL) {
		if stmt == "" {
			continue
		}
		if _, err := db.Exec(stmt); err != nil {
			return fmt.Errorf("schema apply: %w\nSQL: %s", err, stmt)
		}
	}
	log.Printf("[devicedb] [schema] applied")
	return nil
}

// splitStatements splits schema text into individual statements by semicolons,
// honouring single-line `--` comments. No string-literal handling is required —
// the embedded schema has no semicolons inside string literals.
func splitStatements(src string) []string {
	var out []string
	var cur []byte
	inLineComment := false
	for i := 0; i < len(src); i++ {
		c := src[i]
		if inLineComment {
			if c == '\n' {
				inLineComment = false
			}
			cur = append(cur, c)
			continue
		}
		if c == '-' && i+1 < len(src) && src[i+1] == '-' {
			inLineComment = true
			cur = append(cur, c)
			continue
		}
		if c == ';' {
			out = append(out, trimSpaceASCII(string(cur)))
			cur = cur[:0]
			continue
		}
		cur = append(cur, c)
	}
	if t := trimSpaceASCII(string(cur)); t != "" {
		out = append(out, t)
	}
	return out
}

func trimSpaceASCII(s string) string {
	i, j := 0, len(s)
	for i < j {
		c := s[i]
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
			i++
			continue
		}
		break
	}
	for j > i {
		c := s[j-1]
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
			j--
			continue
		}
		break
	}
	return s[i:j]
}
