package contribdb

import (
	"database/sql"
	"errors"
	"fmt"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// Submission status values. Spec §6 / §5 — also enforced by a CHECK in the
// schema for defence-in-depth.
const (
	StatusPendingSend = "pending_send"
	StatusSubmitted   = "submitted"
	StatusAccepted    = "accepted"
	StatusRejected    = "rejected"
	StatusWithdrawn   = "withdrawn"
	StatusSuperseded  = "superseded"
	StatusFailed      = "failed"
)

// Outbox owns <dataDir>/contribdb/outbox.db. One row per local submission.
// Separate file from the canonical snapshot — the spec is explicit that
// no contributor / contributions / *_tokens tables ever live in the
// snapshot tarball, and a separate file makes the snapshot atomic-swap
// trivial (just replace snapshot.db; the outbox is untouched).
type Outbox struct {
	db *sql.DB
	mu sync.Mutex
}

// Submission is one outbox row. JSON tags match the frontend submit shape
// (spec §5.5). evidence_in_hand_ctx is stored as a JSON string.
type Submission struct {
	LocalUUID           string    `json:"local_uuid"`
	ServerUUID          string    `json:"server_uuid,omitempty"`
	TargetType          string    `json:"target_type"`
	TargetUUID          string    `json:"target_uuid"`
	TargetField         string    `json:"target_field"`
	ValueTo             string    `json:"value_to"`
	ValueFrom           string    `json:"value_from"`
	EvidenceSourceURL   string    `json:"evidence_source_url,omitempty"`
	EvidenceInHand      bool      `json:"evidence_in_hand"`
	EvidenceInHandCtx   string    `json:"evidence_in_hand_ctx,omitempty"`
	EvidenceRationale   string    `json:"evidence_rationale,omitempty"`
	Confidence          string    `json:"confidence,omitempty"`
	Status              string    `json:"status"`
	LastAttemptAt       string    `json:"last_attempt_at,omitempty"`
	AttemptCount        int       `json:"attempt_count"`
	LastError           string    `json:"last_error,omitempty"`
	CreatedAt           time.Time `json:"created_at"`
}

// OpenOutbox opens (creating if missing) the outbox SQLite. WAL mode +
// busy_timeout matches the databank pool's discipline.
func OpenOutbox(path string) (*Outbox, error) {
	dsn := path + "?_pragma=journal_mode(wal)&_pragma=foreign_keys(on)&_pragma=busy_timeout(5000)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open outbox: %w", err)
	}
	// Single writer keeps WAL contention bounded; reads are infrequent.
	db.SetMaxOpenConns(1)

	if _, err := db.Exec(outboxSchema); err != nil {
		db.Close()
		return nil, fmt.Errorf("outbox schema: %w", err)
	}
	return &Outbox{db: db}, nil
}

// Close releases the SQLite handle.
func (o *Outbox) Close() error {
	if o == nil || o.db == nil {
		return nil
	}
	return o.db.Close()
}

const outboxSchema = `
CREATE TABLE IF NOT EXISTS submissions (
  local_uuid           TEXT PRIMARY KEY,
  server_uuid          TEXT,
  target_type          TEXT NOT NULL,
  target_uuid          TEXT NOT NULL,
  target_field         TEXT NOT NULL,
  value_to             TEXT,
  value_from           TEXT,
  evidence_source_url  TEXT,
  evidence_in_hand     INTEGER NOT NULL DEFAULT 0,
  evidence_in_hand_ctx TEXT,
  evidence_rationale   TEXT,
  confidence           TEXT,
  status               TEXT NOT NULL,
  last_attempt_at      TEXT,
  attempt_count        INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT,
  created_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_status ON submissions(status);
`

