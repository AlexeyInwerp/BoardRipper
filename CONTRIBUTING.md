# Contributing to BoardRipper

Thanks for considering a contribution. This is a small project with one
maintainer, so a few notes on how the workflow runs:

## Bug reports & feature requests

Use the issue templates: [Bug](.github/ISSUE_TEMPLATE/bug_report.yml),
[Feature](.github/ISSUE_TEMPLATE/feature_request.yml),
[Format request](.github/ISSUE_TEMPLATE/format_request.yml).

For boardview formats not yet supported, the format-request template
asks for a sample file. Real-world test files are how new parsers
get written — please attach what you can.

**Security issues** go to [SECURITY.md](SECURITY.md), not the public
issue tracker.

## Pull requests

The codebase is documented in detail in [CLAUDE.md](CLAUDE.md) at the
root — that's the canonical "what lives where" map. The PR template
([.github/pull_request_template.md](.github/pull_request_template.md))
also has a regression checklist for the high-risk areas.

Before opening a PR:

1. **Build**: `cd src/frontend && npm install && npm run build` (frontend),
   `cd src/backend && go build ./...` (backend).
2. **Tests**: `cd src/backend && go test ./...` and
   `cd src/frontend && npm test` (Playwright; needs Chromium).
3. **Type-check**: `cd src/frontend && npx tsc -b` should be clean.
4. **Format / lint**: `gofmt -w` for Go, `npx eslint <file>` for TS.

## Architecture quick reference

```
src/frontend/             React + TypeScript + Vite SPA
  src/parsers/            One file per board format (pure functions)
  src/renderer/           PixiJS scene graph, BoardRenderer, board-scene
  src/pdf/                pdf.js wrapper, glyph extraction, tile cache
  src/components/         Toolbar, sidebar, dialogs, overlays
  src/panels/             Dockview panels (BoardViewer, PDF, Library, …)
  src/store/              useSyncExternalStore-backed stores
  tests/                  Playwright E2E specs

src/backend/              Go net/http server
  handlers/               HTTP handlers per resource
  databank/               File scanner, search, dedup, content hashing
  pdfindex/               PDF text indexing (pdfium/wazero → FTS5)
  boarddb/                Read-only board reference DB (SQLite)
  librarysync/            WebDAV mirror engine + scheduler
  obd/                    OpenBoardData parser + cache
  updater/                Self-update (signed manifests, Docker socket)
```

## Adding a new format

1. Create `src/frontend/src/parsers/<name>-parser.ts` exporting
   `parse<NAME>(buffer: ArrayBuffer): BoardData | Promise<BoardData>`.
2. Register in `src/frontend/src/parsers/index.ts` with extension(s),
   sniff function, and parser reference (call `registerFormat(...)`).
   `registry.ts` only defines the `FormatDescriptor` interface and the
   `registerFormat`/`detectFormat` helpers — the actual registration calls
   live in `index.ts`.
3. Write a format spec at `docs/formats/<NAME>_FORMAT.md`. Cover the
   header, body structure, coordinate system, and any obfuscation /
   encryption.
4. Add a Playwright spec under `src/frontend/tests/` covering at least
   one real sample (or a synthetic fixture if redistribution rights are
   unclear).
5. **Bump `PARSER_VERSION` in `src/frontend/src/store/board-cache.ts`**
   so existing IndexedDB cache entries get invalidated.

## Conventions

- TypeScript strict mode, no `any` without comment.
- All board coordinates in mils internally.
- Component naming: PascalCase for React components, camelCase for
  functions / variables.
- Logging uses scoped loggers from `store/log-store.ts` — never raw
  `console.log` in committed code.
- Don't add comments that explain WHAT the code does; well-named
  identifiers do that. Add comments only for WHY (a non-obvious
  invariant, a workaround for a specific bug, behaviour that would
  surprise a reader).

## Code derived from external sources

The Allegro parser (`src/frontend/src/parsers/allegro/`) is transliterated
from KiCad's GPL-3.0 C++. That's why the project as a whole is AGPL-3.0.
If you're adding parser code derived from another reverse-engineering
project, please:

1. Note the source and its license in [THIRD_PARTY.md](THIRD_PARTY.md).
2. Ensure the source's license is compatible with AGPL-3.0
   (GPL-3.0+, MIT, Apache-2.0, BSD are fine; any *new* GPL-only code
   would force the whole project to GPL — coordinate first).
3. Add a top-of-file comment in the parser pointing at the upstream
   commit / file you transliterated from.

## Releases

Maintainer-only. See [docs/RELEASE_RUNBOOK.md](docs/RELEASE_RUNBOOK.md).
End users update through the in-app **Update & Restart** button (signed
manifest verification, no GitHub credential needed).

## Code of Conduct

Be decent. Disagree with the technical merits, not the person. I reserve
the right to lock conversations or block users for harassment, but this
is a tools project for a niche audience — that's hopefully never needed.

## Questions

Discord: **@inwerp** on the [All Things Repair](https://discord.gg/BYEkKTMNNY)
server, or [mail@ripperdoc.de](mailto:mail@ripperdoc.de).
