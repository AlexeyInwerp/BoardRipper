package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

// SubmissionInput is the post-validation, server-internal projection of the
// JSON wire body. Built by the API layer from §5.5 and handed to Submit().
type SubmissionInput struct {
	TargetType         string  `json:"target_type"`
	TargetUUID         string  `json:"target_uuid"`
	TargetField        string  `json:"target_field"`
	ValueTo            *string `json:"value_to"`
	ValueFrom          *string `json:"value_from"`
	EvidenceSourceURL  *string `json:"evidence_source_url"`
	EvidenceInHand     bool    `json:"evidence_in_hand"`
	EvidenceInHandCtx  *string `json:"evidence_in_hand_ctx"`
	EvidenceRationale  *string `json:"evidence_rationale"`
	Confidence         *string `json:"confidence"`
	ClientTS           string  `json:"client_ts"`
	ContributorUUID    string  `json:"contributor_uuid"`
	InstallUUID        *string `json:"install_uuid"`
}

// Contribution mirrors the contributions table row.
type Contribution struct {
	UUID                string  `json:"uuid"`
	TargetType          string  `json:"target_type"`
	TargetUUID          string  `json:"target_uuid"`
	TargetField         string  `json:"target_field"`
	ValueTo             *string `json:"value_to"`
	ValueFrom           *string `json:"value_from"`
	EvidenceSourceURL   *string `json:"evidence_source_url"`
	EvidenceInHand      bool    `json:"evidence_in_hand"`
	EvidenceInHandCtx   *string `json:"evidence_in_hand_ctx"`
	EvidenceRationale   *string `json:"evidence_rationale"`
	Confidence          *string `json:"confidence"`
	Status              string  `json:"status"`
	ReviewerUUID        *string `json:"reviewer_uuid,omitempty"`
	ReviewedAt          *string `json:"reviewed_at,omitempty"`
	RejectReason        *string `json:"reject_reason,omitempty"`
	ContributorUUID     string  `json:"contributor_uuid"`
	InstallUUID         *string `json:"install_uuid,omitempty"`
	SubmittedAt         string  `json:"submitted_at"`
	ClientTS            string  `json:"client_ts"`
}

// SubmissionResult is the wire shape returned by Submit (POST /v1/contributions).
type SubmissionResult struct {
	UUID          string `json:"uuid"`
	Status        string `json:"status"`
	QueuePosition int    `json:"queue_position"`
}

