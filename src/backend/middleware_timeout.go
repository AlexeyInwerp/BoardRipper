package main

import (
	"context"
	"net/http"
	"time"
)

// withTimeout wraps a handler with a request-scoped context deadline so
// downstream code that respects context (database/sql QueryContext,
// handlers that pass r.Context() through) can short-circuit on slow
// queries instead of holding the writer goroutine indefinitely.
//
// Apply this at route registration around handlers that hit the database.
// Don't apply it to long-running endpoints (scan trigger, large file
// uploads/downloads, update apply) — those have their own cancellation.
//
// On deadline expiry the handler's downstream calls observe ctx.Err() ==
// context.DeadlineExceeded; whether the response is partial or 504 depends
// on the handler. For our handlers (which always check err returns),
// callers see a clean 5xx and can retry.
func withTimeout(d time.Duration) func(http.HandlerFunc) http.HandlerFunc {
	return func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			ctx, cancel := context.WithTimeout(r.Context(), d)
			defer cancel()
			next(w, r.WithContext(ctx))
		}
	}
}
