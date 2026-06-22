# Worklist AI Mode — Agent Feedback Loop (Design)

**Date:** 2026-06-16
**Depends on:** MCP server + live-board bridge (shipped v0.31.23).
**North star (not this increment):** the completed AI-mode worklist is a structured *solution* that later gets published to an open DB and re-consumed by other users + MCP agents (ties into the parked `feature/online-boards-db` contrib branch + OBD). This spec builds the loop that *produces* that data.

## 1. Goal

Turn the one-way "agent drives the board" into a **two-way loop** on the existing
worklist: the external Claude Code agent writes structured output into the worklist
(entries, marks, notes, a measurement request, a message), and the user feeds data
back (marks done, types measured values, types a relay prompt) which the agent reads
on its next turn. **No LLM in BoardRipper** — the agent is the external session; the
worklist is the shared scratchpad.

The worklist already *is* the solution artifact: per-board, part entries (refdes +
repair mark `replaced/reworked/cleaned` + note), net entries (net + mark
`short/solved/absent` + note), a ticket note, and a text serializer
(`worklist-store.ts`). We augment it, not fork it.

## 2. Architecture

```
        ┌──────────── AI-mode Worklist (per board, shared) ────────────┐
 agent  │ writes: entries, marks, notes, measurement REQUESTS, messages │
  ─────▶│ reads:  measurement RESULTS, done/mark state, user PROMPTS     │◀── user
        └───────────────────────────────────────────────────────────────┘
   (all over the existing /api/mcp + WS bridge; writes gated by mcp_drive_ui)
```

No protocol change: agent→worklist is more bridge ops; worklist→agent is the agent
reading via tools (async, JetBrains-style request→fetch). AI mode is a **toggle on the
existing `WorklistPanel`**, auto-available when MCP is connected — same rows, plus a
measurement column, the agent's messages, and a prompt box.

## 3. Data model (`worklist-store.ts` additions)

Keep existing `WorklistEntry`/`NetWorklistEntry`/`Worklist`. Add to `Worklist`:

```ts
interface MeasurementEntry {
  id: string;
  target: string;                 // "D4200" | "PPBUS_AON" | "U7000.12"
  kind: 'diode' | 'voltage' | 'resistance' | 'continuity' | 'other';
  prompt: string;                 // what the agent asked ("Vf in-circuit, black→GND")
  expected?: string;              // agent's spec/expected value
  value?: string;                 // user-entered result
  unit?: string;                  // V | Ω | mV …
  status: 'pending' | 'answered' | 'skipped';
  source: 'agent' | 'user';       // who created the row
  requestedAt: number;
  answeredAt?: number;
}
interface WorklistMessage { id: string; role: 'agent' | 'user'; text: string; at: number; }

// on Worklist:
measurements?: MeasurementEntry[];
messages?: WorklistMessage[];
aiOrigin?: Record<string, true>;  // entry/net keys the agent added (for the AI badge)
```

New store methods (mirroring existing `setNote`/`addEntry` patterns, ≤4000-char clamps,
`useSyncExternalStore` stable snapshots): `addMeasurement`, `answerMeasurement(id,value,unit?)`,
`skipMeasurement(id)`, `addMessage(role,text)`, plus the agent-write helpers reuse the
existing `addEntry`/`addNetEntry`/`setMark`/`setNote`. Everything persists per board like
today and extends the text serializer (measurements + messages appended).

## 4. MCP tools (new, over the bridge)

Read (always allowed):
| tool | returns |
|------|---------|
| `worklist_get(session?)` | full worklist: entries (refdes/mark/note/ai), netEntries, note, measurements, messages, counts |
| `get_measurements(status?, session?)` | measurement rows (filter by pending/answered) |
| `get_user_messages(since?, session?)` | user-typed relay messages since a marker |

Write (gated per-call on `mcp_drive_ui`, toast + `log.mcp` each):
| tool | effect |
|------|--------|
| `worklist_add(kind: part\|net, id, mark?, note?)` | add/update an entry; tagged `aiOrigin` |
| `worklist_update(kind, id, mark?, note?)` | set mark/note on an entry |
| `worklist_set_list_note(note)` | set the ticket/diagnosis note |
| `request_measurement(target, kind, prompt, expected?)` | add a pending measurement row; returns its `id` |
| `post_message(text)` | agent posts a message into the panel transcript |

