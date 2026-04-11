# Issue Triage — Memory

## Issue History Summary

All 8 historical issues were filed in a burst on 2026-03-25 to 2026-03-29 — likely from a beta testing session. All resolved within days. No open issues remain as of 2026-04-11.

### Pattern Analysis

**Most affected domains:**
- Renderer (3 issues): zoom focus, pad outline, selection duplication
- UI (3 issues): contrast button, recently viewed, layer persistence
- Backend/format (1 issue): TVW files not listed in library scan
- Desktop/PDF (1 issue): Electron can't open PDFs

**Recurring theme:** State not persisting or not applying until panel is focused (issues #1, #5, #6). This suggests the reactive store → panel rendering pipeline has edge cases around focus/activation state.

## Beta Testers

(No tester identification yet — issues were filed from the repo owner account. Watch for external contributors.)

## Triage Decisions

(None yet — all issues resolved before triage agent existed.)

## Open Questions

1. Where do beta testers report issues? GitHub only, or also Telegram/direct?
2. Should the agent proactively create issues from ERROR_LOG entries that look user-facing?
3. Should there be a "beta-feedback" label separate from "bug"?
