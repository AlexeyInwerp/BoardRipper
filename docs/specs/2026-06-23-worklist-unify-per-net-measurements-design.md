# Worklist v2 — unified surface, per-net measurements, device binding (export-ready)

**Date:** 2026-06-23
**Status:** Design in review, pre-implementation
**Supersedes the UI split introduced by:** `docs/specs/2026-06-16-worklist-ai-mode-feedback-loop-design.md` (the data/loop semantics from that spec stay; only the separate measurement surface is folded in)

**Implemented in two independently-shippable phases** (see "Phasing"):
Phase 1 = unified worklist + per-net measurements + bidirectional review;
Phase 2 = device binding to the boards.db reference DB + export-readiness fields.
The server-side worklist/case DB *export* itself is a later increment (contribdb).

## Problem

The worklist tab currently presents two surfaces that feel like two variants:

1. The **normal worklist** — ticket note + part rows + net rows, each with a
   repair mark and a free-form note.
2. A separate **AI section** (`AiWorklistSection`) appended below, containing a
   standalone list of measurement-request rows (`MeasurementRow`), a chat-style
   relay transcript, and a prompt box.

Measurements live in their own list, disconnected from the net rows they are
about. A net the agent asks you to measure appears twice in concept (as a net
entry and as a measurement row). One worklist should do the job.

## Goal

Collapse the standalone measurement list onto the net rows. A net row gains an
inline **measurement field** the technician can fill at any time (no agent
required), and which the agent can also request. Keep one small AI-specific
element — the relay transcript + prompt box — for free-form text and for the
rare measurement ask that targets a part or pin (which has no net row).

Non-goals: changing part-row UI, changing the relay/message model, adding
measurements to part or pin rows, publishing readings to an external DB (a
separate future increment).

## Decisions (locked)

- **Measurement lives on the net entry** (not a flat array filtered by target).
  One measurement per net row — matches "a net row *has* a measurement field"
  and makes user-initiated readings first-class.
- **Net measurement types: V / Diode / Ω only** (`voltage | diode | resistance`).
  No continuity/other on net rows.
- **Nets only.** Part rows keep mark + note, unchanged.
- **Part/pin measurement asks degrade to a relay message** — no structured row.
- **Keep the relay** (transcript + prompt box) as the only AI-specific surface.
- **Each worklist is bound to a device** from the boards.db reference DB
  (brand → family → model → board). Resolve the open board and store the
  `DeviceRef` now (Phase 2). When the board can't be resolved (drag-drop, not in
  DB, no backend) the worklist works **unbound**, with a "Set device" picker to
  bind it manually or later. Device = **board-level** (the specific PCB), with
  model/family/brand carried for grouping.
- **The server-side worklist/case DB export is deferred** (contribdb increment).
  The data model is made export-ready now (`schemaVersion`, per-case `updatedAt`,
  populated `device`, `contentHash`, structured measurements/marks); the upload
  pipeline, server schema, and richer case fields (structured symptom/outcome)
  are out of scope here. See "Device binding" and "Export-readiness" below.
- **The worklist is a source-agnostic shared artifact.** The agent can pick up a
  fully *user-built* worklist as the input to its analysis — not only ones it
  populated itself. The read tools must return user-origin entries, notes, and
  measurements, not just agent-origin ones.

## Bidirectional review: agent picks up a user-built worklist

The primary flow so far is agent → worklist → user (agent populates, user
answers). This must also work in reverse: the technician does the work by hand —
marks parts replaced/reworked, marks nets, records V/Diode/Ω readings, writes
notes — gets stuck, and asks the agent (from the Claude Code side) to **review
the worklist and suggest further steps**.

What this requires (mostly already present; the gaps are called out):

- **The agent reads the whole worklist, source-agnostic.** `worklist_get`
  already returns all part/net entries with marks + notes + ticket note.
  `get_measurements` must now return **user-recorded** net measurements too
  (`source: 'user'`), not only agent-requested ones — otherwise the agent can't
  see the readings the tech already took. This is the one real behavioural change
  the per-net model introduces, and it is what makes "review my work" possible.
