package contribdb

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// EnsureInstallSecret returns the install's plaintext token, generating and
// persisting one to <dataDir>/.contrib-secret (mode 0600) on first call.
// Mirrors updater.EnsureSecret's discipline (no logging of the secret).
func EnsureInstallSecret(dataDir string) (string, error) {
	p := filepath.Join(dataDir, contribSecretFile)
	b, err := os.ReadFile(p)
	if err == nil {
		s := strings.TrimSpace(string(b))
		if len(s) >= 32 {
			return s, nil
		}
		// fall through to regenerate on too-short / corrupt
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("contribdb: rand: %w", err)
	}
	tok := base64.StdEncoding.EncodeToString(buf)
	if err := os.WriteFile(p, []byte(tok), 0o600); err != nil {
		return "", fmt.Errorf("contribdb: write secret: %w", err)
	}
	return tok, nil
}

// readContributorUUID reads <dataDir>/.contrib-uuid, returning "" when
// absent or unreadable.
func readContributorUUID(dataDir string) string {
	b, err := os.ReadFile(filepath.Join(dataDir, contribUUIDFile))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// writeContributorUUID persists the server-assigned UUID. Atomic via
// tmp+rename so a crash mid-write never leaves a half-line.
func writeContributorUUID(dataDir, uuid string) error {
	p := filepath.Join(dataDir, contribUUIDFile)
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, []byte(uuid), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// registerOnBootLoop attempts registration in a loop until success or ctx
// cancellation. Retry interval starts at 1 minute and caps at 1 hour.
// Failure modes log to the ring buffer; the function never returns an
// error — it just keeps trying. This matches spec §5.2's "Bootstrap
// resilience" requirement (registration is never fatal).
func (s *Service) registerOnBootLoop(ctx context.Context) {
	// Already registered? Nothing to do.
	if s.Registered() {
		return
	}

	delay := 1 * time.Minute
	const maxDelay = 1 * time.Hour

	// Attempt immediately on boot so a healthy network gets us registered
	// without waiting a minute.
	if err := s.tryRegister(ctx); err == nil {
		return
	} else if !errors.Is(err, context.Canceled) {
		s.recordError("register", err.Error())
	}

	timer := time.NewTimer(delay)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		if err := s.tryRegister(ctx); err == nil {
			return
		} else if !errors.Is(err, context.Canceled) {
			s.recordError("register", err.Error())
		}
		delay *= 2
		if delay > maxDelay {
			delay = maxDelay
		}
		timer.Reset(delay)
	}
}

// registerRequest matches the POST /v1/installs/register body shape.
type registerRequest struct {
	Token       string `json:"token"`
	VersionHint string `json:"version_hint"`
}

// registerResponse matches the server's reply.
type registerResponse struct {
	ContributorUUID string `json:"contributor_uuid"`
}

// tryRegister performs one POST attempt against /v1/installs/register.
// On success, persists the UUID to disk and flips s.registered to true.
// Returns nil on 2xx success; any other outcome (network, 4xx, 5xx) returns
// an error and leaves state untouched.
func (s *Service) tryRegister(ctx context.Context) error {
	tok := s.InstallToken()
	if tok == "" {
		return errors.New("install token empty (mint failed at boot)")
	}
	body := registerRequest{
		Token:       tok,
		VersionHint: fmt.Sprintf("boardripper/%s", s.cfg.Version),
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		s.cfg.BaseURL+"/v1/installs/register", strings.NewReader(string(raw)))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", s.client.userAgent())

	resp, err := s.client.http.Do(req)
	if err != nil {
		return fmt.Errorf("post: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	var rr registerResponse
	if err := json.NewDecoder(resp.Body).Decode(&rr); err != nil {
		return fmt.Errorf("decode: %w", err)
	}
	if rr.ContributorUUID == "" {
		return errors.New("server returned empty contributor_uuid")
	}
	if err := writeContributorUUID(s.cfg.DataDir, rr.ContributorUUID); err != nil {
		return fmt.Errorf("persist uuid: %w", err)
	}
	s.mu.Lock()
	s.contributorUUID = rr.ContributorUUID
	s.registered = true
	s.mu.Unlock()
	return nil
}
