# BoardRipper — Current Focus

> Living doc. The original phased roadmap (Phase 1–5) is archived at [archive/PLANNING_v1.md](archive/PLANNING_v1.md). It is no longer authoritative — the project long outgrew it.

## Version

Current: **v0.4.5** (see `CHANGELOG.md` / GitHub releases for full history).

## Where things stand

- ✅ **9 board file formats** supported end-to-end: BVR1, BVR3, BRD, BDV, FZ, CAD (multi-revision), XZZ, TVW, Allegro BRD (v16–17.4). Specs in [formats/](formats/).
- ✅ **PDF viewer** — tiled render path, watermark filter via `operationsFilter`, multi-document side-by-side, search UX, page-transition regression guard ([PDF_VIEWER.md](PDF_VIEWER.md)).
- ✅ **Board reference database** — ODM matcher, resolver, SQLite databank.
- ✅ **Electron desktop app** (Mac + Windows) with self-update via Docker socket on NAS build.
- ✅ **Release pipeline** — per-entry parser versioning, granular cache control, real changelog in releases.
- ✅ **Agent infrastructure** — 9 specialist agents under [agents/](agents/) with MEMORY / FILE_MAP / GLOBAL_RULES.

## Current focus (short, bumped by releases)

- PDF viewer stability polish after the tiled-render rewrite. See [ERROR_LOG](agents/ERROR_LOG.md) for the debug-session post-mortem and [boardripper-pdf skill](~/.claude/skills/boardripper-pdf/SKILL.md) for the prevention rules.
- Agent infrastructure: mechanize FILE_MAP refresh + WORK_LOG entries so docs don't drift silently across many commits.
- Format-maint matrix: XZZ column fill + Allegro/CAD refresh after recent parser changes.
- Beta-tester feedback triage via `boardripper-issue-triage`.

## Where to find things

- **Architectural rules** — [CLAUDE.md](../CLAUDE.md) (read first).
- **PDF pipeline** — [PDF_VIEWER.md](PDF_VIEWER.md) + CLAUDE.md § "PDF render pipeline".
- **Format specs** — [formats/](formats/) (one file per format).
- **State layer** — [src/frontend/src/store/README.md](../src/frontend/src/store/README.md).
- **Agents** — [agents/GLOBAL_RULES.md](agents/GLOBAL_RULES.md) + per-agent `MEMORY.md` / `FILE_MAP.md`.
- **Known hazards / dead ends** — [agents/ERROR_LOG.md](agents/ERROR_LOG.md).
- **Release routine** — the `release` skill.
