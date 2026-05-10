//go:build !(linux || darwin || freebsd || netbsd || openbsd || dragonfly)

package handlers

import (
	"net/http/httptest"
	"testing"
)

// placeholderFileInfo is a no-op stub on non-Unix platforms. Sys() returns
// nil, so statBlocks's type assertion fails and isPlaceholder returns false.
// The test therefore expects a short-read 503 (size=1234567, body="") rather
// than a placeholder 503.
type placeholderFileInfo struct {
	fakeFileInfo
}

// assertPlaceholderResponse on non-Unix: isPlaceholder returns false because
// statBlocks can't extract st_blocks, so the request falls through to the
// short-read path and we get a 503 with Retry-After: 5 instead.
func assertPlaceholderResponse(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	if rec.Code != 503 {
		t.Fatalf("expected 503 (short-read fallback on non-Unix), got %d", rec.Code)
	}
}
