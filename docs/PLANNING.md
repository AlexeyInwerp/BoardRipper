# BoardRipper — Architecture pointers

The original phased roadmap (Phase 1–5) is archived at [archive/PLANNING_v1.md](archive/PLANNING_v1.md). This file used to track current focus but went stale fast and was dropping broken links to internal-only directories. The canonical architectural reference is now:

- **[CLAUDE.md](../CLAUDE.md)** at the repo root — supported formats, render pipeline, key invariants, store layout, safety rules.
- **[CHANGELOG.md](../CHANGELOG.md)** — what shipped when, with rationale.
- **[docs/formats/](formats/)** — one file per parsed file format.
- **[docs/PDF_VIEWER.md](PDF_VIEWER.md)** — full PDF render-pipeline architecture.
- **[docs/RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md)** — maintainer release procedure (signing key, version bump, tarball mirror).

Planning artifacts (issue tracker, roadmap discussions) live on GitHub:

- **Open issues**: <https://github.com/AlexeyInwerp/BoardRipper/issues>
- **Closed milestones / release notes**: <https://github.com/AlexeyInwerp/BoardRipper/releases>