- **The agent writes its review back through the same surfaces** that render
  inline: a relay `post_message` for reasoning / the summary, new
  `request_measurement` calls for the next probes to take (appear as requested
  fields on the relevant net rows), and `worklist_update` / `worklist_set_list_note`
  for mark or note suggestions. No new tool is needed.
- **No "AI mode" gate.** A worklist built entirely by hand is fully agent-readable
  whenever MCP is connected. The relay section appears once the agent posts its
  first message (`messages.length > 0`) or MCP is connected, so the review
  surfaces even on a worklist that had no agent involvement before.
- **In-app trigger:** none added (YAGNI). The agent acts when the user asks it in
  the Claude Code chat; the existing relay prompt box is the in-app channel to
  nudge it ("review this worklist and suggest next steps" → `get_user_messages`).
  An explicit "Ask AI to review" button is out of scope — it can't summon an
  agent that isn't already listening.

## Data model

`NetWorklistEntry` (in `src/frontend/src/store/worklist-store.ts`) gains one
optional field:

```ts
export interface NetMeasurement {
  kind: 'voltage' | 'diode' | 'resistance';   // UI: V / Diode / Ω
  value?: string;                              // "0.452", "3.31" — empty until taken
  unit?: string;                               // defaults per kind (V / V / Ω), editable
  status: 'requested' | 'recorded';            // requested = agent asked, value empty
  prompt?: string;                             // agent's ask, shown subtly on the row
  expected?: string;                           // agent's spec, if given
  source: 'agent' | 'user';                    // who created it (for the AI badge)
  at: number;                                  // created/updated timestamp
}

export interface NetWorklistEntry {
  netName: string;
  mark: NetWorklistMark;
  note: string;
  unresolved?: boolean;
  surge?: boolean;
  measurement?: NetMeasurement;                // NEW — at most one per net
}
```

The worklist-level `measurements?: MeasurementEntry[]` array is **removed** from
the active model. `messages?` and `aiOrigin?` are unchanged.

### Default unit per kind
`voltage → "V"`, `diode → "V"` (diode drop is a voltage), `resistance → "Ω"`.
Editable, so probes reading mV/kΩ are expressible.

## Device binding (Phase 2)

The north star (ties to contribdb) is a server-side database of worklists grouped
**by device and by case** — "this fault on this board, here's how it was solved."
A worklist *is* a case; the boards.db reference DB is the device spine. So each
worklist is tied to a device identity resolved from boards.db.

### Device record on the worklist
`BoardWorklistes` (the per-board container) gains a populated `device`:

```ts
export interface DeviceRef {
  boardDbId?: string;     // boards.db board UUID — the canonical device key
  boardNumber?: string;   // "820-02016", "NM-A251" — the PCB number
  model?: string;         // "MacBook Pro 16\" 2019"
  modelNumber?: string;   // "A2141"
  brand?: string;         // "Apple"
  family?: string;        // "MacBook Pro"
  resolution: 'resolved' | 'pattern_matched' | 'manual' | 'unbound';
  resolvedAt?: number;
}

// BoardWorklistes gains:  device?: DeviceRef;  schemaVersion: number;
```

`device` lives on `BoardWorklistes`, not per-worklist — every case on the same
opened board shares one device. (A worklist moved/copied to another board re-binds
on hydration against the new board.)

### Resolution sources (in order, best-effort, on first worklist creation for a board)
1. **Library-opened board** — the databank file already carries `board_uuid` +
   `board_number` + `resolution_status`. Use directly; no extra call. → `resolved`
   / `pattern_matched`.
2. **Otherwise** — call `GET /api/boards/resolve?q=<fileName or board number/metadata>`;
   on a `match`, populate `DeviceRef` from it. → `resolved` / `pattern_matched`.
3. **No match / no backend (Electron) / offline** — leave `device.resolution =
   'unbound'`. The worklist is fully usable.

