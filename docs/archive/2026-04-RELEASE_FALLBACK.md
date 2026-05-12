# Release Fallback — RETIRED 2026-05-06

> This document described the old GitHub-Actions-based release pipeline that was
> retired with v0.19.0. It is kept for historical reference only.
>
> **Current release pipeline:** see [RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md).
> Releases are now built and signed locally by the maintainer's Mac via
> `scripts/release.sh`, pushed to `ghcr.io/alexeyinwerp/boardripper` (GHCR) and
> mirrored as a signed tarball at `https://www.ripperdoc.de/boardripper/`.
> No GitHub Actions CI involvement; no `GITHUB_TOKEN` required by end-users.

---

The content below is the original fallback runbook, accurate as of v0.18.x.
Do not use it for new releases.

---

## Original content (historical)

Use this playbook when the **GitHub Actions release workflow cannot produce
artifacts** — most commonly because the repository has hit the free-tier
**Artifact storage quota** (message: *"Failed to CreateArtifact: Artifact
storage quota has been hit. Usage is recalculated every 6–12 hours."*).

Normal path was [`.github/workflows/release.yml`](../.github/workflows/release.yml)
triggered by pushing a `v*` tag. That workflow has since been renamed to
`.github/workflows/release.yml.disabled` (commit `7200694`) and is no longer
active.

The legacy script is preserved at `scripts/release.legacy.sh` for reference.
