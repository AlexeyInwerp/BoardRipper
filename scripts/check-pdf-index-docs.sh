#!/usr/bin/env bash
set -euo pipefail
# Allowlist: files that are EXPECTED to contain raw /api/pdfindex/ strings.
# - pdf-index-client.ts: the sole frontend caller — all pdfindex API calls go here
# - pdfindex.go: the backend handler (route comments)
# - pdfindex_test.go: handler unit test (constructs test requests against the API)
# - pdf-index.spec.ts: Playwright E2E (polls the API to assert indexing)
# - main.go: route registration
# - PDF_VIEWER.md: canonical API reference doc
# - docs/superpowers/: agent knowledge-base docs (may reference paths)
allow='src/frontend/src/pdf/pdf-index-client.ts|src/frontend/tests/pdf-index.spec.ts|src/backend/handlers/pdfindex.go|src/backend/handlers/pdfindex_test.go|src/backend/main.go|docs/PDF_VIEWER.md|docs/superpowers/'
hits=$(grep -rln "/api/pdfindex/" --include='*.ts' --include='*.tsx' --include='*.go' --include='*.md' src docs 2>/dev/null | grep -Ev "$allow" || true)
if [ -n "$hits" ]; then
  echo "ERROR: /api/pdfindex/ referenced outside the allowlist:"; echo "$hits"
  echo "Update the allowlist in scripts/check-pdf-index-docs.sh consciously, or move the reference."
  exit 1
fi
echo "pdf-index docs guard: OK"
