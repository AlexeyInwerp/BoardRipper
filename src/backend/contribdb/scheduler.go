package contribdb

import (
	"context"
	"log"
	"time"
)

// Scheduler ticks two cadences concurrently:
//   - pull: snapshot manifest every 24h (configurable via contribdb_cadence)
//   - push: outbox drain every 60s (push retry)
// Plus a 5m reconcile interval that walks /contributions/mine.
//
// All loops watch ctx.Done() so a SIGTERM cancels them cleanly. The
// manual-trigger channel lets the HTTP handler ("Sync now") kick a pull
// without waiting for the next tick.
type Scheduler struct {
	svc        *Service
	manualPull chan struct{}
}

// NewScheduler wires a scheduler against a Service.
func NewScheduler(svc *Service) *Scheduler {
	return &Scheduler{
		svc:        svc,
		manualPull: make(chan struct{}, 1),
	}
}

// TriggerPull is a non-blocking nudge for the scheduler to pull on the
// next tick. Coalesces multiple presses into one tick (channel size 1).
func (s *Scheduler) TriggerPull() {
	select {
	case s.manualPull <- struct{}{}:
	default:
	}
}

// Run is the long-lived scheduler loop. Blocks until ctx is cancelled.
func (s *Scheduler) Run(ctx context.Context) {
	pullTicker := time.NewTicker(pullInterval(s.svc))
	defer pullTicker.Stop()

	pushTicker := time.NewTicker(defaultPushRetryDelay)
	defer pushTicker.Stop()

	reconcileTicker := time.NewTicker(5 * time.Minute)
	defer reconcileTicker.Stop()

	// First-tick: fire a pull shortly after boot so a fresh install gets
	// the latest data without waiting 24 h. Delay 30 s so the register
	// retry has a chance to land first.
	bootTimer := time.NewTimer(30 * time.Second)
	defer bootTimer.Stop()

	log.Printf("[contribdb] [scheduler] running (cadence=%s)", LoadCadence(s.svc.db))

	for {
		select {
		case <-ctx.Done():
			return

		case <-bootTimer.C:
			if cadenceOK(s.svc) {
				if err := s.svc.PullSnapshot(ctx); err != nil {
					log.Printf("[contribdb] [scheduler] boot pull: %v", err)
				}
			}

		case <-s.manualPull:
			if err := s.svc.PullSnapshot(ctx); err != nil {
				log.Printf("[contribdb] [scheduler] manual pull: %v", err)
			}
			if err := s.svc.Reconcile(ctx); err != nil {
				log.Printf("[contribdb] [scheduler] manual reconcile: %v", err)
			}

		case <-pullTicker.C:
			if cadenceOK(s.svc) {
				if err := s.svc.PullSnapshot(ctx); err != nil {
					log.Printf("[contribdb] [scheduler] pull: %v", err)
				}
			}

		case <-pushTicker.C:
			// Push is gated on registration internally; safe to call
			// every tick even when we're not yet registered.
			if err := s.svc.PushAllPending(ctx); err != nil {
				log.Printf("[contribdb] [scheduler] push: %v", err)
			}

		case <-reconcileTicker.C:
			if err := s.svc.Reconcile(ctx); err != nil {
				log.Printf("[contribdb] [scheduler] reconcile: %v", err)
			}
		}
	}
}

// pullInterval translates the configured cadence into a Duration.
func pullInterval(svc *Service) time.Duration {
	switch LoadCadence(svc.db) {
	case "hourly":
		return time.Hour
	case "off", "manual":
		// Idle ticker — pulls won't happen via this cadence anyway, but
		// we still need a non-zero duration. cadenceOK() gates the
		// actual fire.
		return 24 * time.Hour
	default:
		return defaultPullInterval
	}
}

// cadenceOK reports whether the configured cadence permits auto-pulls.
// "off" and "manual" both suppress scheduled pulls; manual still works
// via the trigger channel.
func cadenceOK(svc *Service) bool {
	c := LoadCadence(svc.db)
	return c != "off" && c != "manual"
}
