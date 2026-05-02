package librarysync

import (
	"context"
	"fmt"
	"time"

	"boardripper/databank"
)

// Run loops every 60s and invokes engine.Start when a scheduled run is due.
// The scheduler is intentionally cheap: it just consults config keys and the
// engine's running flag, so it's safe to leave running for the lifetime of
// the process.
func Run(ctx context.Context, engine *Engine, db *databank.DB) {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()

	// Immediate first check so a freshly-started server with sync overdue
	// kicks off without a 60s wait.
	checkAndRun(ctx, engine, db)

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			checkAndRun(ctx, engine, db)
		}
	}
}

func checkAndRun(ctx context.Context, engine *Engine, db *databank.DB) {
	enabled, _ := db.GetConfig("sync_enabled")
	if enabled != "1" {
		return
	}
	sched, _ := db.GetConfig("sync_schedule")
	if sched == "" || sched == "off" {
		return
	}
	if engine.Running() {
		return
	}

	now := time.Now()
	last, _ := db.GetConfig("sync_last_run_iso")
	var lastT time.Time
	if last != "" {
		if t, err := time.Parse(time.RFC3339, last); err == nil {
			lastT = t.Local()
		}
	}

	due, ok := nextRunTime(sched, lastT)
	if !ok {
		return
	}
	if now.Before(due) {
		return
	}

	fmt.Printf("librarysync: scheduled run due (schedule=%s, last=%s)\n", sched, last)
	if _, err := engine.Start(ctx); err != nil {
		fmt.Printf("librarysync: scheduled start failed: %v\n", err)
	}
}

// nextRunTime returns the next 03:00 local-time slot for the given schedule
// strictly after `from`. If `from` is the zero value, it's treated as
// "right now" minus a tick — meaning the scheduler will fire on the next
// 03:00 boundary. Returns ok=false for unknown schedules.
func nextRunTime(schedule string, from time.Time) (time.Time, bool) {
	if from.IsZero() {
		// First-ever run: schedule the next upcoming 03:00 slot from now.
		from = time.Now().Add(-time.Minute)
	}
	loc := time.Local
	from = from.In(loc)

	switch schedule {
	case "daily":
		next := time.Date(from.Year(), from.Month(), from.Day(), 3, 0, 0, 0, loc)
		if !next.After(from) {
			next = next.Add(24 * time.Hour)
		}
		return next, true
	case "weekly":
		// Fire Sunday 03:00. Go: Sunday=0.
		next := time.Date(from.Year(), from.Month(), from.Day(), 3, 0, 0, 0, loc)
		// Advance to the next Sunday strictly after `from`.
		for {
			if next.Weekday() == time.Sunday && next.After(from) {
				return next, true
			}
			next = next.Add(24 * time.Hour)
		}
	case "monthly":
		// Fire on day 1 at 03:00. Compute first of *this* month at 03:00;
		// if not after `from`, advance to first of next month.
		next := time.Date(from.Year(), from.Month(), 1, 3, 0, 0, 0, loc)
		if !next.After(from) {
			next = time.Date(from.Year(), from.Month()+1, 1, 3, 0, 0, 0, loc)
		}
		return next, true
	default:
		return time.Time{}, false
	}
}