### "Set device" affordance
A small control in the worklist header shows the bound device (`Brand · Model ·
Board#`) or "Set device" when unbound. Clicking opens a picker backed by
`GET /api/boards/hierarchy` (Brand → Family → Model → Board) to bind/correct
manually → `resolution = 'manual'`. This is the only new device UI; it reuses the
hierarchy already consumed by the Database Editor panel.

### Out of scope (kept minimal)
No automatic re-resolution churn (resolve once per board, cache on the record),
no device-level aggregation UI, no cross-board case browsing — those belong to the
export/contribdb increment.

## Export-readiness (Phase 2, structural only — no export built)

The export pipeline, server schema, auth, and richer case fields (structured
symptom / root-cause / explicit solved-unsolved beyond marks) are a **later
increment**. This spec only guarantees the local record is export-ready:

- `BoardWorklistes.schemaVersion: number` — starts at `1`, bumped on structural
  change; lets a future server ingest / local migration branch safely.
- `Worklist.updatedAt: number` — per-case modified time (today only the
  board-level record has one); needed for export dedup / sync.
- `BoardWorklistes.contentHash?: string` — board-file content hash when cheaply
  available; a device fingerprint that survives filename changes.
- **Invariants:** stable ids (`id` / `refdes` / `netName` / board key never reused);
  structured enumerable data (measurements `{kind,value,unit,expected,source,at}`,
  marks a fixed enum); self-contained record (carries fileName, contentHash,
  device, schemaVersion, entries, measurements, notes, timestamps — shippable
  without the original file). These are exactly why per-net measurements beat the
  flat array for aggregation.

### Migration (on hydration / load)
For each persisted worklist that still has a `measurements[]` array:
- For each measurement whose `target` matches a `netEntries[].netName`
  (case-insensitive, canonical): set that net entry's `measurement` from it
  (`pending → requested`, `answered → recorded`, `skipped → drop`). If a net has
  multiple, keep the most recent by `requestedAt`.
- Measurements whose target is a part/pin/unknown net: append a one-line relay
  `messages[]` entry (role `agent`) preserving the prompt + any value, so nothing
  is silently lost.
- Delete the `measurements[]` array afterward.
Migration runs once in the existing hydrate path (where `netEntries` is already
back-filled); persisted format for everything else stays byte-stable.

## Store API (`worklist-store.ts`)

Replace the measurement methods that operated on the flat array:

- **Remove:** `aiRequestMeasurement`, `answerMeasurement(id,…)`, `skipMeasurement(id)`
  in their current array form; `aiSnapshot`'s `measurements` shape changes.
