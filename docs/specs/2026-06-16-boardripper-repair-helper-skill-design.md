# BoardRipper Repair-Helper Skill + MCP Support — Design

**Date:** 2026-06-16
**Branch:** `feature/mcp-server-live-board-bridge`
**Depends on:** the MCP server + live-board bridge (already built on this branch).
**Builds on analogue:** `cbusillo/jetbrains-inspection-api` — confirmed the pattern (thin MCP over a live GUI) and that the *workflow layer is left to the client*; a skill fills exactly that gap. Stolen ideas: result pagination/filtering, and a staleness/generation signal.

## 1. Goal

Make the BoardRipper MCP efficient to use by adding the **guidance layer** the raw tools lack: a Claude Code **skill** that turns Claude into a structured board-repair copilot, plus **minimal MCP refinements** that make the skill's core workflow cheap (filtering/pagination + board-change detection).

Two deliverables, one increment:
- **A. Skill** `boardripper-repair-helper` — the playbook (flagship: *find-the-component-by-function*).
- **B. MCP support** — pagination/filters on `list_parts`/`list_nets`; `session` + `generation` on `board_active`.

Non-goal: replacing the MCP, the in-browser copilot (Sub-project B), or composite server-side tools (deferred).

## 2. Layering

```
SKILL (markdown playbook)  ──drives──▶  MCP tools (20)  ──bridge──▶  live board in the browser
boardripper-repair-helper                board_active, list_*,        BoardData / stores
                                         net_*, part_*, pdf_*, obd_*
```

The skill contains *no code*; it instructs Claude how/when to call the tools. The MCP refinements are small additions to existing tools.

## 3. Component A — the skill

### 3.1 Location & invocation
- Repo-versioned at `.claude/skills/boardripper-repair-helper/SKILL.md` (+ a `function-dictionary.md` reference file). Versioned with the code, shareable with testers.
- A README note documents symlinking it to `~/.claude/skills/` for bench-only use.
- Frontmatter `description` triggers on board-repair intent (e.g. "find / locate / where is … on the board", "what is the charging controller / SMC / PMIC", "trace net", "what's on net X"). Invoked in a Claude Code session connected to the BoardRipper MCP.

### 3.2 Preflight (run once per task)
1. Call `board_active`.
   - Tool errors / unreachable → tell the user to enable Settings ▸ Integrations (and that a board must be open).
   - No board open → ask the user to open one in the browser.
   - Success → record `session` + `generation` (§4) as the "context token" for staleness checks.
2. `board_resolve(board_number)` for brand/family so net-naming + IC expectations are platform-aware.

### 3.3 Flagship playbook — find-the-component-by-function
Maps a *functional description* → a concrete refdes, then shows it. Evidence order **PDF → OBD → net/connectivity** (cheap reconciliation, authoritative-first).

1. **Normalise the ask** to a function key (charger, smc/ec, pmic, usb-pd, backlight, ram, ssd, audio, wifi/bt, trackpad…) using the seed dictionary; keep the raw phrase too.
2. **PDF (first):** `pdf_search` with the function keyword(s) + any IC-family hint from the dictionary. A hit → schematic page + nearby designators → candidate refdes.
3. **OBD (second):** `obd_match`→`obd_data`; scan diagnosis sections for the function — they frequently name the controller and its rails outright → candidate refdes + key nets.
4. **Net/connectivity (last, always available):** look up the function's net-name patterns from the dictionary → `list_nets(filter)` → `net_info(net)` → collect parts on those nets → `part_info` on the few candidates → rank by "is the IC": pin-count on the function's nets, IC-ish package, `U`/`PM`/refdes prefix; demote passives (R/C/L) and connectors unless the function is a connector.
5. **Reconcile:** if signals agree → one answer. If 2–3 plausible → a ranked shortlist with the evidence per candidate.
6. **Show it (drive-UI, on by default):** `select_part(refdes)` + `highlight_net(primary rail)` + `pdf_goto(page, term)` when a PDF hit exists. One line: "showing it on your board." Honour "don't touch the view" to suppress drive-UI.
7. **Fail gracefully:** state what was searched, offer the closest candidates, and suggest concrete next steps (open/index the schematic PDF; sync OBD for this board).

