# Agent Error Log

Append-only. Records failures, wrong assumptions, and lessons for future agents.

---

## 2026-04-15 — pdf
**Error:** Multi-day symptom-chasing debug session on two interacting PDF bugs (canvas mirroring + wrong-page flash). ~25–30 user turns, multiple sign-flip "fixes" that masked the real cause.
**Context:** Session 61862378-7e3e-4d01-bde0-7cfe4bd6d718.jsonl (~66MB).
Two bugs were tangled:
  1. PDF canvas mirroring — persistent canvases were being created with `getContext('2d', { alpha: false })`, and pdf.js-rendered offscreen canvases were being returned to the shared canvas pool. After reuse, stale draw ops from the pdf.js Worker painted mirrored/flipped content on the reused surface.
  2. Wrong-page flash during tiled page transitions — tile cache keys omitted the page number, so tiles rendered for page N were served as "best available" on page N+1. Compounded by React StrictMode double-firing the page-change effect, which consumed `skipResetRef` on the first pass and left the second pass without a reset guard.
**Root cause:** Never invoked `superpowers:systematic-debugging`, despite the skill being explicitly scoped for visual bugs. Chased symptoms in this order: `alpha:false` context reuse → canvas pool reuse → adjacent-page effect tweaks → (finally) "never pool pdf.js canvases" + "page in tile key" + `prevPageRef` for StrictMode.
Many intermediate fixes were sign flips that happened to move the artifact around rather than eliminate it.
**Resolution:** Fix commits:
  - 7e9268b — fix: page transition flash — StrictMode double-fire, deferred adj cleanup
  - dc69450 — fix: eliminate wrong-page flash during tiled page transitions
Also: earlier pool/alpha fixes landed in cb3b309 / b77a38c / 2e155da (pre-window, referenced in pdf FILE_MAP).
**Lesson:**
  - **Always** invoke `superpowers:systematic-debugging` before proposing a fix for any PDF visual bug. No exceptions.
  - **StrictMode rule:** any effect that mutates a ref-based guard (e.g. `skipResetRef`) must be idempotent under double-fire. Use `prevPageRef` / equality checks.
  - **Tile-key invariant:** tile cache keys MUST include `(file, page, col, row, scale)`. Page omission is a class of bug.
  - **No sign-flip rule:** if a proposed fix is "flip the boolean and see" without a mechanistic explanation, reject it.
  - **Never pool pdf.js-rendered canvases.** The Worker may queue stale draws after `page.render()` resolves — abandon to GC by setting `width = 1; height = 1`.
  - **Persistent canvases never use `alpha: false`.** Only freshly-acquired pooled offscreen canvases may.
**Prevention:** `boardripper-pdf` skill rewritten with:
  - Mandatory systematic-debugging gate on bug entry
  - StrictMode double-fire rule documented
  - Tile-key invariant called out
  - No-sign-flip rule
  - `pdf-page-transition.spec.ts` as exit gate for any tile/page-change fix (added in 1a4054d)

---

## 2026-04-15 — format-maint
**Error:** Misleading legacy comment in BoardRenderer.ts:1108-1110
**Context:** Auditing BVR3 flipY semantics for the consistency matrix.
**Root cause:** Comment reads "BVR files use Y-up math convention. Screen uses Y-down. Always flip Y to convert, matching OpenBoardView's CoordToScreen (ty = -1 * ...)." — but the actual code on line 1114 returns `fmt.flipY ?? false`, and BVR1/BVR3 descriptors do not set flipY, so the renderer never flips BVR. The comment contradicts observed behavior.
**Resolution:** Unresolved (doc-only; renderer agent should update the comment to reflect actual semantics, e.g., "Defer to descriptor flipY; BVR/BRD are screen-space Y-down and need no flip"). No data-path or rendering bug — just a stale comment that would mislead future maintainers.
**Lesson:** When a comment disagrees with its code, trust the code and a long production history over the comment.
