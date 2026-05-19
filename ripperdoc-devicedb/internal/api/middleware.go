package api

import (
	"errors"
	"log"
	"net/http"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"ripperdoc.de/devicedb/internal/store"
)

// logMiddleware logs each request line; minimal overhead, no body capture.
func logMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ww := &statusRecorder{ResponseWriter: w, status: 200}
		next.ServeHTTP(ww, r)
		log.Printf("[devicedb] [api] %s %s %d %s",
			r.Method, r.URL.Path, ww.status, time.Since(start).Round(time.Millisecond))
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(c int) { s.status = c; s.ResponseWriter.WriteHeader(c) }

// recoverMiddleware turns a panic into a 500 + stack-trace log so a panicking
// handler doesn't tear down the process.
func recoverMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("[devicedb] [api] PANIC %s %s: %v\n%s",
					r.Method, r.URL.Path, rec, debug.Stack())
				http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// corsMiddleware applies an open-by-default Access-Control-Allow-Origin to
// every response. Prototype default = "*"; production sets CORS_ALLOWED_ORIGINS
// to a comma list and we echo back the matching origin.
func corsMiddleware(allowed string, next http.Handler) http.Handler {
	allowed = strings.TrimSpace(allowed)
	allowList := strings.Split(allowed, ",")
	for i := range allowList {
		allowList[i] = strings.TrimSpace(allowList[i])
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		switch {
		case allowed == "" || allowed == "*":
			w.Header().Set("Access-Control-Allow-Origin", "*")
		case origin != "":
			for _, a := range allowList {
				if a == origin || a == "*" {
					w.Header().Set("Access-Control-Allow-Origin", origin)
					w.Header().Set("Vary", "Origin")
					break
				}
			}
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-BoardRipper-Install-Token")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// authenticate runs both auth headers through the store and returns the
// AuthResult. Returns nil + sends 401 if neither header was supplied; sends
// the appropriate error if presented tokens are invalid.
func (s *Server) authenticate(w http.ResponseWriter, r *http.Request, requireWrite bool) *store.AuthResult {
	install := r.Header.Get("X-BoardRipper-Install-Token")
	authz := r.Header.Get("Authorization")
	var bearer string
	if strings.HasPrefix(authz, "Bearer ") {
		bearer = strings.TrimPrefix(authz, "Bearer ")
	}
	if install == "" && bearer == "" {
		writeJSONError(w, &store.APIError{Code: "auth_required", Message: "auth required", HTTP: 401})
		return nil
	}
	res, err := s.Store.Authenticate(install, bearer)
	if err != nil {
		if err.Error() == "contributor_blocked" {
			writeJSONError(w, &store.APIError{Code: "contributor_blocked", Message: "this contributor is blocked", HTTP: 403})
		} else {
			writeJSONError(w, &store.APIError{Code: "invalid_token", Message: "token did not validate", HTTP: 401})
		}
		return nil
	}
	if res == nil {
		writeJSONError(w, &store.APIError{Code: "auth_required", Message: "auth required", HTTP: 401})
		return nil
	}
	// Rate limit: bucket by ContributorUUID, falling back to remote addr.
	if requireWrite && s.RateLimits != nil {
		key := res.ContributorUUID
		if key == "" {
			key = clientIP(r)
		}
		if !s.RateLimits.allowWrite(key, res.IsUser) {
			w.Header().Set("Retry-After", "60")
			writeJSONError(w, &store.APIError{Code: "rate_limited", Message: "rate limit exceeded", HTTP: 429})
			return nil
		}
	}
	return res
}

func clientIP(r *http.Request) string {
	// X-Forwarded-For first (behind reverse proxy in production), then RemoteAddr.
	if v := r.Header.Get("X-Forwarded-For"); v != "" {
		i := strings.Index(v, ",")
		if i > 0 {
			return strings.TrimSpace(v[:i])
		}
		return strings.TrimSpace(v)
	}
	addr := r.RemoteAddr
	if i := strings.LastIndex(addr, ":"); i > 0 {
		return addr[:i]
	}
	return addr
}

// RateLimitState — in-memory sliding-window counters per spec §5.7.
// Resets on restart, fine for prototype.
type RateLimitState struct {
	mu sync.Mutex
	// per-bucket recent-event timestamps (oldest first)
	writeBuckets    map[string][]time.Time
	registerBuckets map[string][]time.Time
}

// NewRateLimitState creates an empty state.
func NewRateLimitState() *RateLimitState {
	return &RateLimitState{
		writeBuckets:    map[string][]time.Time{},
		registerBuckets: map[string][]time.Time{},
	}
}

// allowWrite implements spec §5.7:
//
//	install-only push: 30/hour, 200/day
//	user-token push:   120/hour, 1000/day
//
// `isUser` toggles between the two ceilings.
func (r *RateLimitState) allowWrite(bucket string, isUser bool) bool {
	if bucket == "" {
		return true
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	events := r.writeBuckets[bucket]
	// drop entries older than 24h
	cutoff24h := now.Add(-24 * time.Hour)
	pruned := events[:0]
	for _, e := range events {
		if e.After(cutoff24h) {
			pruned = append(pruned, e)
		}
	}
	events = pruned

	hourCount := 0
	cutoff1h := now.Add(-time.Hour)
	for _, e := range events {
		if e.After(cutoff1h) {
			hourCount++
		}
	}
	hourCap, dayCap := 30, 200
	if isUser {
		hourCap, dayCap = 120, 1000
	}
	if hourCount >= hourCap || len(events) >= dayCap {
		r.writeBuckets[bucket] = events
		return false
	}
	events = append(events, now)
	r.writeBuckets[bucket] = events
	return true
}

// allowRegister implements the registration-rate cap from §5.2:
// 5/hour, 20/day per source IP.
func (r *RateLimitState) allowRegister(bucket string) bool {
	if bucket == "" {
		return true
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	events := r.registerBuckets[bucket]
	cutoff24h := now.Add(-24 * time.Hour)
	pruned := events[:0]
	for _, e := range events {
		if e.After(cutoff24h) {
			pruned = append(pruned, e)
		}
	}
	events = pruned
	hourCount := 0
	cutoff1h := now.Add(-time.Hour)
	for _, e := range events {
		if e.After(cutoff1h) {
			hourCount++
		}
	}
	if hourCount >= 5 || len(events) >= 20 {
		r.registerBuckets[bucket] = events
		return false
	}
	events = append(events, now)
	r.registerBuckets[bucket] = events
	return true
}

// requireScope short-circuits with 403 if `auth` does not carry `scope`.
func requireScope(w http.ResponseWriter, auth *store.AuthResult, scope string) bool {
	if auth.HasScope(scope) {
		return true
	}
	writeJSONError(w, &store.APIError{Code: "scope_required", Message: "missing scope: " + scope, HTTP: 403})
	return false
}

// writeJSONError writes a structured JSON error per spec §5.8.
func writeJSONError(w http.ResponseWriter, e *store.APIError) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-BoardRipper-Error-Code", e.Code)
	status := e.HTTP
	if status == 0 {
		status = http.StatusInternalServerError
	}
	w.WriteHeader(status)
	w.Write(store.MarshalAPIErrorJSON(e))
}

// asAPIError unwraps either a *store.APIError or wraps an unknown error.
func asAPIError(err error) *store.APIError {
	var ae *store.APIError
	if errors.As(err, &ae) {
		return ae
	}
	return &store.APIError{Code: "internal", Message: err.Error(), HTTP: 500}
}