// Submit validates the inbound patch and inserts a contributions row in
// status='submitted'. Returns the assigned UUID + queue position.
//
// Validation per spec §5.5:
//   - target_type in CHECK list
//   - target.uuid exists for target.type
//   - target.field in FieldAllowlist
//   - at least one evidence form supplied
//   - from matches current canonical (409 if not — caller maps to 409)
//   - client_ts within [now-7d, now+1h]
func (s *Store) Submit(in *SubmissionInput) (*SubmissionResult, error) {
	if err := validateClientTS(in.ClientTS); err != nil {
		return nil, err
	}
	if !IsFieldWritable(in.TargetType, in.TargetField) {
		return nil, &APIError{Code: "field_not_writable",
			Message: fmt.Sprintf("%s.%s is not writable", in.TargetType, in.TargetField),
			HTTP:    400}
	}
	if !hasEvidence(in) {
		return nil, &APIError{Code: "evidence_missing",
			Message: "Submission requires at least one evidence form.",
			HTTP:    400}
	}

	// Target must exist (entity_color is handled by an existence check on the
	// scope rather than an entity_color row, since entity_color may have no
	// pre-existing row).
	if in.TargetType == "entity_color" {
		scopeType, scopeUUID, ok := splitScope(in.TargetUUID)
		if !ok {
			return nil, &APIError{Code: "bad_target", Message: "entity_color target_uuid must be scope_type:scope_uuid", HTTP: 400}
		}
		if !s.entityExists(scopeType, scopeUUID) {
			return nil, &APIError{Code: "target_not_found", Message: "scope entity not found", HTTP: 400}
		}
	} else if !s.entityExists(in.TargetType, in.TargetUUID) {
		return nil, &APIError{Code: "target_not_found", Message: "target entity not found", HTTP: 400}
	}

	// Optimistic concurrency: value_from must equal current canonical value.
	current, err := s.EntityFieldValue(in.TargetType, in.TargetUUID, in.TargetField)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return nil, err
	}
	expected := ""
	if in.ValueFrom != nil {
		expected = *in.ValueFrom
	}
	if expected != current {
		return nil, &APIError{Code: "conflict", Message: "current canonical value does not match `from`",
			HTTP: 409,
			Details: map[string]any{
				"current_value":  current,
				"expected_from":  expected,
			}}
	}

	contribUUID := uuid.NewString()
	now := nowUTC()

	tx, err := s.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	// install_uuid is allowed to be NULL when only a user token was presented.
	var installArg any
	if in.InstallUUID != nil && *in.InstallUUID != "" {
		installArg = *in.InstallUUID
	} else {
		installArg = nil
	}
	evidenceInHand := 0
	if in.EvidenceInHand {
		evidenceInHand = 1
	}
	if _, err := tx.Exec(`INSERT INTO contributions (
		uuid, target_type, target_uuid, target_field, value_to, value_from,
		evidence_source_url, evidence_in_hand, evidence_in_hand_ctx, evidence_rationale,
		confidence, status, contributor_uuid, install_uuid, submitted_at, client_ts
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?)`,
		contribUUID, in.TargetType, in.TargetUUID, in.TargetField,
		nullStr(in.ValueTo), nullStr(in.ValueFrom),
		nullStr(in.EvidenceSourceURL), evidenceInHand,
		nullStr(in.EvidenceInHandCtx), nullStr(in.EvidenceRationale),
		nullStr(in.Confidence),
		in.ContributorUUID, installArg, now, in.ClientTS,
	); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(`INSERT INTO contribution_audit (contribution_uuid, from_status, to_status, actor_uuid, at, note)
		VALUES (?, '', 'submitted', ?, ?, 'submitted via API')`,
		contribUUID, in.ContributorUUID, now); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}

	var queuePos int
	_ = s.DB.QueryRow(`SELECT count(*) FROM contributions WHERE status='submitted' AND submitted_at <= ?`, now).Scan(&queuePos)

	return &SubmissionResult{UUID: contribUUID, Status: "submitted", QueuePosition: queuePos}, nil
}

// validateClientTS enforces the clock-skew clamp (spec §5.5 / §9 invariant #7).
func validateClientTS(s string) error {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return &APIError{Code: "bad_client_ts", Message: "client_ts must be ISO 8601 with Z suffix", HTTP: 400}
	}
	now := time.Now().UTC()
	if t.Before(now.Add(-7 * 24 * time.Hour)) {
		return &APIError{Code: "client_ts_too_old", Message: "client_ts older than 7 days", HTTP: 400}
	}
	if t.After(now.Add(1 * time.Hour)) {
		return &APIError{Code: "client_ts_in_future", Message: "client_ts more than 1h in the future", HTTP: 400}
	}
	return nil
}

func hasEvidence(in *SubmissionInput) bool {
	if in.EvidenceSourceURL != nil && *in.EvidenceSourceURL != "" {
		return true
	}
	if in.EvidenceInHand {
		return true
	}
	if in.EvidenceRationale != nil && len(strings.TrimSpace(*in.EvidenceRationale)) >= 4 {
		return true
	}
	return false
}

// entityExists is a cheap existence check for a (target_type, uuid) tuple.
func (s *Store) entityExists(targetType, uuid string) bool {
	tbl := ""
	switch targetType {
	case "brand":
		tbl = "brands"
	case "family":
		tbl = "families"
	case "model":
		tbl = "models"
	case "board":
		tbl = "boards"
	case "board_alias":
		tbl = "board_aliases"
	case "model_alias":
		tbl = "model_aliases"
	default:
		return false
	}
	var x int
	err := s.DB.QueryRow(fmt.Sprintf("SELECT 1 FROM %s WHERE uuid=?", tbl), uuid).Scan(&x)
	return err == nil
}