### 3.4 Function dictionary (hybrid: small seed + dynamic)
- A separate `function-dictionary.md` the skill reads. Each row: **function key · net-name patterns · IC/package hint · notes**. Apple/ODM-leaning to match the corpus.
- Used in step 4 (net patterns) and to enrich step 2's PDF query (IC-family hint). When a function isn't in the dictionary, the skill falls back to pure dynamic search (PDF/OBD/raw net-name guesses) and *says so*.
- **Starter seed (provisional — maintainer corrects in-file):**

  | key | net patterns | IC/package hint |
  |---|---|---|
  | charger | `CHGR*`, `PPDCIN*`, `ACDC`, `PPVBAT*` | charger controller near DC-in |
  | smc/ec | `*SMC*`, `PM_*`, `*_EC_*` | large QFP/QFN |
  | pmic | clustered `PP*` rails, `*PMU*` | large BGA |
  | usb-pd | `USBC*_CC*`, `*VBUS*`, `*_PD_*` | per-port PD chip |
  | backlight | `*BKL*`, `LCD_BL*`, `PPVOUT_BL*` | boost driver |
  | ram | `*DDR*`, `*VDDQ*`, `*_CA_*` | BGA near SoC |
  | ssd/nand | `*NAND*`, `*PCIE*SSD*`, `PPVNAND*` | BGA |
  | audio | `*SPKR*`, `*HP_*`, `*CODEC*` | codec / amp |

### 3.5 Output conventions
- Always cite the **refdes** and the **evidence** (which net / PDF page / OBD section).
- Prefer confirming with a tool over guessing; never invent a refdes not returned by a tool.
- Keep tool calls lean: filter before listing; never page through thousands of rows to eyeball.
- Re-check the context token before acting on earlier data if the conversation is long (board may have changed).

## 4. Component B — MCP support

### 4.1 `board_active` — add `session` + `generation`
- Frontend `mcp-bridge.ts` `board_active` (and the `boardDescriptor`) returns, in addition to today's `name/parts/nets`:
  - `session`: the stable bridge session id (already generated per page).
  - `generation`: a token that changes when the active board changes — derived deterministically as `"<activeTabId>:<fileName>"` (no counter/state needed; differs iff the board differs).
- The skill records `{session, generation}` at preflight and treats a change as "board switched — re-read."
- Backend: no change (it's a passthrough `map[string]any`).

### 4.2 `list_nets` / `list_parts` — filter + pagination
- **`list_nets(filter?, limit?, offset?)`** → `{ nets: string[], total, has_more, offset }`.
- **`list_parts(filter?, side?, limit?, offset?)`** → `{ parts: {refdes, side}[], total, has_more, offset }` (adds a `side` filter: `top|bottom`).
- Defaults: `limit` 200, cap 1000; `offset` 0. `has_more = offset+returned < total`.
- Backend (`tools_live.go`): extend the arg structs so the new params forward over the bridge —
  - `filterArgs` (used by `list_nets`) gains `Limit int`, `Offset int`.
  - new `partsFilterArgs` for `list_parts`: `Filter, Side string`, `Limit, Offset int`, `Session string`.
  - Update both tool descriptions to mention filter/pagination.
- Frontend (`mcp-bridge.ts`): `list_nets`/`list_parts` honour `filter/side/limit/offset`, compute `total`+`has_more`, return the page (drop the hard 5000 slice).

### 4.3 Compatibility
Additive only — existing callers that pass just `filter` still work (defaults apply); `board_active` gains fields, removes none.

## 5. Verification

- **MCP refinements (Go + bridge):** unit-extend the live arg structs; drive `list_parts`/`list_nets` over the bridge in the Playwright/driver harness on a real board (820-02100) and assert pagination (`has_more`, `offset`, `total`) and the `side` filter; assert `board_active` returns `session`+`generation` and that `generation` differs across two open boards.
- **Skill (behavioural):** run a real Claude Code session against the live MCP with 820-02100 loaded and exercise the flagship: "find the charging controller", "where's the SMC", "find the part on net PPBUS_AON". Confirm it triangulates (PDF→OBD→net), returns a cited refdes (or shortlist), and drives the UI (`select_part`/`highlight_net`/`pdf_goto`). This is the acceptance test — mirrors the earlier Go-client exercise but through the skill.
- Build/typecheck green; backend tests green.

## 6. Out of scope (next increments, same scaffolding)
- The other three playbooks: power-rail/no-power triage, signal/net tracing, short-to-ground/measurement hunt.
- Composite server-side tools (`diagnose_net`, `find_component_by_function`) — only if profiling shows the skill is too chatty.
- Async `trigger→wait→fetch` for slow ops (PDF indexing / OBD fetch).
- The in-browser copilot panel (Sub-project B).

## 7. Open items the maintainer fills
- The function dictionary entries (the seed is a first pass; you prune/extend, especially non-Apple ODMs).
