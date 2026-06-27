# Worklist hover tooltip (icons) + multi-value net measurements — design

- **Status:** DRAFT — spec only, implementation deferred ("write specs first, continue later").
- **Date:** 2026-06-27
- **Branch context:** `feat/worklist-copy-nets` (worklist copy/import of nets + measurements, plus the hover-tooltip worklist lines, already landed on this branch). This spec covers the next round of changes.

## 1. Motivation / requirements (from review feedback)

1. **Tooltip should use icons, not words.** The canvas hover-tooltip worklist line currently prints mark words (`replaced`, `cleaned`, `short`, …) and a plain measurement label. It should instead show the **same Tabler icons** the panel uses for marks, and an icon for the measurement kind (e.g. `IconCircuitDiode`).
2. **Tooltip should NOT repeat the worklist name.** Only the *active* worklist's data is ever shown, so prefixing every line with `"<worklist name>: "` is redundant. Drop it — show only the data.
3. **A net measurement must hold three values at once.** Today a net entry stores a **single** `measurement` and switching the measurement *type* (V / diode / Ω) replaces the previous reading. It should instead store **up to three independent readings — voltage AND diode AND resistance — simultaneously**, not one-with-a-type-switch.

Already done on the branch (context, not part of this spec's work):
- Diode chip in the panel uses `IconCircuitDiode` (not a text glyph).
- Tooltip worklist lines are plain text (no emoji/colour/bold) — see [[feedback_no_decorative_ui]]. Requirement #1 layers icons back in **as monochrome inline SVG** (icons convey meaning by shape; still no decorative colour).

## 2. Current state

### Data model (`store/worklist-store.ts`)
```ts
interface NetMeasurement {
  kind: 'voltage' | 'diode' | 'resistance';
  value?: string; unit?: string;
  status: 'requested' | 'recorded';
  prompt?: string; expected?: string;
  source: 'agent' | 'user'; at: number;
}
interface NetWorklistEntry {
  netName: string; mark: NetWorklistMark; note: string;
  unresolved?: boolean; surge?: boolean;
  measurement?: NetMeasurement;   // ← SINGLE. Switching kind overwrites it.
}
```
Methods (all single-measurement): `setNetMeasurement(id, net, kind, value, unit?)`, `requestNetMeasurement(net, {kind,prompt,expected})`, `recordNetMeasurement(net, value, unit?)` (fills the lone requested slot — no kind arg), `clearNetMeasurement(id, net)` (deletes the lone measurement).

### Panel (`panels/WorklistPanel.tsx` → `NetMeasurementStrip`)
"Pick a type chip (V / ▷|diode / Ω) → one value input appears → commit sets the single measurement." Switching chips discards the prior reading. `data-testid`s: `net-meas-strip`, `net-meas-chip-{kind}`, `net-meas-value`, `net-meas-recorded`.

### Clipboard (`store/worklist-clipboard.ts`)
`ClipNet.measurement: ClipNetMeas | null`; serialized as `— <Label> <value>` (one reading); parsed by a single `—\s*(Diode|V|Ω)\s+(value)` match.

### Tooltip (`renderer/BoardRenderer.ts`)
Plain DOM spans `.pnt-worklist` (part) + `.pnt-worklist-net` (net). `formatWorklistForPart/Net` return `"<worklist name>: <mark word>, <reading>, <note>"`. Single reading shown as `value unit`.

### MCP / AI (released v0.31.24)
- `store/mcp-bridge.ts` `get_measurements` flattens `netEntries.filter(n => n.measurement != null).map(...)` → **one row per net**.
- Backend `mcpserver/tools_live.go`: `get_measurements` returns `{measurements:[{netName,kind,status,value,unit,expected,source}]}` (a **list**); `request_measurement` requests one `kind`. The bridge result decodes into `map[string]any`, so the **row count per net is not fixed by the Go side**.

## 3. Design

### 3A. Multi-value measurements (the data change — do this first)

**Model:** replace the single field with a per-kind map.
```ts
interface NetWorklistEntry {
  …
  measurements?: Partial<Record<NetMeasurement['kind'], NetMeasurement>>; // up to 3, one per kind
}
```
Map (keyed by kind) over an array because "at most one reading per kind" is the invariant and lookup/replace is O(1).

**Methods:**
- `setNetMeasurement(id, net, kind, value, unit?)` → `e.measurements[kind] = {…}` (leaves the other kinds untouched).
- `requestNetMeasurement(net, {kind, prompt, expected})` → `e.measurements[kind] = {status:'requested', …}`.
- `recordNetMeasurement(net, value, unit?, kind?)` → fill `measurements[kind]`; when `kind` omitted, fall back to the **sole** requested slot (preserves the current AI call-site that doesn't pass a kind). Add the optional `kind` param.
- `clearNetMeasurement(id, net, kind)` → `delete e.measurements[kind]`; drop the whole `measurements` object when it becomes empty.

**Migration (hydration):**
1. Existing persisted `n.measurement` (single) → `n.measurements = { [m.kind]: m }`; `delete n.measurement`.
2. `migrateLegacyMeasurements` currently writes the legacy `w.measurements[]` array into `net.measurement` (single, keeping most-recent) — update it to write into `net.measurements[kind]` (keep most-recent **per kind**).
Both are idempotent and run in the existing hydrate path.

**aiSnapshot / mcp-bridge:** emit **one row per (net, kind)** — iterate `Object.values(e.measurements)`. Output schema per row is unchanged (`netName,kind,status,value,unit,expected,source`), so:
- `store/mcp-bridge.ts`: `flatMap` over each net's measurements instead of the single `.filter(...).map(...)`.
- Backend `tools_live.go`: **no change expected** (list contract already). Verify `mcpserver_test.go` + `go test ./mcpserver/`.
- `request_measurement` (single kind) is unchanged.

### 3B. Panel strip — three independent slots

Replace the pick-a-type flow with **three always-visible compact slots**, one per kind, each with its own value field:
```
[V  __ ] [▷| __ ] [Ω  __ ]
```
- Each slot: kind label (`IconCircuitDiode` for diode, `V` / `Ω` text) + a small input pre-filled with the recorded value (editable) + a tiny clear (`×`) when set.
- Commit (blur/Enter) on a slot → `setNetMeasurement(id, net, kind, value)`; empty + commit on an existing one → clear.
- Agent-requested kind: highlight that slot + use `expected` as the input placeholder; user typing there routes through `recordNetMeasurement(net, value, undefined, kind)`.
- Keep `data-testid`s `net-meas-chip-{kind}` on the kind labels and add `net-meas-input-{kind}` per slot so tests can target each independently.

### 3C. Tooltip — icons, no name (requirement #1 + #2)

The tooltip is plain DOM (`BoardRenderer`), so Tabler React icons must be inlined as **static SVG strings**. New module `renderer/worklist-tooltip-icons.ts`:
```ts
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { IconReplace, IconSparkles, IconAlertTriangle, IconCheck, IconUnlink, IconDroplet, IconBolt, IconCircuitDiode } from '@tabler/icons-react';
import { IconSolderingIron } from '../icons/IconSolderingIron';
// renderToStaticMarkup(createElement(Icon, {size:13, stroke:2})) → cached Record<mark|kind, svgString>
```
Reuses the *exact* icon components already in the panel (`MARK_ICON`/`NET_MARK_ICON`) so panel and tooltip never drift. SVGs are monochrome (`currentColor`, inherit the muted tooltip text colour — no decorative colour). The spans switch from `textContent` to `innerHTML`; **the note text MUST be HTML-escaped** (board files / user notes are untrusted) — add a tiny `escapeHtml`.

- Part line: `<mark-icon> [<water-icon>] <escaped note>` — no worklist name, no mark word.
- Net line: `<mark-icon> [<surge-icon>] <V-icon value · diode-icon value · Ω-icon value> [<escaped note>]` — all recorded readings, each prefixed by its kind icon, separated by `·`.
- A net/part pinned with nothing recorded shows just the mark icon (or, if no mark either, is omitted — there's nothing to say without the name).

**Trade-off / decision:** `react-dom/server` adds weight to the renderer chunk. Acceptable for reusing the real icons. Alternative if the bundle cost is unwanted: a hand-maintained `Record<mark, rawSvgPath>` (rejected — duplicates icon data, drifts, and conflicts with "use existing icons"). **Decision pending §5.**

### 3D. Clipboard (round-trippable)

`ClipNet.measurement` → `measurements: ClipNetMeas[]` (0–3). Serialize all readings inside the `—` segment, comma-joined:
```
PP3V3_S5 [short] surge — V 0.81, Diode 0.42, Ω 12 (short to GND)
```
"Diode/V/Ω" stay **words** in clipboard (parser- and human-readable — unaffected by the panel/tooltip icon change). Parse: split the `—`-segment on commas, match each `<Label> <value>`. Update `worklist-clipboard.spec.ts` round-trip fixtures to carry 2–3 readings.

## 4. Blast radius (files to change)

| File | Change |
|---|---|
| `store/worklist-store.ts` | model `measurement`→`measurements` map; 4 methods; 2 migration paths; `aiSnapshot`; `toClip`; `importFromText` |
| `store/worklist-clipboard.ts` | `ClipNet.measurements[]`; format (comma-join); parse (split) |
| `panels/WorklistPanel.tsx` | `NetMeasurementStrip` → 3 independent slots; testids |
| `renderer/BoardRenderer.ts` | tooltip: icons (innerHTML+escape), drop name, all readings |
| `renderer/worklist-tooltip-icons.ts` (NEW) | `renderToStaticMarkup` icon-string map |
| `store/mcp-bridge.ts` | `get_measurements`: 1→N rows per net |
| `backend/mcpserver/tools_live.go` | verify only (list contract); run `go test ./mcpserver/` |
| `tests/worklist-clipboard.spec.ts` | multi-reading round-trip |
| `tests/worklist-measurements.spec.ts` | per-slot record/clear; tooltip-icon DOM probe |

## 5. Decisions to confirm before implementing

1. **Strip layout** — three always-visible slots (this spec) vs. keep a compact "add reading" affordance that expands? Always-visible is clearer for "3 at once" but wider.
2. **Clipboard multi-reading format** — `— V 0.81, Diode 0.42, Ω 12` acceptable? (round-trip-safe).
3. **Tooltip icons via `react-dom/server`** — OK to add that dep to the renderer chunk, or prefer a lighter approach?
4. **V / Ω in the tooltip & strip** — keep as text letters, or find/commission icons too? (Tabler has no clean plain "Ω"/"V" measurement icon; text is probably best.)
5. **Reading order** in tooltip/clipboard — fixed `V, diode, Ω`?

## 6. Non-goals
- No change to part-entry measurements (parts don't carry readings).
- No change to `request_measurement` (still one kind per request; the agent simply makes up to three requests).
- OBD tooltip line stays a separate, independent pipeline (may be removed later) — the worklist net readings never depend on it.

## 7. Test plan
- Unit (tsx/Playwright pure): clipboard round-trip with 0/1/2/3 readings + legacy single-reading import.
- Store: `setNetMeasurement` three kinds coexist; `clear` one leaves the others; migration of a persisted single `measurement`; `aiSnapshot` emits N rows.
- Panel (BRD fixture): record V+diode+Ω on one net row independently; clear one; diode label is the icon.
- Tooltip DOM probe: `.pnt-worklist*` spans contain mark `<svg>` + reading icons, no worklist name. (Hover trigger itself is not headless-testable — WebGL.)
- Backend: `go test ./mcpserver/` green; get_measurements returns ≥1 row per multi-reading net.