// ListByContributor returns contributions authored by `contribUUID`, newest first.
func (s *Store) ListByContributor(contribUUID, status string, limit int) ([]*Contribution, error) {
	q := `SELECT uuid, target_type, target_uuid, target_field, value_to, value_from,
	             evidence_source_url, evidence_in_hand, evidence_in_hand_ctx, evidence_rationale,
	             confidence, status, reviewer_uuid, reviewed_at, reject_reason,
	             contributor_uuid, install_uuid, submitted_at, client_ts
	      FROM contributions WHERE contributor_uuid=?`
	args := []any{contribUUID}
	if status != "" {
		q += " AND status=?"
		args = append(args, status)
	}
	q += " ORDER BY submitted_at DESC LIMIT ?"
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	args = append(args, limit)
	return s.scanContributions(q, args...)
}

// Queue returns the moderation queue, newest-or-oldest-first.
func (s *Store) Queue(status, order string, limit int) ([]*Contribution, error) {
	if status == "" {
		status = "submitted"
	}
	dir := "ASC"
	if order == "newest_first" {
		dir = "DESC"
	}
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	q := fmt.Sprintf(`SELECT uuid, target_type, target_uuid, target_field, value_to, value_from,
	             evidence_source_url, evidence_in_hand, evidence_in_hand_ctx, evidence_rationale,
	             confidence, status, reviewer_uuid, reviewed_at, reject_reason,
	             contributor_uuid, install_uuid, submitted_at, client_ts
	      FROM contributions WHERE status=? ORDER BY submitted_at %s LIMIT ?`, dir)
	return s.scanContributions(q, status, limit)
}

// ContributionByUUID returns a single contribution row.
func (s *Store) ContributionByUUID(u string) (*Contribution, error) {
	q := `SELECT uuid, target_type, target_uuid, target_field, value_to, value_from,
	             evidence_source_url, evidence_in_hand, evidence_in_hand_ctx, evidence_rationale,
	             confidence, status, reviewer_uuid, reviewed_at, reject_reason,
	             contributor_uuid, install_uuid, submitted_at, client_ts
	      FROM contributions WHERE uuid=?`
	rows, err := s.scanContributions(q, u)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, ErrNotFound
	}
	return rows[0], nil
}

// ContributionsForTarget returns the public contribution history for a single
// (target_type, target_uuid). Default behaviour is to filter to status=accepted
// per spec §5.1.
func (s *Store) ContributionsForTarget(targetType, uuid, status string) ([]*Contribution, error) {
	q := `SELECT uuid, target_type, target_uuid, target_field, value_to, value_from,
	             evidence_source_url, evidence_in_hand, evidence_in_hand_ctx, evidence_rationale,
	             confidence, status, reviewer_uuid, reviewed_at, reject_reason,
	             contributor_uuid, install_uuid, submitted_at, client_ts
	      FROM contributions WHERE target_type=? AND target_uuid=?`
	args := []any{targetType, uuid}
	if status != "" {
		q += " AND status=?"
		args = append(args, status)
	}
	q += " ORDER BY submitted_at DESC LIMIT 200"
	return s.scanContributions(q, args...)
}

func (s *Store) scanContributions(q string, args ...any) ([]*Contribution, error) {
	rows, err := s.DB.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Contribution
	for rows.Next() {
		c := &Contribution{}
		var (
			valueTo, valueFrom, sourceURL, inHandCtx, rationale, confidence,
			reviewerUUID, reviewedAt, rejectReason, installUUID sql.NullString
			evidenceInHand int
		)
		if err := rows.Scan(&c.UUID, &c.TargetType, &c.TargetUUID, &c.TargetField,
			&valueTo, &valueFrom, &sourceURL, &evidenceInHand, &inHandCtx, &rationale,
			&confidence, &c.Status, &reviewerUUID, &reviewedAt, &rejectReason,
			&c.ContributorUUID, &installUUID, &c.SubmittedAt, &c.ClientTS); err != nil {
			return nil, err
		}
		c.ValueTo = nullablePtr(valueTo)
		c.ValueFrom = nullablePtr(valueFrom)
		c.EvidenceSourceURL = nullablePtr(sourceURL)
		c.EvidenceInHand = evidenceInHand == 1
		c.EvidenceInHandCtx = nullablePtr(inHandCtx)
		c.EvidenceRationale = nullablePtr(rationale)
		c.Confidence = nullablePtr(confidence)
		c.ReviewerUUID = nullablePtr(reviewerUUID)
		c.ReviewedAt = nullablePtr(reviewedAt)
		c.RejectReason = nullablePtr(rejectReason)
		c.InstallUUID = nullablePtr(installUUID)
		out = append(out, c)
	}
	return out, nil
}