- **Add (user + agent):**
  - `setNetMeasurement(worklistId, netName, kind, value, unit?)` — user records a
    reading; status `recorded`, source `user`. Creating one auto-adds the net
    entry if absent (mirrors `pushNets`).
  - `requestNetMeasurement(netName, { kind, prompt, expected })` — agent ask;
    status `requested`, source `agent`; auto-adds the net entry; sets `aiOrigin['n:NET']`.
  - `recordNetMeasurement(netName, value, unit?)` — fills a requested measurement
    → `recorded` (the "answer" path).
  - `clearNetMeasurement(worklistId, netName)` — removes the measurement (the
    row's ✕ / "skip").
- `aiSnapshot()` returns net measurements inline under each net entry.

## Net row UI (`WorklistPanel.tsx` → `WorklistNetRow`)

The net row keeps name + mark + surge + note, and gains a compact measurement
strip beneath the row header:

- **Three type chips:** `V` `Diode` `Ω`. Selecting one reveals a value input
  (unit auto-fills, editable). Recording commits on Enter/blur (same pattern as
  notes).
- **Empty state:** chips are subtle; nothing else shown. One click to start.
- **Requested state** (agent asked): the requested kind chip is pre-selected and
  highlighted with an AI badge + the agent's `prompt`/`expected` shown small;
  filling the value flips `requested → recorded` and reports back over MCP.
- **Recorded state:** shows `kind: value unit` with an inline edit + ✕ to clear.

Remove from `AiWorklistSection`: the `measurements` block and the `MeasurementRow`
component. The section keeps only the relay transcript + `AiPromptBox`, and is
renamed to reflect it is just the relay (e.g. `WorklistRelaySection`). Its
visibility gate stays: shown when MCP is connected or `messages.length > 0`.

## MCP tools (`src/backend/mcpserver/tools_live.go` + bridge + `store/mcp-bridge.ts`)

- `request_measurement(target, kind, prompt, expected)`:
  - target resolves to a **net** → route to `requestNetMeasurement`; `kind` is
    clamped to `voltage|diode|resistance` (continuity/other → fall through to the
    relay path below with a note).
  - target is a **part/pin** (or unknown) → `post_message` (role agent) with the
    ask text. Tool description updated to say part/pin asks land in the relay.
- `get_measurements`: returns net measurements (netName, kind, status, value,
  unit, expected, **source**) read off net entries — **including user-recorded
  ones** (`source: 'user'`), so the agent sees readings the tech already took
  when reviewing a user-built worklist. Optional `status` filter maps to
  `requested|recorded`; an optional `source` filter is available but unset by
  default (returns both).
- `worklist_get`: its measurement section now reads inline net measurements.
- `worklist_add`/`worklist_update`/`worklist_set_list_note`/`post_message`/
  `get_user_messages`: unchanged.
- The `boardripper-repair-helper` SKILL.md worklist-loop playbook is updated:
  measurements are requested/read per net; part/pin asks use the relay.

## Testing

Playwright (geometry-aware, fixture-guarded), per the no-ship-without-Playwright
rule:

1. **User-initiated:** open a board, add a net to the worklist, select the `Ω`
   chip on its row, type a value, blur → assert the value renders **on that net
   row** (its `boundingBox` overlaps the net row, not a separate list) and
   survives a worklist re-open.
2. **Agent-requested (store-level + UI):** call `requestNetMeasurement` → assert
   the net row shows the requested/badged state and no separate measurement list
   exists; record a value → assert it flips to recorded and `get_measurements`
   returns it.

3. **Bidirectional review (store + backend):** build a worklist by hand
   (net entries + a user-recorded `Ω` reading, no agent involvement) → assert
   `get_measurements` returns the user reading with `source: 'user'`, and
   `worklist_get` returns the full hand-built picture. Then a `request_measurement`
   on a net appears as a requested field on its row → confirms the review loop
   closes on a previously non-AI worklist.

4. **Device binding (Phase 2):** open a library-resolved board → assert the
   worklist header shows the bound `Brand · Model · Board#` and the persisted
   record has `device.resolution === 'resolved'` with a `boardDbId`. Open a
   drag-dropped/unknown board → assert `unbound` + a working "Set device" picker
   that binds via the hierarchy (`resolution === 'manual'`). Backend:
   `boards_test.go` already covers `Resolve`; add a worklist-store unit test that
   a hydrated record stamps `schemaVersion` and carries `device`.

Backend: `go test ./mcpserver/` covering `request_measurement` net vs part/pin
routing, `get_measurements` shape + source-agnostic return, and `worklist_get`
on a user-built worklist.

## Phasing

Two independently-shippable phases off `main`:

- **Phase 1 — unified worklist (the core refactor).** Per-net measurement model +
  net-row UI, drop the standalone measurement list, source-agnostic
  `get_measurements`, bidirectional review, relay-only AI section, the migration,
  and the MCP tool changes. Plus the cheap structural export-readiness fields
  (`schemaVersion`, `updatedAt`) since they touch the same persisted shape.
  Ships as its own point release.
- **Phase 2 — device binding.** Resolve the open board → `DeviceRef`, the
  "Set device" picker, `contentHash`. Depends on Phase 1's record shape but is
  otherwise self-contained; ships as a following point release.

Splitting keeps each change reviewable and lets the measurement win land without
waiting on resolver wiring. Each phase gets its own implementation plan from the
writing-plans step.

## Rollout

Feature branch per phase off `main` (currently `v0.31.24`; note the branch base
also carries an unmerged CAD-OOM fix to reconcile at merge time). Build + tsc +
go test + the Playwright specs gate each. Each phase ships as a point release once
verified on the dev NAS container; the live instance self-updates.
