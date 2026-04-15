# QA Agent — File Map

**git_hash:** a5a2f8e
**last_updated:** 2026-04-15

## Staleness Check

```bash
git log --oneline a7bbb79..HEAD -- src/frontend/tests/ src/backend/*_test.go src/frontend/playwright.config.ts
```

## Domain: Frontend Tests (`src/frontend/tests/`)

| File | Lines | Focus |
|------|-------|-------|
| `comprehensive.spec.ts` | 875 | Full app workflow: all formats, UI, selection, rendering, sidebar, net lines |
| `cross-format.spec.ts` | 745 | Format detection, parsing, coordinate handling, multi-layer |
| `pdf-search.spec.ts` | 516 | PDF text extraction, search, cross-item merging |
| `pdf-page-transition.spec.ts` | 252 | **NEW** — PDF tiled page transition exit gate (added in 1a4054d / 7e9268b / dc69450) |
| `boardripper.spec.ts` | 227 | Main viewer flows: drag-drop, zoom, pan, sidebar |
| `pdf-perf.spec.ts` | 210 | PDF performance: zoom caching, pre-fetch, quality tiers |
| `allegro-brd-parser.spec.ts` | 202 | Allegro binary format parsing |
| `touch-compat.spec.ts` | 178 | Touch/pinch-zoom on mobile |
| `tvw-parser.spec.ts` | 150 | Teboview multi-layer parsing |
| `integration-pipeline.spec.ts` | 78 | File load → render → cache pipeline |
| `allegro-render-visual.spec.ts` | 69 | Visual regression for Allegro render |
| `renderer-lifecycle.spec.ts` | 68 | PixiJS Application lifecycle, teardown |
| `ci-smoke.spec.ts` | 46 | Minimal smoke test for CI |

**Total: ~3,616 lines across 13 specs**

## Domain: Backend Tests (`src/backend/`)

| File | ~Lines | Focus |
|------|--------|-------|
| `databank/db_test.go` | ~100 | SQLite wrapper tests |
| `handlers/handlers_test.go` | ~100 | HTTP handler tests (path traversal, upload validation) |

**Total: ~200 lines, 2 files — SPARSE**

## Config

| File | Purpose |
|------|---------|
| `playwright.config.ts` | 30s timeout, headless Chromium, dev server on :5174 |

## Commands

```bash
# Frontend
cd src/frontend && npm test              # headless
cd src/frontend && npm test:headed       # visible browser
cd src/frontend && npm test:debug        # debug mode

# Backend
cd src/backend && go test ./... -v -count=1
```

## Coverage Gaps

### Well Tested
- All 9 format parsers
- UI interactions (selection, net highlight, drag-drop)
- PDF integration (multi-doc, search, binding)
- Performance (cache, quality tiers)
- Touch/mobile
- PixiJS lifecycle

### Not Tested
- Backend databank scanner (file indexing, PDF extraction)
- Backend board database resolution (ODM matching)
- Backend update system (Docker socket, GitHub API)
- Electron desktop app (zero test coverage)
- Cross-agent integration (board DB → library panel → scanner)
- Panel focus/activation edge cases (caused 3 historical bugs)

## Recent churn (a7bbb79..a5a2f8e)

- 8ec68f4 — feat: PDF watermark filter (test coverage TBD)
- 7e9268b — fix: page transition flash — test infra additions
- 1a4054d — fix: page-aware tile rAF guard + transition test infrastructure (pdf-page-transition.spec.ts added)
- 08f8fe5 — fix: update smoke tests — file-name testid removed in sidebar refactor
- e030e64 — fix: resolve CI lint warnings

