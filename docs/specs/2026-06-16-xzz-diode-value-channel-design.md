# Diode-Value On-Pin Channel (XZZ baked + OpenBoardData) — Design

**Date:** 2026-06-16
**Status:** Draft (awaiting review)
**Scope:** Full end-to-end — parse, expose, draw-on-pin, dedicated reference UI.
**Shape:** **One visual target (on-pin diode display) fed by two independent
sources** — XZZ baked `.pcb` values and OpenBoardData (OBD).

---

## 1. Background & Discovery

XZZ ships paired `.pcb` files per board. Alongside the normal boardview
(`… BB PCB layer-820-03078-09.pcb`) there is a companion
(`… Middle layer diode value-820-03078-09.pcb`) carrying the reference
("golden board") **diode-mode multimeter readings** a tech compares against.

The filename ("Middle layer") is misleading — the values are **not** a geometry
layer. The companion parses today as an ordinary XZZ board (96 components, 2084
pads); it just never surfaces the readings. Full trace of where the data is (and
is not) on `820-03078-09`:

| Source | Content | Diode values? |
|--------|---------|---------------|
| Layer 29 (2066 tiny 7.9-mil full circles) | pad / test-point markers | no |
| Layer 17 (lines + arcs) | mechanical outline (board shape, screw holes) | no |
| Net dictionary | single dummy `Net1` | no |
| Part / pin blocks (DES) | pad geometry; **real pad number present but discarded by parser** | no |
| **Trailing section after `v6v6555v6v6===` marker (~23 KB)** | **newline-delimited reading table** | **YES** |

### The XZZ reading table

Plaintext (never XOR'd — it lives past the XOR boundary marker; never DES'd).
After the `v6v6555v6v6===` marker and a 4-byte binary header:

```
=359=N47(21)
=0=N47(31)
=OL=N46(1)
=732=N47(7)
```

Grammar: `=<value>=<partName>(<pinNumber>)`, **one record per pin**.

Observed on `820-03078-09` (2084 records — exactly one per pad):

| Value class | Count | Meaning |
|-------------|-------|---------|
| `0` | 1488 | no reading / tied to ground |
| numeric (1–1772) | 386 | diode-mode reading in **millivolts** |
| `OL` | 209 | open line (infinite) |
| `312.` (malformed) | 1 | tolerate: best-effort numeric → recovered as `value` 312 |

Totals: `none` 1488 + `open` 209 + numeric 386 + recovered 1 = **2084**. After
recovery, the `value` class is **387**. Join key `PART(PIN)` matches the parsed
pins **2084 / 2084** once the parser preserves the real pad number. Validated
end-to-end during discovery (values rendered on pins).

### Detection signal (XZZ)

The companion has the `v6v6555v6v6===` marker followed by ≥1 `=v=PART(pin)`
record. The normal board has **no marker and zero records**. Detection: marker
present **and** ≥1 parsed record.

### Second source — OpenBoardData (OBD)

OBD readings already exist in the app, **per net** (not per pin):
`ObdNet { diode: string|null; voltage; resistance; aliases[] }`, fetched async
into `obdStore` and exposed via `obdNetIndex(boardNumber): Map<netName, ObdNet[]>`.
OBD diode strings are **volts** (e.g. `"0.450"` = 450 mV; also `"OL"`). They are
already surfaced in the canvas tooltip (`BoardRenderer.formatObdForNet`) and in
ComponentInfo (`ObdCell`, via `pin.net`).

The two sources therefore converge on a pin as:
`reading(pin) = XZZ(part, pinNumber)  and/or  OBD(pin.net)`.

---

## 2. Goals / Non-goals

**Goals**
- Parse the XZZ diode table; attach a per-pin reading to every matching pin.
- Define a **source-agnostic diode reading model** and a **resolver** that
  yields a pin's reading(s) from either/both sources.
- Render readings **directly on pins** via a new, toggleable in-canvas overlay
  layer, sourced from the resolver (so XZZ and OBD both light it up), shown only
  when the board has diode data from at least one source.
- Unify the tooltip and ComponentInfo so both sources display together.
- Provide a dedicated **"Diode reference" panel/section**, source-tagged.

**Non-goals**
- No change to the OBD backend (`src/backend/obd/`) or the OpenBoardData
  corpus/DIAGNOSIS pipeline. OBD is consumed **as a read source** through the
  existing `obdNetIndex`; XZZ values are **not** written into the OBD corpus.
- No OCR / geometry-glyph extraction (data is structured text).
- No editing/contribution of readings.
- No new file format — additive to the XZZ parser.

