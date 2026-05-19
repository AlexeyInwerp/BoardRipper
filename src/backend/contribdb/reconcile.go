package contribdb

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
)

// mineResponse matches GET /v1/contributions/mine.
type mineResponse struct {
	Items []mineItem `json:"items"`
	Next  string     `json:"next,omitempty"` // pagination cursor (unused in this slice)
}

type mineItem struct {
	UUID         string `json:"uuid"`
	Status       string `json:"status"`
	RejectReason string `json:"reject_reason,omitempty"`
}

// Reconcile pulls the caller's own submissions from the server and updates
// outbox row statuses accordingly. Rows in terminal-but-acknowledged
// statuses (accepted/rejected/withdrawn/superseded) get their outbox status
// flipped so the UI can surface the result.
func (s *Service) Reconcile(ctx context.Context) error {
	if !s.Enabled() {
		return nil
	}
	if !s.Registered() {
		return nil
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		s.cfg.BaseURL+"/v1/contributions/mine", nil)
	if err != nil {
		return err
	}
	resp, err := s.client.Do(req)
	if err != nil {
		s.recordError("reconcile", err.Error())
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		msg := fmt.Sprintf("HTTP %d", resp.StatusCode)
		s.recordError("reconcile", msg)
		return errors.New(msg)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		s.recordError("reconcile", "read: "+err.Error())
		return err
	}
	var mr mineResponse
	if err := json.Unmarshal(body, &mr); err != nil {
		s.recordError("reconcile", "decode: "+err.Error())
		return err
	}

	for _, it := range mr.Items {
		// Only flip outbox status when the new state is one of the
		// statuses we represent locally. Unknown statuses are logged but
		// not written.
		switch it.Status {
		case StatusAccepted, StatusRejected, StatusWithdrawn, StatusSuperseded:
			if err := s.outbox.SetStatusByServerUUID(it.UUID, it.Status); err != nil {
				s.recordError("reconcile",
					fmt.Sprintf("set status %s for %s: %v", it.Status, it.UUID, err))
			}
		}
	}
	return nil
}

// Withdraw issues DELETE /v1/contributions/{uuid} and, on success, flips
// the outbox row to "withdrawn". Used by the frontend's withdraw-pending
// affordance.
func (s *Service) Withdraw(ctx context.Context, serverUUID string) error {
	if !s.Enabled() {
		return errors.New("contribdb: disabled")
	}
	if serverUUID == "" {
		return errors.New("contribdb: empty server uuid")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete,
		s.cfg.BaseURL+"/v1/contributions/"+serverUUID, nil)
	if err != nil {
		return err
	}
	resp, err := s.client.Do(req)
	if err != nil {
		s.recordError("withdraw", err.Error())
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		msg := fmt.Sprintf("HTTP %d", resp.StatusCode)
		s.recordError("withdraw", msg)
		return errors.New(msg)
	}
	return s.outbox.SetStatusByServerUUID(serverUUID, StatusWithdrawn)
}
