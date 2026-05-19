package contribdb

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// submitRequest matches the canonical-server request body for
// POST /v1/contributions (spec §5.5). Field shape kept byte-for-byte
// identical to the spec so any wire-contract drift surfaces in code-review
// rather than at runtime.
type submitRequest struct {
	LocalUUID string         `json:"local_uuid,omitempty"`
	Target    submitTarget   `json:"target"`
	To        string         `json:"to,omitempty"`
	From      string         `json:"from,omitempty"`
	Evidence  submitEvidence `json:"evidence"`
	Confidence string        `json:"confidence,omitempty"`
	ClientTS  string         `json:"client_ts"`
}

type submitTarget struct {
	Type  string `json:"type"`
	UUID  string `json:"uuid"`
	Field string `json:"field"`
}

type submitEvidence struct {
	SourceURL       string          `json:"source_url,omitempty"`
	BoardInHand     bool            `json:"board_in_hand"`
	BoardInHandCtx  json.RawMessage `json:"board_in_hand_ctx,omitempty"`
	Rationale       string          `json:"rationale,omitempty"`
}

// submitResponse matches the server's reply: `{uuid, status, queue_position}`.
type submitResponse struct {
	UUID          string `json:"uuid"`
	Status        string `json:"status"`
	QueuePosition int    `json:"queue_position"`
}

// PushOne attempts a single POST /v1/contributions for the given outbox
// row. On success, marks the row submitted with the server-assigned UUID;
// on any error, records a failed attempt and leaves the row pending.
//
// Refuses to push if registration hasn't completed yet — the row stays in
// pending_send (spec §5.2: "pushes wait until registration is confirmed").
func (s *Service) PushOne(ctx context.Context, sub *Submission) error {
	if !s.Enabled() {
		return errors.New("contribdb: disabled")
	}
	if !s.Registered() {
		return errors.New("contribdb: install not yet registered")
	}

	req, err := s.buildSubmitRequest(sub)
	if err != nil {
		_ = s.outbox.MarkAttempt(sub.LocalUUID, err.Error(), 0)
		return err
	}
	body, err := json.Marshal(req)
	if err != nil {
		_ = s.outbox.MarkAttempt(sub.LocalUUID, "marshal: "+err.Error(), 0)
		return err
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		s.cfg.BaseURL+"/v1/contributions", bytes.NewReader(body))
	if err != nil {
		_ = s.outbox.MarkAttempt(sub.LocalUUID, err.Error(), 0)
		return err
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := s.client.Do(httpReq)
	if err != nil {
		_ = s.outbox.MarkAttempt(sub.LocalUUID, err.Error(), 0)
		return err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))

	if resp.StatusCode/100 != 2 {
		msg := fmt.Sprintf("HTTP %d: %s", resp.StatusCode, truncate(string(respBody), 200))
		_ = s.outbox.MarkAttempt(sub.LocalUUID, msg, 0)
		return errors.New(msg)
	}

	var sr submitResponse
	if err := json.Unmarshal(respBody, &sr); err != nil {
		msg := "decode: " + err.Error()
		_ = s.outbox.MarkAttempt(sub.LocalUUID, msg, 0)
		return errors.New(msg)
	}
	if sr.UUID == "" {
		msg := "server returned empty uuid"
		_ = s.outbox.MarkAttempt(sub.LocalUUID, msg, 0)
		return errors.New(msg)
	}
	if err := s.outbox.MarkSubmitted(sub.LocalUUID, sr.UUID); err != nil {
		return fmt.Errorf("mark submitted: %w", err)
	}
	return nil
}

// PushAllPending walks the outbox once, dispatching every pending/failed
// row through PushOne. Single-flight-protected so two scheduler ticks
// can't double-fire.
func (s *Service) PushAllPending(ctx context.Context) error {
	if !s.Enabled() {
		return nil
	}
	s.pushingMu.Lock()
	if s.pushing {
		s.pushingMu.Unlock()
		return nil // drop-guard
	}
	s.pushing = true
	s.pushingMu.Unlock()
	defer func() {
		s.pushingMu.Lock()
		s.pushing = false
		s.pushingMu.Unlock()
	}()

	if !s.Registered() {
		// Don't bump per-row attempt counts when the install isn't
		// registered yet — the registration loop is retrying separately.
		return nil
	}

	pending, err := s.outbox.ListPending(50)
	if err != nil {
		s.recordError("push", "list pending: "+err.Error())
		return err
	}
	var firstErr error
	for _, sub := range pending {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		// Per-request timeout so a hung connection doesn't stall the
		// whole queue.
		reqCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		if err := s.PushOne(reqCtx, sub); err != nil {
			s.recordError("push", fmt.Sprintf("%s: %v", sub.LocalUUID, err))
			if firstErr == nil {
				firstErr = err
			}
		}
		cancel()
	}
	return firstErr
}

// buildSubmitRequest translates an outbox row into the spec §5.5 body.
// Validation duplicates server-side checks (defence in depth) so an empty
// evidence row never leaves the device.
func (s *Service) buildSubmitRequest(sub *Submission) (*submitRequest, error) {
	if sub.TargetType == "" || sub.TargetUUID == "" || sub.TargetField == "" {
		return nil, errors.New("submission missing target_type/uuid/field")
	}
	if sub.EvidenceSourceURL == "" && !sub.EvidenceInHand && len(sub.EvidenceRationale) < 4 {
		return nil, errors.New("submission missing evidence (source_url, board_in_hand, or rationale ≥4 chars)")
	}
	clientTS := time.Now().UTC().Format(time.RFC3339)
	r := &submitRequest{
		LocalUUID: sub.LocalUUID,
		Target: submitTarget{
			Type:  sub.TargetType,
			UUID:  sub.TargetUUID,
			Field: sub.TargetField,
		},
		To:         sub.ValueTo,
		From:       sub.ValueFrom,
		Confidence: sub.Confidence,
		ClientTS:   clientTS,
		Evidence: submitEvidence{
			SourceURL:   sub.EvidenceSourceURL,
			BoardInHand: sub.EvidenceInHand,
			Rationale:   sub.EvidenceRationale,
		},
	}
	if sub.EvidenceInHandCtx != "" {
		r.Evidence.BoardInHandCtx = json.RawMessage(sub.EvidenceInHandCtx)
	}
	return r, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