// Withdraw transitions a `submitted` row to `withdrawn` IF the caller is the
// original contributor.
func (s *Store) Withdraw(contribUUID, callerUUID string) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var status, contributor string
	err = tx.QueryRow("SELECT status, contributor_uuid FROM contributions WHERE uuid=?", contribUUID).Scan(&status, &contributor)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if contributor != callerUUID {
		return &APIError{Code: "not_yours", Message: "you did not author this contribution", HTTP: 403}
	}
	if status != "submitted" {
		return &APIError{Code: "not_pending", Message: "only `submitted` contributions can be withdrawn", HTTP: 400}
	}
	now := nowUTC()
	if _, err := tx.Exec("UPDATE contributions SET status='withdrawn', reviewed_at=? WHERE uuid=?", now, contribUUID); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO contribution_audit (contribution_uuid, from_status, to_status, actor_uuid, at, note) VALUES (?, ?, 'withdrawn', ?, ?, 'self-withdraw')`,
		contribUUID, status, callerUUID, now); err != nil {
		return err
	}
	return tx.Commit()
}

// Accept applies the patch to the canonical entity inside a single transaction.
// Re-checks value_from at commit time; mismatched canonical → auto-set status
// 'superseded' (spec §5.6, "optimistic concurrency").
//
// Returns the new status ('accepted' or 'superseded').
func (s *Store) Accept(contribUUID, reviewerUUID string) (string, error) {
	tx, err := s.DB.Begin()
	if err != nil {
		return "", err
	}
	defer tx.Rollback()

	row := tx.QueryRow(`SELECT status, target_type, target_uuid, target_field, value_to, value_from
		FROM contributions WHERE uuid=?`, contribUUID)
	var status, targetType, targetUUID, targetField string
	var valueTo, valueFrom sql.NullString
	if err := row.Scan(&status, &targetType, &targetUUID, &targetField, &valueTo, &valueFrom); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", err
	}
	if status != "submitted" {
		return "", &APIError{Code: "not_pending", Message: "only `submitted` contributions can be accepted", HTTP: 400}
	}

	// Re-fetch canonical inside the transaction.
	cur, err := readEntityFieldInTx(tx, targetType, targetUUID, targetField)
	if err != nil {
		return "", err
	}
	expected := ""
	if valueFrom.Valid {
		expected = valueFrom.String
	}
	now := nowUTC()
	if cur != expected {
		// Auto-supersede.
		if _, err := tx.Exec(`UPDATE contributions SET status='superseded', reviewer_uuid=?, reviewed_at=? WHERE uuid=?`,
			reviewerUUID, now, contribUUID); err != nil {
			return "", err
		}
		note := fmt.Sprintf("canonical changed: was %q at submission, now %q", expected, cur)
		_, _ = tx.Exec(`INSERT INTO contribution_audit (contribution_uuid, from_status, to_status, actor_uuid, at, note) VALUES (?, 'submitted', 'superseded', ?, ?, ?)`,
			contribUUID, reviewerUUID, now, note)
		if err := tx.Commit(); err != nil {
			return "", err
		}
		return "superseded", nil
	}

	// Apply the patch.
	if err := applyPatchInTx(tx, targetType, targetUUID, targetField, valueTo); err != nil {
		return "", err
	}
	if _, err := tx.Exec(`UPDATE contributions SET status='accepted', reviewer_uuid=?, reviewed_at=? WHERE uuid=?`,
		reviewerUUID, now, contribUUID); err != nil {
		return "", err
	}
	_, _ = tx.Exec(`INSERT INTO contribution_audit (contribution_uuid, from_status, to_status, actor_uuid, at, note) VALUES (?, 'submitted', 'accepted', ?, ?, 'applied to canonical')`,
		contribUUID, reviewerUUID, now)

	if _, err := tx.Exec(`UPDATE snapshot_state SET dirty=1 WHERE id=1`); err != nil {
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	return "accepted", nil
}

// Reject transitions a `submitted` row to `rejected` with a reason.
func (s *Store) Reject(contribUUID, reviewerUUID, reason string) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var status string
	if err := tx.QueryRow("SELECT status FROM contributions WHERE uuid=?", contribUUID).Scan(&status); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if status != "submitted" {
		return &APIError{Code: "not_pending", Message: "only `submitted` contributions can be rejected", HTTP: 400}
	}
	now := nowUTC()
	if _, err := tx.Exec(`UPDATE contributions SET status='rejected', reviewer_uuid=?, reviewed_at=?, reject_reason=? WHERE uuid=?`,
		reviewerUUID, now, reason, contribUUID); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO contribution_audit (contribution_uuid, from_status, to_status, actor_uuid, at, note) VALUES (?, 'submitted', 'rejected', ?, ?, ?)`,
		contribUUID, reviewerUUID, now, reason); err != nil {
		return err
	}
	return tx.Commit()
}

