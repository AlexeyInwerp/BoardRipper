# Worklist unification — per-net measurements (single surface)

**Date:** 2026-06-23
**Status:** Design approved, pre-implementation
**Supersedes the UI split introduced by:** `docs/specs/2026-06-16-worklist-ai-mode-feedback-loop-design.md` (the data/loop semantics from that spec stay; only the separate measurement surface is folded in)

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
  unit, expected) read off net entries; optional `status` filter maps to
  `requested|recorded`.
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

Backend: `go test ./mcpserver/` covering `request_measurement` net vs part/pin
routing and `get_measurements` shape.

## Rollout

Single feature branch off `main` (currently `v0.31.24`). Build + tsc + go test +
the Playwright specs gate it. Ships as the next point release once verified on
the dev NAS container; the live instance self-updates.