**Note/message text accepts the clickable-chip syntax** already used by OBD diagnosis
(`[n:NET]` → highlight on click, `[p:REFDES]` / `[p:REFDES:PIN]` → select on click). The
agent is instructed to reference components/nets with these markers so its answer is
actionable in the tab. (`components/DiagnosisNotes.tsx` already parses + renders them.)

Optional follow-on (deferred): `await_measurement(id, timeout)` — bridge holds the call
open until the user answers/timeout, for a tighter loop. v1 uses async `get_measurements`.

Backend (`mcpserver/tools_live.go`): arg structs + register as live tools (reads `nil` gate,
writes `gate=DriveUI`). Frontend (`mcp-bridge.ts`): dispatch handlers calling the store.

## 5. UI (`WorklistPanel.tsx`)

- **AI-mode toggle** in the panel header, auto-on when `/api/mcp/status` reports connected; off
  hides the AI affordances and the panel is exactly today's worklist.
- **Agent-added rows** carry a small AI badge (reuse `IconSparkles`) so the user distinguishes
  agent proposals from their own entries.
- **Measurement rows** (new section): pending ones highlighted with an inline input (value +
  unit) and a ✓ to answer / ✕ to skip; answered ones show the value. Answering flips status →
  the agent reads it next turn.
- **Prompt box** (small, bottom): user types → `addMessage('user', …)`; the transcript shows
  agent + user messages inline. This is the relay — the agent reads via `get_user_messages`.
- Agent writes surface the existing info-toast ("Agent added U7000 to the worklist", "Agent
  requested a measurement on D4200").

Reuse existing worklist row CSS / mark components; new CSS kept minimal (measurement row +
prompt box), following `index.css` conventions.

### 5a. Answer presentation — compressed in the tab, full in the chat

The agent's answer has two homes, by design:
- **In the AI worklist tab (canonical + actionable):** the *structured, compressed* form —
  worklist entries (each row already click-selects/highlights its part/net on the board), a
  short diagnosis in the ticket note, and the measurement requests. Notes/messages render
  through the existing `DiagnosisNotes` renderer so every `[n:NET]`/`[p:REFDES:PIN]` is a
  **clickable chip** (→ highlight/select on the board). This is what the user reads and acts on.
- **In the Claude Code chat (the agent "behind"):** the full prose reasoning. The agent writes
  the long form there and a compressed, chip-annotated summary into the worklist.

So "what prevails" in the tab is the **worklist + clickable chips**, not a wall of text — the
tab stays a do-this surface, the chat holds the why. The skill instructs the agent accordingly:
"answer in the chat in full; mirror the actionable result into the worklist as entries +
measurement requests + a brief chip-annotated note."

## 6. Skill update (`boardripper-repair-helper`)

Add a **guided-repair playbook**: after locating/diagnosing, the agent builds the worklist
(`worklist_add` the suspect parts/nets with notes), `request_measurement` for the readings it
needs, then on the next turn `get_measurements` + `get_user_messages`, reasons over the values,
updates marks/notes, and converges on a solution in the ticket note. Find-by-function offers to
add the found part to the worklist. Conventions: only write to the worklist in AI mode + with
drive-UI on; never fabricate a measured value; cite evidence in notes.

## 7. Safety / gating

- Worklist **reads** allowed whenever MCP enabled; **writes** gated on `mcp_drive_ui` (they
  mutate the user's worklist), same as other drive-UI tools. Toast + `log.mcp` on every write.
- Per-board scoping unchanged; agent writes target the active board's worklist (or `session`).
- All agent worklist actions are reversible by the user (it's their worklist; marks/notes/rows
  are editable/removable as today).

## 8. Verification

- Go: arg structs compile; live tools registered; gate honoured (writes refused when drive-UI off).
- Bridge/Playwright on a real board: enable AI mode; simulate agent ops over the bridge —
  `worklist_add` → row appears with AI badge; `request_measurement` → pending row; user enters a
  value → `get_measurements` returns it; user prompt → `get_user_messages` returns it. Assert
  store state + row geometry (not bare visibility).
- Skill behavioural: a real Claude session builds a worklist + requests a measurement on 820-02100.

## 9. Out of scope (next increments)

- **Publish-to-open-DB** (the north star): serialize the solution → OBD-compatible record →
  contrib backend → expose back via `obd_*`. Large; its own spec; pulls in `feature/online-boards-db`.
- **In-app LLM chat** (Sub-project B) — the relay covers the loop without it.
- `await_measurement` long-poll; multi-user worklists.