---

## 3. Data model (`src/frontend/src/parsers/types.ts`)

```ts
export type DiodeSource = 'xzz-pcb' | 'obd';

export interface DiodeReading {
  /** Original token: "359" (XZZ mV), "0.450" (OBD V), "OL", "0". */
  raw: string;
  /** value = a real reading; open = OL; none = 0 / no reading. */
  kind: 'value' | 'open' | 'none';
  /** Normalized millivolts when parseable (XZZ int; OBD volts×1000); else null. */
  mv: number | null;
  source: DiodeSource;
}

export interface Pin {
  // … existing fields …
  /** XZZ-baked per-pin reading. Present only on XZZ `.pcb` companions. The OBD
   *  source is resolved separately (per net) and is NOT stored here. */
  diode?: DiodeReading;
}

export interface DiodeReferenceChannel {     // XZZ-source descriptor on BoardData
  source: 'xzz-pcb';
  units: 'mV';
  counts: { value: number; open: number; none: number };
  matched: number;
  unmatched: number;
}

export interface BoardData {
  // … existing fields …
  /** Present ⇒ this board ships XZZ-baked diode readings. Gates the XZZ source.
   *  (The OBD source is gated independently by an OBD match existing.) */
  diodeReference?: DiodeReferenceChannel;
}
```

`Pin.diode` carries the static XZZ source for the render/tooltip hot path. The
OBD source stays where it already lives (`obdStore` / `obdNetIndex`) and is
resolved per net at display time — it is async and must not be frozen into
`BoardData`/the scene.

---

## 4. The resolver (new — `src/frontend/src/store/diode-readings.ts`)

A single source-agnostic accessor used by every visual target:

```ts
// Normalize an OBD diode string ("0.450" V, "OL", "") → DiodeReading|null.
function normalizeObdDiode(raw: string): DiodeReading | null;

// All readings available for a pin, across sources (0, 1, or 2 entries).
export function resolveDiodeReadings(
  pin: Pin, boardNumber: string | undefined,
): DiodeReading[];           // XZZ (pin.diode) + OBD (obdNetIndex.get(pin.net))

// The single reading to draw on the pin label, applying precedence.
export function primaryDiodeReading(
  pin: Pin, boardNumber: string | undefined,
): DiodeReading | undefined;
```

- **Unit normalization:** XZZ `mv = parseInt(raw)`; OBD `mv = round(parseFloat(raw)*1000)`.
  `OL`→`open`, `0`/`0.000`→`none`, else `value`. `raw` kept for display.
- **Precedence (when both exist):** XZZ baked is per-pin and authoritative →
  **primary**; OBD is shown as a cross-reference. (Decision D2.)
- **Display unit:** volts, 3 decimals (`0.359 V`), consistent across sources;
  `OL` shown literally; `none` not drawn. (Decision D1.)

---

## 5. Parser changes (`src/frontend/src/parsers/xzz-parser.ts`)

1. **Preserve the real pad number.** Final pin map (≈ line 1492) hard-codes
   `name: '', number: String(i + 1)`, discarding parsed `p.name` (the join key).
   Change to `number: p.name || String(i + 1)`. (Probe map ≈ line 1347 is
   mirror-detection only — leave it.)
2. **`parseDiodeSection(raw): Map<string, DiodeReading>`** — find the
   `v6v6555v6v6===` marker; regex `=([^=\n]*)=([A-Za-z0-9_]+)\((\d+)\)`; classify
   each value (`OL`→open, `0`→none, numeric→value, `312.`→best-effort), tag
   `source:'xzz-pcb'`, key `` `${part}(${pin})` ``.
3. **Join + channel.** Stamp `pin.diode` by `` `${part.name}(${pin.number})` ``;
   tally; set `BoardData.diodeReference` only when ≥1 record. Log matched/
   unmatched via `log.parser`.
4. **Cache bust.** Bump `PARSER_VERSION` in `store/board-cache.ts` (72 → 73).
5. **Doc.** Add a "Diode value channel" section to `docs/formats/XZZ_FORMAT.md`.

---

## 6. Rendering — new toggleable on-pin overlay layer

The on-pin labels must reflect **both** the static XZZ source and the **async**
OBD source, so the layer is a **reactive layer owned by `BoardRenderer`** (like
net highlight / the OBD tooltip), **not** baked into the pure `buildBoardScene`.

