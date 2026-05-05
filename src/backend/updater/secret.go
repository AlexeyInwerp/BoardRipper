package updater

import (
	"crypto/rand"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
)

const secretFilename = ".update-secret"

// EnsureSecret returns the install's secret, generating + persisting one if
// none exists. File mode is 0600.
func EnsureSecret(dataDir string) (string, error) {
	p := filepath.Join(dataDir, secretFilename)
	b, err := os.ReadFile(p)
	if err == nil {
		s := strings.TrimSpace(string(b))
		if len(s) >= 32 {
			return s, nil
		}
		// fall through to regenerate
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	hexS := hex.EncodeToString(buf)
	if err := os.WriteFile(p, []byte(hexS), 0o600); err != nil {
		return "", err
	}
	return hexS, nil
}