// readEntityFieldInTx is the transactional twin of EntityFieldValue.
func readEntityFieldInTx(tx *sql.Tx, targetType, uuid, field string) (string, error) {
	if targetType == "entity_color" {
		scopeType, scopeUUID, ok := splitScope(uuid)
		if !ok {
			return "", fmt.Errorf("entity_color target_uuid must be scope_type:scope_uuid: %q", uuid)
		}
		var v sql.NullInt64
		err := tx.QueryRow("SELECT color_id FROM entity_color WHERE scope_type=? AND scope_uuid=?",
			scopeType, scopeUUID).Scan(&v)
		if errors.Is(err, sql.ErrNoRows) {
			return "", nil
		}
		if err != nil {
			return "", err
		}
		if !v.Valid {
			return "", nil
		}
		return fmt.Sprintf("%d", v.Int64), nil
	}
	tbl, col, err := tableColForField(targetType, field)
	if err != nil {
		return "", err
	}
	var v sql.NullString
	q := fmt.Sprintf("SELECT %s FROM %s WHERE uuid=?", col, tbl)
	err = tx.QueryRow(q, uuid).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	return v.String, nil
}

// applyPatchInTx writes the new value to the canonical entity column.
func applyPatchInTx(tx *sql.Tx, targetType, uuid, field string, valueTo sql.NullString) error {
	if targetType == "entity_color" {
		scopeType, scopeUUID, ok := splitScope(uuid)
		if !ok {
			return fmt.Errorf("entity_color target_uuid must be scope_type:scope_uuid: %q", uuid)
		}
		if !valueTo.Valid || valueTo.String == "" {
			_, err := tx.Exec("DELETE FROM entity_color WHERE scope_type=? AND scope_uuid=?", scopeType, scopeUUID)
			return err
		}
		// Parse color_id as integer.
		var colorID int
		if _, err := fmt.Sscanf(valueTo.String, "%d", &colorID); err != nil {
			return fmt.Errorf("invalid color_id %q", valueTo.String)
		}
		// Verify color exists.
		var x int
		if err := tx.QueryRow("SELECT 1 FROM colors WHERE id=?", colorID).Scan(&x); err != nil {
			return fmt.Errorf("color %d not found", colorID)
		}
		_, err := tx.Exec(`INSERT INTO entity_color (scope_type, scope_uuid, color_id) VALUES (?, ?, ?)
			ON CONFLICT(scope_type, scope_uuid) DO UPDATE SET color_id=excluded.color_id`,
			scopeType, scopeUUID, colorID)
		return err
	}
	tbl, col, err := tableColForField(targetType, field)
	if err != nil {
		return err
	}
	var v any
	if valueTo.Valid {
		v = valueTo.String
	} else {
		v = nil
	}
	q := fmt.Sprintf("UPDATE %s SET %s=? WHERE uuid=?", tbl, col)
	res, err := tx.Exec(q, v, uuid)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// APIError carries a structured error code + HTTP status for handler use.
type APIError struct {
	Code    string         `json:"error"`
	Message string         `json:"message"`
	HTTP    int            `json:"-"`
	Details map[string]any `json:"details,omitempty"`
}

func (e *APIError) Error() string {
	if e.Message != "" {
		return e.Code + ": " + e.Message
	}
	return e.Code
}

// MarshalAPIErrorJSON returns the JSON payload for a wrapped error suitable
// for sending in the response body.
func MarshalAPIErrorJSON(err *APIError) []byte {
	b, _ := json.Marshal(err)
	return b
}

func nullStr(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

func nullablePtr(s sql.NullString) *string {
	if !s.Valid {
		return nil
	}
	v := s.String
	return &v
}