`src/frontend/src/renderer/BoardRenderer.ts` (+ a helper in `board-scene.ts` for
BitmapText construction)
- New diode-label container, mounted as a `netDimGfx` sibling so existing dim/
  highlight blending applies (per CLAUDE.md overlay-slot note).
- For every pin, call `primaryDiodeReading(pin, bn)`; draw BitmapText (value in
  V, or `OL`) when `kind !== 'none'`. Reuse the shared glyph atlas — no per-label
  canvas Text.
- Colour by **source** (XZZ vs OBD) and class (open = warning), respecting theme
  accent rather than hardcoded pairs.
- Rebuild the container on: board load, `obdStore` change (so OBD readings pop in
  when fetched), and the toggle. Progressive zoom-visibility like existing label
  font-size groups so dense boards don't overdraw.

`src/frontend/src/store/overlay-layout.ts` + `components/overlay/slots/` +
`store/render-settings.ts`
- Add overlay slot id `diodeValues` (to `OverlaySlotId`, `KNOWN_SLOT_IDS`,
  `DEFAULT_OVERLAY_LAYOUT` `visible:true`) and `DiodeValuesButton.tsx`.
- **Conditional mount:** slot shows only when the board has diode data from
  **either** source (`board.diodeReference` set **or** an OBD match with any
  diode reading exists). Layout reconciliation already auto-appends new ids.
- Backing boolean in `render-settings.ts`.

---

## 7. UI surfacing (unified, source-tagged)

- **Canvas tooltip:** extend `BoardRenderer.formatObdForNet` (or add a sibling)
  so the diode line merges sources — e.g. `Diode: 0.359 V (board) · 0.45 V (OBD)`
  when both, single when one. Pin-level XZZ comes from `pin.diode`; net-level OBD
  from `obdNetIndex`.
- **ComponentInfo** (`components/ComponentInfoBody.tsx` **and** the duplicate in
  `BoardSidebar` InfoTab): extend the existing `ObdCell` (or add a Diode column)
  to show XZZ-baked alongside OBD per pin.
- **Dedicated "Diode reference" panel/section:** readings grouped by component,
  each row tagged with its source(s), shown when **either** source has data. This
  is the home of the channel; it reads OBD live and XZZ from `pin.diode`.

---

## 8. Edge cases

- `OL`→`open` (`mv:null`); `0`/`0.000`→`none` (hidden); malformed `312.`→strip
  trailing punctuation, best-effort numeric, else skip (counted unmatched).
- XZZ record with no matching pin → counted `unmatched`, logged once; never throws.
- Pin with no reading from any source → nothing drawn (normal case).
- Both sources disagree → both shown in tooltip/panel; on-pin shows primary (XZZ).
- OBD arrives after board load → reactive rebuild lights the labels up.
- OBD diode that isn't volts-parseable → `value` with `mv:null`, raw displayed.

---

## 9. Testing

- **XZZ parser unit test** (Vitest) on the real fixture: marker found, 2084
  records, histogram `{value:387, open:209, none:1488}`, `matched===2084 /
  unmatched===0`. Assert the BB-PCB companion yields **no** `diodeReference`.
- **Resolver unit test:** `normalizeObdDiode("0.450")→{kind:'value',mv:450}`,
  `"OL"→open`, `"0.000"→none`; `resolveDiodeReadings` returns both sources;
  precedence picks XZZ.
- **Playwright** (geometry proof, per project rule — assert boundingBox): open the
  XZZ fixture → `diodeValues` slot appears → toggle → on-pin labels positioned
  near pins; slot absent for a board with neither source.
- Fixtures: copy the two `820-03078-09` `.pcb` files into `samples/` (local-only).

---

## 10. Decisions (override in review)

- **D1 — display unit:** volts, 3 decimals, unified across sources. Alt: native
  per source (mV for XZZ, V for OBD).
- **D2 — precedence when both exist:** XZZ primary on-pin; OBD cross-reference in
  tooltip/panel. Alt: a source selector in the overlay toggle.
- **D3 — colour:** distinct hue per source so a glance shows provenance.

---

## 11. Out of scope / future

- Other formats carrying equivalent per-pin readings (model is generic; XZZ + OBD
  wired now).
- Per-net aggregation / measurement tooling built on readings.
- Writing XZZ readings into the OBD corpus / upstream contribution.

---

## 12. Implementation notes

- Branch `feature/xzz-diode-value-channel` (off `main`; current default branch is
  unrelated MCP work).
- Commit at milestones: (1) types + parser + cache bump, (2) resolver, (3) render
  overlay + slot, (4) tooltip/info + reference panel, (5) tests + format doc.
