//go:build linux || darwin || freebsd || netbsd || openbsd || dragonfly

package handlers

import (
	"net/http/httptest"
	"strings"
	"syscall"
	"testing"
)

// placeholderFileInfo wraps fakeFileInfo with a Sys() that returns a
// *syscall.Stat_t with Blocks=0, simulating a cloud placeholder. Used
// by TestServeFileEager_Placeholder.
type placeholderFileInfo struct {
	fakeFileInfo
}

func (p placeholderFileInfo) Sys() interface{} {
	return &syscall.Stat_t{
		// Blocks: 0 (default — the placeholder signal)
		// Size: filled by fakeFileInfo, but Stat_t has its own field; tests
		// only need the Blocks value.
	}
}

// assertPlaceholderResponse checks that the response is a 503 with the
// expected Retry-After and a body mentioning "placeholder".
func assertPlaceholderResponse(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	if rec.Code != 503 {
		t.Fatalf("expected 503 (placeholder pre-flight), got %d", rec.Code)
	}
	if got := rec.Header().Get("Retry-After"); got != retryAfterPlaceholder {
		t.Fatalf("Retry-After: got %q want %q", got, retryAfterPlaceholder)
	}
	body := rec.Body.String()
	if !strings.Contains(strings.ToLower(body), "placeholder") {
		t.Fatalf("body should mention 'placeholder'; got %q", body)
	}
}