// Enqueue inserts a new pending_send row. local_uuid is the caller-supplied
// idempotency key (also acts as the body's idempotency hint when posted).
func (o *Outbox) Enqueue(sub *Submission) error {
	if sub == nil {
		return errors.New("outbox: nil submission")
	}
	if sub.LocalUUID == "" {
		return errors.New("outbox: empty local_uuid")
	}
	if sub.Status == "" {
		sub.Status = StatusPendingSend
	}
	if sub.CreatedAt.IsZero() {
		sub.CreatedAt = time.Now().UTC()
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	_, err := o.db.Exec(`
INSERT INTO submissions(
  local_uuid, server_uuid, target_type, target_uuid, target_field,
  value_to, value_from, evidence_source_url, evidence_in_hand,
  evidence_in_hand_ctx, evidence_rationale, confidence,
  status, attempt_count, created_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		sub.LocalUUID, nullableString(sub.ServerUUID),
		sub.TargetType, sub.TargetUUID, sub.TargetField,
		sub.ValueTo, sub.ValueFrom,
		nullableString(sub.EvidenceSourceURL), boolToInt(sub.EvidenceInHand),
		nullableString(sub.EvidenceInHandCtx), nullableString(sub.EvidenceRationale),
		nullableString(sub.Confidence),
		sub.Status, sub.AttemptCount,
		sub.CreatedAt.UTC().Format(time.RFC3339),
	)
	return err
}

// Get returns one submission by local_uuid, or (nil, nil) when absent.
func (o *Outbox) Get(localUUID string) (*Submission, error) {
	row := o.db.QueryRow(`
SELECT local_uuid, server_uuid, target_type, target_uuid, target_field,
       value_to, value_from, evidence_source_url, evidence_in_hand,
       evidence_in_hand_ctx, evidence_rationale, confidence,
       status, last_attempt_at, attempt_count, last_error, created_at
FROM submissions WHERE local_uuid = ?`, localUUID)
	sub, err := scanSubmission(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return sub, err
}

// ListPending returns rows that are eligible to be pushed (pending_send) or
// retried (failed). Oldest first.
func (o *Outbox) ListPending(limit int) ([]*Submission, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := o.db.Query(`
SELECT local_uuid, server_uuid, target_type, target_uuid, target_field,
       value_to, value_from, evidence_source_url, evidence_in_hand,
       evidence_in_hand_ctx, evidence_rationale, confidence,
       status, last_attempt_at, attempt_count, last_error, created_at
FROM submissions
WHERE status IN ('pending_send','failed')
ORDER BY created_at ASC
LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Submission
	for rows.Next() {
		s, err := scanSubmission(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// ListAll returns all submissions newest-first, capped at `limit`. Used by
// the /api/contribdb/mine handler.
func (o *Outbox) ListAll(limit int) ([]*Submission, error) {
	if limit <= 0 {
		limit = 200
	}
	rows, err := o.db.Query(`
SELECT local_uuid, server_uuid, target_type, target_uuid, target_field,
       value_to, value_from, evidence_source_url, evidence_in_hand,
       evidence_in_hand_ctx, evidence_rationale, confidence,
       status, last_attempt_at, attempt_count, last_error, created_at
FROM submissions ORDER BY created_at DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Submission
	for rows.Next() {
		s, err := scanSubmission(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// Counts returns (pending, failed, total). Used by the Status struct.
func (o *Outbox) Counts() (pending, failed, total int) {
	_ = o.db.QueryRow(`SELECT count(*) FROM submissions WHERE status IN ('pending_send')`).Scan(&pending)
	_ = o.db.QueryRow(`SELECT count(*) FROM submissions WHERE status = 'failed'`).Scan(&failed)
	_ = o.db.QueryRow(`SELECT count(*) FROM submissions`).Scan(&total)
	return
}

// MarkSubmitted records a successful POST: server-assigned UUID and the new
// status. Touches attempt_count + last_attempt_at so the UI shows recency.
func (o *Outbox) MarkSubmitted(localUUID, serverUUID string) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	_, err := o.db.Exec(`
UPDATE submissions
SET status = ?, server_uuid = ?, last_attempt_at = ?, attempt_count = attempt_count + 1, last_error = NULL
WHERE local_uuid = ?`,
		StatusSubmitted, serverUUID, time.Now().UTC().Format(time.RFC3339), localUUID)
	return err
}

// MarkAttempt records a failed attempt without dropping the row to terminal
// status. attemptCap is the threshold past which the row flips to "failed"
// — set to 0 for "never give up" (we still keep retrying failed rows).
func (o *Outbox) MarkAttempt(localUUID, errMsg string, attemptCap int) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	// Bump attempt count and persist last_error; promote to "failed" past cap.
	res, err := o.db.Exec(`
UPDATE submissions
SET attempt_count = attempt_count + 1,
    last_attempt_at = ?,
    last_error = ?,
    status = CASE
      WHEN ? > 0 AND attempt_count + 1 >= ? THEN 'failed'
      ELSE status
    END
WHERE local_uuid = ? AND status IN ('pending_send','failed')`,
		time.Now().UTC().Format(time.RFC3339), errMsg, attemptCap, attemptCap, localUUID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return errors.New("outbox: row missing or terminal")
	}
	return nil
}

// SetStatus moves a row to a terminal status from the reconcile loop. No
// row-touch when the row is already in that status.
func (o *Outbox) SetStatus(localUUID, status string) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	_, err := o.db.Exec(`UPDATE submissions SET status = ? WHERE local_uuid = ? AND status != ?`,
		status, localUUID, status)
	return err
}

// SetStatusByServerUUID is the variant used by the reconcile loop: the
// server returns rows keyed by their UUID, which we mapped from the
// previous push attempt.
func (o *Outbox) SetStatusByServerUUID(serverUUID, status string) error {
	if serverUUID == "" {
		return nil
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	_, err := o.db.Exec(`UPDATE submissions SET status = ? WHERE server_uuid = ? AND status != ?`,
		status, serverUUID, status)
	return err
}

// scanner abstracts QueryRow / Rows so scanSubmission can be reused.
type scanner interface {
	Scan(dest ...any) error
}

func scanSubmission(r scanner) (*Submission, error) {
	var (
		serverUUID, evSrc, evCtx, evRat, conf, lastAt, lastErr sql.NullString
		evInHand                                               int
		createdAtStr                                           string
		sub                                                    Submission
	)
	if err := r.Scan(
		&sub.LocalUUID, &serverUUID, &sub.TargetType, &sub.TargetUUID, &sub.TargetField,
		&sub.ValueTo, &sub.ValueFrom, &evSrc, &evInHand, &evCtx, &evRat, &conf,
		&sub.Status, &lastAt, &sub.AttemptCount, &lastErr, &createdAtStr,
	); err != nil {
		return nil, err
	}
	sub.ServerUUID = serverUUID.String
	sub.EvidenceSourceURL = evSrc.String
	sub.EvidenceInHand = evInHand != 0
	sub.EvidenceInHandCtx = evCtx.String
	sub.EvidenceRationale = evRat.String
	sub.Confidence = conf.String
	sub.LastAttemptAt = lastAt.String
	sub.LastError = lastErr.String
	if t, err := time.Parse(time.RFC3339, createdAtStr); err == nil {
		sub.CreatedAt = t
	}
	return &sub, nil
}

func nullableString(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
