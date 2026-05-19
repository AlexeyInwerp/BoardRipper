package store

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"golang.org/x/crypto/argon2"
)

// Contributor mirrors the contributors table.
type Contributor struct {
	UUID          string         `json:"uuid"`
	Kind          string         `json:"kind"` // "install" | "user"
	Handle        sql.NullString `json:"-"`
	Email         sql.NullString `json:"-"`
	GitHubLogin   sql.NullString `json:"-"`
	CreatedAt     string         `json:"created_at"`
	LastSeen      string         `json:"last_seen"`
	Blocked       bool           `json:"blocked"`
	BlockedReason sql.NullString `json:"-"`
}

// argon2id parameters — fast enough for per-request verify, slow enough that
// a stolen DB doesn't reveal tokens cheaply. Tuned for a ~50ms cost on the
// reference dev box; safe to drop if production telemetry shows pain.
const (
	argonTime    = 1
	argonMemory  = 64 * 1024 // 64 MiB
	argonThreads = 4
	argonKeyLen  = 32
	saltLen      = 16
)

// hashToken hashes a plaintext token with argon2id and encodes as a single
// PHC-like string: `argon2id$<salt-b64>$<key-b64>`. Plaintext is never stored.
func hashToken(plain string) (string, error) {
	if plain == "" {
		return "", errors.New("empty token")
	}
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(plain), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf("argon2id$%s$%s",
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key)), nil
}

