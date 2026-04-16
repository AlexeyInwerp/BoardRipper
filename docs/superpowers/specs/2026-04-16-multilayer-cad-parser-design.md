# Multilayer GenCAD Parser

**Date:** 2026-04-16
**Status:** Approved
**File:** `src/frontend/src/parsers/cad-parser.ts`

## Problem

The existing CAD parser handles only `$HEADER`, `$SHAPES`, `$COMPONENTS`, `$DEVICES`, and `$SIGNALS`. Teradyne GenCAM exports (e.g. Avalon7 server boards) include rich multilayer data — routed traces across TOP/INNER/BOTTOM layers, 15K+ vias, 4K+ test pins, power pins, and mounting holes — all of which the parser silently discards.

The renderer and `BoardData` type already support `traces`, `vias`, `layerNames` (used by TVW and Allegro parsers). This work extends the CAD parser to emit the same structures.

## Constraint: backward compatibility

Normal single-layer CAD files (V382, Quanta-style) have no `$ROUTES`, `$TESTPINS`, `$MECH`, or `$POWERPINS` sections. `extractSection()` returns `[]` for missing sections, so all new parsing is additive. The multilayer fields (`traces`, `vias`, `layerNames`) are only set on `BoardData` when data exists. Existing files must produce identical output.

## New sections to parse

### 1. `$TRACKS` — track width table

```
TRACK LD_1 20
TRACK LD_69 14
```

Parse into `Map<string, number>` (name → width in mils). Used to resolve widths for route segments.

### 2. `$ROUTES` — multilayer copper traces + vias

Structure:
```
ROUTE <netName>
  LAYER <TOP|BOTTOM|INNER>
  TRACK <trackName>
  LINE x1 y1 x2 y2
  ARC x1 y1 x2 y2 cx cy
  VIA <padstack> x y <layerSpec> <rotation> <name>
```

**Layer discovery:** Collect unique `LAYER` values in order of first appearance → `layerNames[]` (e.g. `['Top', 'Inner', 'Bottom']`). Map each name to a 0-based index.

**LINE segments:** Direct mapping to `Trace { start, end, width, net, layer }`. Width comes from the active `TRACK` name resolved via the `$TRACKS` table. Net comes from the enclosing `ROUTE`.

**ARC segments:** GenCAD arcs use 6 fields: `ARC x1 y1 x2 y2 cx cy` (start, end, center). Derive start/end angles from center point, determine sweep direction (shorter arc, consistent with GenCAD convention: CCW), tessellate at ~10° steps into `Trace[]` segments. Same pattern as Allegro's `linearizeArc`.

**VIA entries:** `VIA <padstack> <x> <y> <layer> <rot> <name>`. In this file all are `ALL` (through-hole). Padstack name encodes drill diameter (e.g. `PAD_VIA22D12` → drill 12 mils). Parse drill size from padstack name as heuristic; fall back to `$PADSTACKS` drill field if present, else default 10 mils. Emit `Via { position, diameter, net, layers: [] }`.

**Volume:** ~253K lines, ~33K arcs, ~15K vias in the sample file. Single-pass parsing, no lazy loading needed (TVW handles similar volumes).

### 3. `$TESTPINS` — test point nails

```
TESTPIN F377 -925 -8875 U_USB_OC2_N F377 06-A039 85CROWN BOTTOM
```

Format: `TESTPIN <name> <x> <y> <net> <altName> <code> <type> <side>`

Parse into `Nail { position, side, net }`. Side from last field (TOP/BOTTOM). These replace the empty nails array for files that have them.

### 4. `$POWERPINS` — power rail test points

```
POWERPIN P2404 -927.3 -12800.1 P12V_F P2404 -1 85CROWN BOTTOM
```

Same format as TESTPINS. Merge into the same `Nail[]` array — they're physically the same thing (probe points), just categorized differently in the source.

### 5. `$MECH` — mounting holes

```
FHOLE 6282.84 -12253 120
```

Format: `FHOLE <x> <y> <diameter>`. Parse into `Via[]` with empty net and `layers: []` (through-hole mechanical), or into a dedicated mounting-hole array if we add one later. For now, emit as vias with `net: ''` — the renderer draws them the same way.

## Integration into existing parser flow

```
parseCAD(buffer):
  // existing
  shapes     = parseShapes(extractSection('SHAPES'))
  parsedComps = parseComponents(extractSection('COMPONENTS'))
  pinNetMap   = parseSignals(extractSection('SIGNALS'))
  // ... existing shape dedup, recentering, assembly ...

  // NEW — multilayer (all additive, no-ops for empty sections)
  tracks     = parseTracks(extractSection('TRACKS'))
  routes     = parseRoutes(extractSection('ROUTES'), tracks)
  testpins   = parseTestpins(extractSection('TESTPINS'))
  powerpins  = parsePowerpins(extractSection('POWERPINS'))
  mechHoles  = parseMech(extractSection('MECH'))

  // Merge into BoardData
  if routes.traces.length > 0:
    board.traces    = routes.traces
    board.vias      = [...routes.vias, ...mechHoles]
    board.layerNames = routes.layerNames
  if testpins.length > 0 || powerpins.length > 0:
    board.nails = [...board.nails, ...testpins, ...powerpins]
```

## What is NOT shared / extracted

Per analysis: TVW, Allegro, and GenCAD parsers each take completely different inputs (binary structs vs. text tokens) to produce the same `Trace/Via` output types. The shared contract is the `Trace`/`Via`/`layerNames` interfaces in `types.ts`, which already exist. No new shared utility functions — the format-specific parsing logic doesn't meaningfully overlap.

## Test strategy

1. **Existing CAD files must not regress.** Parse V382_10, V382_11, V382_20 → verify identical `BoardData` (no new traces/vias/layerNames fields).
2. **Avalon7 file:** Verify traces > 0, vias > 0, layerNames = 3 entries, nails include testpins + powerpins.
3. Manual visual check: open Avalon7 in the app, verify traces render on butterfly-mode layers.
