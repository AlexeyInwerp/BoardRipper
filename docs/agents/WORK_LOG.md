# Agent Work Log

Append-only. Most recent entries at the bottom.

---

## 2026-04-11 — agent-master
**Action:** Created agent infrastructure — directories, global rules, file maps, memories for agent-master + format-maint
**Reasoning:** Project needs persistent agent context to avoid re-scanning and re-discovering on every session. Built two agents as prototype pair before replicating to all 7.
**Commit:** initial setup (pending)
**Files touched:** docs/agents/ (all files)

## 2026-04-11 — agent-master
**Action:** Added issue-triage agent (skill + file map + memory). Ran first health check — found and fixed 3 inconsistencies: stale skill registry, wrong agent count in memory, missing issue-triage from domain tree.
**Reasoning:** Issue triage needed to bridge GitHub bug reports / beta feedback into agent pipeline. Health check validated the orchestrator pattern works — it correctly detected drift between skill definition and FILE_MAP.md.
**Commit:** uncommitted
**Files touched:** docs/agents/issue-triage/ (new), docs/agents/agent-master/FILE_MAP.md, docs/agents/agent-master/MEMORY.md, ~/.claude/skills/boardripper-agent-master/skill.md, ~/.claude/skills/boardripper-issue-triage/skill.md

## 2026-04-15 — agent-master
**Action:** FILE_MAP rescan across all 9 agents from a7bbb79→a5a2f8e (~60 commits of drift). Filled XZZ column in format-maint consistency matrix, re-validated Allegro row post 5de2b24 (allegroFloat endianness), added CAD multi-revision row post 5b319e6/980aa92/17e572e/db38f68, and marked 12 known divergences OPEN/CLOSED/UNCHANGED. Triggered by PDF debug ping-pong audit (session 61862378).
**Reasoning:** Frozen FILE_MAPs were misleading dispatched agents — highest churn in pdf (30+ commits), ui, renderer, format-maint. Priority was correctness of domain diffs, not full regen.
**Commit:** uncommitted (staged, docs only)
**Files touched:** docs/agents/{agent-master,backend,devops,format-maint,issue-triage,pdf,qa,renderer,ui}/FILE_MAP.md, docs/agents/format-maint/MEMORY.md, docs/agents/WORK_LOG.md, docs/agents/ERROR_LOG.md


---

## 2026-04-15 — format-maint
**Action:** Resolved 3 open ambiguities in consistency matrix — Allegro traces/vias/layerNames coverage, Allegro arc sweep orientation, BVR3 flipY semantics. All three moved from PARTIAL/OPEN to CLOSED.
**Reasoning:** (1) Audited `allegro-assembler.ts` directly — `extractTraces`/`extractVias`/`extractLayerNames` are all implemented, uniform across v16.0–17.4, and their outputs are set on `BoardData` (assembler.ts:85-87). No version gates skip them. (2) Arc sweep: `linearizeArc` (assembler.ts:330-393) correctly reads `subType & 0x40` per spec, computes wrapped sweep, steps ~10°; `parseBlock0x01` has no version-conditional around `subType` so behavior is invariant. Arcs are pre-linearized to `Trace[]` before rendering, so no renderer-side convention is involved. (3) BVR3 flipY: `bvr3-parser.ts` reads Y verbatim, descriptor defaults to false — same as BVR1 and BRD. The BoardRenderer.ts:1108 comment claiming BVR is Y-up is legacy/misleading; runtime actually does not flip and has not for a long time. Empirically correct.
**Commit:** uncommitted (docs only, no src changes)
**Files touched:** docs/agents/format-maint/MEMORY.md, docs/agents/WORK_LOG.md, docs/agents/ERROR_LOG.md


---

## 2026-04-18 — renderer
**Action:** Fixed two z-order bugs: (1) selected pin labels hidden by selection overlay in normal (non-dim) mode — pin labels for the selected part are now raised into `netLabelLayer` unconditionally whenever a part is selected, removing the two duplicated dim-only raise blocks. (2) net lines drawn over selected labels — introduced PixiJS v8 `RenderLayer` (`selectionLabelLayer`) added to viewport after `netLinesGfx`; `netLabelLayer` + the 4 elevated label objects are attached to it so they keep scene.root as logical parent (transforms inherited) but render after net lines. Also dropped `labelSizeSmall` default 4 → 3 and added an auto-migration that bumps stored value 4 → 3 for users on the old default.
**Reasoning:** RenderLayer is the minimum-invasive way to override render order without refactoring the viewport/scene/butterfly layout or changing net-line coord computation (net lines span scene.root and butterflyRoot so they can't move into either). Unconditional pin-label raise simplifies renderSelection — one path instead of three with ambient-dim/effective-net gates.
**Commit:** uncommitted
**Files touched:** src/frontend/src/renderer/BoardRenderer.ts, src/frontend/src/store/render-settings.ts, docs/agents/renderer/FILE_MAP.md, docs/agents/renderer/MEMORY.md