// verifyTokenHash returns true if `plain` argon2id-hashes to `stored`.
// Constant-time compare on the key bytes per spec §7.4 ("token storage").
func verifyTokenHash(plain, stored string) bool {
	parts := strings.Split(stored, "$")
	if len(parts) != 3 || parts[0] != "argon2id" {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[1])
	if err != nil {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[2])
	if err != nil {
		return false
	}
	got := argon2.IDKey([]byte(plain), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return subtle.ConstantTimeCompare(got, want) == 1
}

// tokenLookupHash is a fast, deterministic, non-secret SHA-256 prefix of the
// plaintext token that we INDEX on for O(log n) auth lookup. Argon2id hashes
// salt-per-row so we can't index on them directly; the SHA-256 column lets us
// fetch a candidate row in one query and then verify with argon2id.
//
// Returns the hex-encoded sha256 (full 64 chars). Stored in the
// `token_lookup` schema column (see below).
//
// NOTE: this is a *lookup* index only — it must never be the auth check.
// argon2id verify is still required.
func tokenLookupHash(plain string) string {
	sum := sha256.Sum256([]byte(plain))
	return hex.EncodeToString(sum[:])
}

// RegisterInstall is the handler for POST /v1/installs/register. Body provides
// a plaintext token (minted client-side); server hashes it, creates a
// contributors row (kind='install'), and stores the hash. Idempotent: if the
// same hash already exists, return its existing contributor UUID.
//
// Returns (contributorUUID, created bool, err). `created` is true only on
// the first registration; re-registrations return false so the API layer can
// log differently.
func (s *Store) RegisterInstall(plainToken, versionHint string) (string, bool, error) {
	if plainToken == "" {
		return "", false, errors.New("empty token")
	}

	// Idempotency: look up by sha256 lookup hash. (We can't index on argon2id.)
	lookup := tokenLookupHash(plainToken)

	tx, err := s.DB.Begin()
	if err != nil {
		return "", false, err
	}
	defer tx.Rollback()

	// Ensure the install_tokens table has a lookup column (added at first use
	// rather than in the migration to avoid a separate migration step — this
	// is a Phase-2 prototype). Idempotent.
	if err := ensureLookupColumn(tx, "install_tokens"); err != nil {
		return "", false, err
	}
	if err := ensureLookupColumn(tx, "user_tokens"); err != nil {
		return "", false, err
	}

	var existingContribUUID, storedHash string
	err = tx.QueryRow(`SELECT contributor_uuid, token_hash FROM install_tokens WHERE token_lookup=? AND revoked=0 LIMIT 1`, lookup).
		Scan(&existingContribUUID, &storedHash)
	if err == nil {
		// Found by lookup; verify argon2id to be safe (defends against sha256
		// collision attacks which are infeasible but explicit-is-better).
		if verifyTokenHash(plainToken, storedHash) {
			now := nowUTC()
			_, _ = tx.Exec(`UPDATE install_tokens SET last_used_at=?, version_hint=? WHERE token_lookup=?`,
				now, versionHint, lookup)
			_, _ = tx.Exec(`UPDATE contributors SET last_seen=? WHERE uuid=?`, now, existingContribUUID)
			if err := tx.Commit(); err != nil {
				return "", false, err
			}
			return existingContribUUID, false, nil
		}
	}

	// New install. Mint a contributors row.
	contribUUID := uuid.NewString()
	hashed, err := hashToken(plainToken)
	if err != nil {
		return "", false, err
	}
	now := nowUTC()
	if _, err := tx.Exec(`INSERT INTO contributors (uuid, kind, created_at, last_seen) VALUES (?, 'install', ?, ?)`,
		contribUUID, now, now); err != nil {
		return "", false, err
	}
	if _, err := tx.Exec(`INSERT INTO install_tokens (contributor_uuid, token_hash, token_lookup, created_at, version_hint) VALUES (?, ?, ?, ?, ?)`,
		contribUUID, hashed, lookup, now, versionHint); err != nil {
		return "", false, err
	}
	if err := tx.Commit(); err != nil {
		return "", false, err
	}
	return contribUUID, true, nil
}

// RegisterUser is the prototype password-less user registration. Creates a
// contributors row (kind='user'), mints a new plaintext token, hashes it,
// stores the hash, returns the plaintext exactly once. Real GitHub-OAuth
// flow is Phase 3.
func (s *Store) RegisterUser(handle, email string) (contributorUUID, plainToken string, err error) {
	if handle == "" {
		return "", "", errors.New("handle required")
	}
	// Reject if handle already taken (case-insensitive). Surfaces as HTTP 409
	// at the API layer via APIError mapping.
	var existing string
	row := s.DB.QueryRow(`SELECT uuid FROM contributors WHERE kind='user' AND lower(handle) = lower(?) LIMIT 1`, handle)
	if scanErr := row.Scan(&existing); scanErr == nil && existing != "" {
		return "", "", &APIError{Code: "handle_taken", Message: "handle already registered", HTTP: 409}
	}
	plain := mintTokenString()
	hashed, herr := hashToken(plain)
	if herr != nil {
		return "", "", herr
	}
	lookup := tokenLookupHash(plain)

	tx, err := s.DB.Begin()
	if err != nil {
		return "", "", err
	}
	defer tx.Rollback()

	if err := ensureLookupColumn(tx, "install_tokens"); err != nil {
		return "", "", err
	}
	if err := ensureLookupColumn(tx, "user_tokens"); err != nil {
		return "", "", err
	}

	now := nowUTC()
	cu := uuid.NewString()
	if _, err := tx.Exec(`INSERT INTO contributors (uuid, kind, handle, email, created_at, last_seen) VALUES (?, 'user', ?, ?, ?, ?)`,
		cu, handle, email, now, now); err != nil {
		return "", "", err
	}
	if _, err := tx.Exec(`INSERT INTO user_tokens (contributor_uuid, token_hash, token_lookup, name, created_at, scopes) VALUES (?, ?, ?, ?, ?, ?)`,
		cu, hashed, lookup, "default", now, `["contributions:submit"]`); err != nil {
		return "", "", err
	}
	if err := tx.Commit(); err != nil {
		return "", "", err
	}
	return cu, plain, nil
}

// IssueUserToken mints a new user token for an existing user. Used by the
// admin CLI to grant the maintainer reviewer-scope token.
func (s *Store) IssueUserToken(contribUUID, name string, scopes []string) (string, error) {
	if contribUUID == "" {
		return "", errors.New("contributor_uuid required")
	}
	plain := mintTokenString()
	hashed, err := hashToken(plain)
	if err != nil {
		return "", err
	}
	lookup := tokenLookupHash(plain)

	tx, err := s.DB.Begin()
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	if err := ensureLookupColumn(tx, "user_tokens"); err != nil {
		return "", err
	}

	// Verify the contributor exists and is a user.
	var kind string
	if err := tx.QueryRow("SELECT kind FROM contributors WHERE uuid=?", contribUUID).Scan(&kind); err != nil {
		return "", fmt.Errorf("contributor %s: %w", contribUUID, err)
	}
	if kind != "user" {
		return "", fmt.Errorf("contributor %s is kind=%s, want 'user'", contribUUID, kind)
	}

	scopesJSON := encodeStringArray(scopes)
	if _, err := tx.Exec(`INSERT INTO user_tokens (contributor_uuid, token_hash, token_lookup, name, created_at, scopes) VALUES (?, ?, ?, ?, ?, ?)`,
		contribUUID, hashed, lookup, name, nowUTC(), scopesJSON); err != nil {
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	return plain, nil
}

// AuthResult is the resolved identity from a single inbound request.
type AuthResult struct {
	ContributorUUID string   // user when user token present, install otherwise
	InstallUUID     string   // set when install token present (else "")
	Scopes          []string // user scopes if user token; ["contributions:submit"] for install
	IsUser          bool
	IsInstall       bool
}

// Authenticate runs both token paths and returns the resolved AuthResult.
// Either or both inputs may be empty. Returns nil if no auth was attempted
// (so the caller can serve unauthenticated reads); returns an error if
// any presented token failed to validate or the contributor is blocked.
func (s *Store) Authenticate(installToken, userBearer string) (*AuthResult, error) {
	out := &AuthResult{}
	if installToken != "" {
		uid, err := s.resolveInstallToken(installToken)
		if err != nil {
			return nil, err
		}
		out.InstallUUID = uid
		out.ContributorUUID = uid
		out.IsInstall = true
		out.Scopes = []string{"contributions:submit"}
	}
	if userBearer != "" {
		uid, scopes, err := s.resolveUserToken(userBearer)
		if err != nil {
			return nil, err
		}
		out.ContributorUUID = uid
		out.IsUser = true
		out.Scopes = scopes
	}
	if !out.IsInstall && !out.IsUser {
		return nil, nil
	}
	return out, nil
}

func (s *Store) resolveInstallToken(plain string) (string, error) {
	lookup := tokenLookupHash(plain)
	rows, err := s.DB.Query(`
		SELECT it.contributor_uuid, it.token_hash, c.blocked
		FROM install_tokens it
		JOIN contributors c ON c.uuid = it.contributor_uuid
		WHERE it.token_lookup=? AND it.revoked=0`, lookup)
	if err != nil {
		// token_lookup may be missing on a fresh DB pre-first-register; fall
		// back to a full scan rather than failing.
		return s.resolveInstallTokenSlow(plain)
	}
	defer rows.Close()
	for rows.Next() {
		var uuid, hash string
		var blocked int
		if err := rows.Scan(&uuid, &hash, &blocked); err != nil {
			continue
		}
		if !verifyTokenHash(plain, hash) {
			continue
		}
		if blocked == 1 {
			return "", errors.New("contributor_blocked")
		}
		_, _ = s.DB.Exec("UPDATE install_tokens SET last_used_at=? WHERE token_lookup=?", nowUTC(), lookup)
		return uuid, nil
	}
	return s.resolveInstallTokenSlow(plain)
}

func (s *Store) resolveInstallTokenSlow(plain string) (string, error) {
	rows, err := s.DB.Query(`SELECT it.contributor_uuid, it.token_hash, c.blocked
		FROM install_tokens it
		JOIN contributors c ON c.uuid = it.contributor_uuid
		WHERE it.revoked=0`)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	for rows.Next() {
		var uuid, hash string
		var blocked int
		if err := rows.Scan(&uuid, &hash, &blocked); err != nil {
			continue
		}
		if verifyTokenHash(plain, hash) {
			if blocked == 1 {
				return "", errors.New("contributor_blocked")
			}
			return uuid, nil
		}
	}
	return "", errors.New("invalid_token")
}

func (s *Store) resolveUserToken(plain string) (string, []string, error) {
	lookup := tokenLookupHash(plain)
	rows, err := s.DB.Query(`
		SELECT ut.contributor_uuid, ut.token_hash, ut.scopes, c.blocked
		FROM user_tokens ut
		JOIN contributors c ON c.uuid = ut.contributor_uuid
		WHERE ut.token_lookup=? AND ut.revoked=0`, lookup)
	if err != nil {
		return s.resolveUserTokenSlow(plain)
	}
	defer rows.Close()
	for rows.Next() {
		var uuid, hash, scopesJSON string
		var blocked int
		if err := rows.Scan(&uuid, &hash, &scopesJSON, &blocked); err != nil {
			continue
		}
		if !verifyTokenHash(plain, hash) {
			continue
		}
		if blocked == 1 {
			return "", nil, errors.New("contributor_blocked")
		}
		_, _ = s.DB.Exec("UPDATE user_tokens SET last_used_at=? WHERE token_lookup=?", nowUTC(), lookup)
		return uuid, decodeStringArray(scopesJSON), nil
	}
	return s.resolveUserTokenSlow(plain)
}

func (s *Store) resolveUserTokenSlow(plain string) (string, []string, error) {
	rows, err := s.DB.Query(`
		SELECT ut.contributor_uuid, ut.token_hash, ut.scopes, c.blocked
		FROM user_tokens ut
		JOIN contributors c ON c.uuid = ut.contributor_uuid
		WHERE ut.revoked=0`)
	if err != nil {
		return "", nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var uuid, hash, scopesJSON string
		var blocked int
		if err := rows.Scan(&uuid, &hash, &scopesJSON, &blocked); err != nil {
			continue
		}
		if verifyTokenHash(plain, hash) {
			if blocked == 1 {
				return "", nil, errors.New("contributor_blocked")
			}
			return uuid, decodeStringArray(scopesJSON), nil
		}
	}
	return "", nil, errors.New("invalid_token")
}

// BlockContributor flips contributors.blocked=1 with a reason.
func (s *Store) BlockContributor(contribUUID, reason string) error {
	res, err := s.DB.Exec(`UPDATE contributors SET blocked=1, blocked_reason=? WHERE uuid=?`, reason, contribUUID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("contributor not found: %s", contribUUID)
	}
	return nil
}

// LookupContributor fetches a contributor by UUID. Returns ErrNotFound when missing.
func (s *Store) LookupContributor(uuid string) (*Contributor, error) {
	c := &Contributor{}
	var blocked int
	err := s.DB.QueryRow(`SELECT uuid, kind, handle, email, github_login, created_at, last_seen, blocked, blocked_reason
		FROM contributors WHERE uuid=?`, uuid).Scan(
		&c.UUID, &c.Kind, &c.Handle, &c.Email, &c.GitHubLogin, &c.CreatedAt, &c.LastSeen, &blocked, &c.BlockedReason)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	c.Blocked = blocked == 1
	return c, nil
}

// mintTokenString returns a 32-byte base64url string suitable for use as a
// plaintext token. Caller is responsible for treating it as a secret.
func mintTokenString() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func encodeStringArray(ss []string) string {
	if len(ss) == 0 {
		return "[]"
	}
	var sb strings.Builder
	sb.WriteByte('[')
	for i, s := range ss {
		if i > 0 {
			sb.WriteByte(',')
		}
		sb.WriteByte('"')
		for _, c := range s {
			if c == '"' || c == '\\' {
				sb.WriteByte('\\')
			}
			sb.WriteRune(c)
		}
		sb.WriteByte('"')
	}
	sb.WriteByte(']')
	return sb.String()
}

func decodeStringArray(s string) []string {
	// Minimal parser sufficient for ["a","b"] scopes; not a general JSON parser.
	s = strings.TrimSpace(s)
	if s == "" || s == "[]" {
		return nil
	}
	if !strings.HasPrefix(s, "[") || !strings.HasSuffix(s, "]") {
		return nil
	}
	inner := s[1 : len(s)-1]
	var out []string
	var cur strings.Builder
	inStr := false
	for i := 0; i < len(inner); i++ {
		c := inner[i]
		if inStr {
			if c == '\\' && i+1 < len(inner) {
				cur.WriteByte(inner[i+1])
				i++
				continue
			}
			if c == '"' {
				inStr = false
				out = append(out, cur.String())
				cur.Reset()
				continue
			}
			cur.WriteByte(c)
			continue
		}
		if c == '"' {
			inStr = true
		}
	}
	return out
}

// HasScope returns true if `want` is in the auth result's scopes list.
func (a *AuthResult) HasScope(want string) bool {
	if a == nil {
		return false
	}
	for _, s := range a.Scopes {
		if s == want {
			return true
		}
	}
	return false
}

// ensureLookupColumn adds a non-secret SHA-256 lookup column to the given
// tokens table if it does not already exist. Idempotent: ALTER TABLE ADD
// COLUMN is wrapped in a check against PRAGMA table_info.
func ensureLookupColumn(tx *sql.Tx, table string) error {
	rows, err := tx.Query(fmt.Sprintf("PRAGMA table_info(%s)", table))
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, ctype string
		var notnull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return err
		}
		if name == "token_lookup" {
			return nil
		}
	}
	_, err = tx.Exec(fmt.Sprintf("ALTER TABLE %s ADD COLUMN token_lookup TEXT", table))
	if err != nil {
		return err
	}
	_, _ = tx.Exec(fmt.Sprintf("CREATE INDEX IF NOT EXISTS idx_%s_lookup ON %s(token_lookup)", table, table))
	return nil
}
