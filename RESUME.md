# RESUME BREADCRUMB — UI/UX roadmap execution

If you are a woken/continuing Claude instance (a continuation timer fired, or
the user said "continue"), this is the live state. Delete this file once the
roadmap work is fully done and reviewed.

## Goal
Execute the UI/UX improvement roadmap Phases 1–6 from
`~/.claude/.../memory/project_uiux_path_2026_06_12.md`, each phase = its own
commit + dev deploy (`./NASdeploy-dev.sh`), then a final sanity review.

## Done (committed on main)
- 0495267 Phase 1 — PDF paging trio + worklist toasts + hidden-parts recovery
- 567366a Phase 2 — first-contact (empty-history boot, drop toast, honest copy)
- 98de9d5 Phase 3 — Settings coherence (commit-model unify, scoped footer, split, update section)
- 325afda Phase 4 — BindLink link story + board-side affordance + update-badge vv→v fix

## Remaining
- Phase 5 — Discoverability: QW6 (hidden shortcuts into registry + merge ⌘O/⌘P),
  QW16 ('?' overlay reusing ShortcutList), QW17 (differentiate the two sidebar
  buttons), QW18 (donor D badge + Manage donors link), QW19 (double-click hints +
  Open button + Enter-to-open on search hits), QW21 (overlay buttons data-tooltip
  not native title), QW22 (ComponentInfo pin-table worklist buttons), M2
  (filter-expands-tree in Board#/Folders).
- Phase 6 — Reach: M6 (AZERTY labels via getLayoutMap), M7 (SearchTab render cap +
  memo), M8 (bookmark pill context menu + undo), M9 (dead history live-open
  fallback), M10 (crossProbe hidden-panel toast), M11 (demo board from MOCK_BOARD),
  M12 (watermark wand → terms popover + deep-link), M13 (per-tab dockview context
  menu), M14 (touch long-press → context menu).
- Low-impact copy batch (roadmap §"Small-but-low-impact"): remove disabled
  "Save as BVR3" button, FZ dialog filename, etc.
- Final sanity check + review of all phases.

## Verify/commit/deploy routine
1. `cd src/frontend && npx tsc --noEmit && npm run build`
2. ensure backend: `curl -s localhost:1336/api/health` else
   `cd src/backend && PORT=1336 DATA_DIR=/tmp/br-dev-data go run . &`
3. `npx playwright test tests/ci-smoke.spec.ts` (one-off verify specs deleted after)
4. `git add -A && git commit` then `./NASdeploy-dev.sh` (dev only, port 1234; live untouched)

## Notes
- Dev deploy sometimes prints "Cannot reach NAS rd-nas" transiently — just re-run.
- keyboard-shortcuts-game + binding-categorization specs are red on a CLEAN tree
  (pre-existing test rot, audit attack-order step 6) — not caused by this work.
