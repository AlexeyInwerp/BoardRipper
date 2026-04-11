# Agent Master — Memory

## Agent Team

8 specialized agents for BoardRipper. Established 2026-04-11.

Roles:
- **format-maint** — parser consistency, format documentation, interface uniformity
- **issue-triage** — GitHub issues, beta tester feedback, priority routing to agents
- **backend** — Go API, board database integration, SQLite, file management
- **renderer** — PixiJS v8 scene graph, GPU batching, spatial culling, layers
- **ui** — React panels (Dockview), toolbar, sidebar, theming, stores
- **pdf** — PDF render pipeline, text extraction, canvas pooling, glyph overlay
- **devops** — Docker, Electron, CI/CD, NAS deployment, code signing
- **qa** — Playwright E2E, Go backend tests, integration coverage

## Error Patterns

(None recorded yet. This section grows as agents report failures.)

## Cross-Agent Observations

(None yet. Record patterns like: "renderer and format-maint both touch board-scene.ts boundary" or "ui changes frequently break qa tests".)

## Improvement Backlog

(Lessons from ERROR_LOG that need systematic fixes, not just one-off patches.)
