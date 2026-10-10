# Board knowledge layer — review of the "wiki integration" path

Date: 2026-09-29. Prompted by the XZZ issues roadmap (`docs/plans/2026-09-28-xzz-issues-roadmap.md`), whose step 4 would add XZZ-shaped repair tables and a net glossary to the Info tab. The question: is that the right shape, given that the goal is a repair platform, not a better viewer.

## 1. What exists today

There is no wiki integration path in the repo. What exists is:

| Piece | What it is | Per board? | Editable? | Source |
|---|---|---|---|---|
| Tools ▸ Wiki | a disabled "soon" entry (`ToolsPanel.tsx`), never designed anywhere | — | — | — |
| `apple-boards.ts` | static board-number → model table, hand-copied from repair.wiki / logi.wiki | yes | no | wiki, frozen |
| MCP knowledge base | 6 embedded markdown chunks (`mcpserver/kb/`), `kb_search`, resources | **no**, general method | no, ships with the binary | maintainer |
| OpenBoardData | `OBDATA_V002` per-board text: DIAGNOSIS sections with `[n:NET]` / `[p:PART:PIN]` refs, per-net diode / voltage / resistance / alias / comment, per-component attrs. Fetched, cached, rendered by `DiagnosisNotes`, tooltip, Info pane | yes | no | community, ODbL |
| Worklist | per-board user notes and measurements (`WorklistEntry.note`, per-net readings) | yes | yes | user, local |
| XZZ file data | per-pin diode readings, part values, and (after #38) repair tables + net glossary | yes | no | vendor file |
| `diode-readings.ts` | a source-agnostic resolver: XZZ-baked and OBD readings converge on one overlay, one tooltip line, one Info cell, each with provenance | | | |

The last row is the important one. For one field, diode readings, the platform already does what the whole layer should do: several sources, one rendering, provenance shown. Everything else is one source per UI element.

## 2. The XZZ data already fits the OBD model

Every kind of knowledge an XZZ file carries has a slot in `OBDATA_V002`, which is the community's own per-board format, plain text, and licensed for reuse:

| XZZ | OBD slot |
|---|---|
| net glossary `PP_VDD_BOOST = 升压供电` | net `t` comment (or `a` alias when it is a name) |
| net rename table (JSON tail `net[].alias`) | net `a` alias |
| per-pin diode reading | net `d` (OBD is per net; pins on one net agree, conflicts are logged) |
| part value, including Chinese text | component `v` |
| repair table row: symptom / fault point / fix | DIAGNOSIS note, title = symptom, body = fault point + fix with `[p:…]` / `[n:…]` refs |
| loose notes, flowchart text | DIAGNOSIS note under a "Notes" section |

So "import XZZ natively" is not a new store or a new UI. It is an adapter from the parser's output into the shape `DiagnosisNotes`, the pin table and the tooltip already render, plus a source tag. Sean's parser work (`0x06` text records, `annotation-tables.ts`, the glossary) stays as it is; his `AnnotationTables.tsx` is replaced by that adapter.

## 3. Proposed shape: one knowledge layer, four channels

A board's knowledge is a set of **channels**, all in the OBD-derived shape, each tagged with where it came from:

1. **file** — baked into the boardview by the vendor (XZZ today; BRD/BDV nails' readings, TVW notes later). Read-only, produced by the parser, converted in the store.
2. **community** — OpenBoardData, fetched and cached as today. Read-only.
3. **local** — the user's own. Today this is the worklist's notes and measurements; it becomes the editable channel of the same layer, so a technician's "U7000 pin 4 reads 0.3 V on a good board" lands next to the OBD row for that net, not in a separate panel.
4. **wiki** — repair.wiki (and logi.wiki if they ever allow it). Pulled per board page, cached, read-only at first.

One store (`board-knowledge-store.ts`, the generalisation of `diode-readings.ts`) merges the channels per board and answers three questions the UI already asks: notes for this board, everything known about this net, everything known about this part. Rendering does not change per source; a row carries a badge (file / OBD / mine / wiki) and the language mark the translator needs. Where channels disagree on a value, all are shown, as the diode resolver does now.

What this buys:
- **#38 stops being XZZ-specific.** The Chinese repair table renders through `DiagnosisNotes`, whose refs are already clickable chips. Net descriptions render wherever OBD net comments would.
- **Every future source is an adapter**, not a feature: a TVW note block, a BRD nail reading, a wiki section.
- **Contribution has a path.** Local notes are already in the community's format, so "share this board's notes" is an export of the local channel as an `OBDATA_V002` file, or later a push. The reverse, contributing vendor-file content upstream, is a licensing question (XZZ tables are XZZ's text) and stays out until answered.

## 4. The wiki channel, honestly

- **repair.wiki** is a MediaWiki. The pull side is a page fetch per board number, section-parsed, cached under `<dataDir>` like OBD. Whether their API terms permit automated fetching by a self-hosted tool has to be read before building it; the OBD scraper had the same question and got a rate limit and a cache.
- **logi.wiki** has banned MCP access per Alexey. No integration is planned; nothing in the layer depends on it.
- **The MCP `kb_search`** stays what it is, general method knowledge. It gets a fifth input for free: the merged per-board layer becomes readable through the existing `obd_data`-style tool, so the copilot sees file, community and local notes through one call instead of three.

Neither wiki is required for the layer to be worth building. OBD plus file plus local already covers the boards people repair most.

## 5. What changes in the XZZ roadmap

Step 4 of `docs/plans/2026-09-28-xzz-issues-roadmap.md`:
- Cherry-pick the parser commits unchanged. `BoardData.annotations` and `netDescriptions` stay as the parser's raw output; they are format-shaped and that is fine for a parser.
- Do **not** land `AnnotationTables.tsx` or the `pin-net-desc` line as written. Instead: a `xzzKnowledge(board)` adapter producing `DiagnosisSection[]` + per-net entries, a first cut of `board-knowledge-store.ts` merging it with the OBD channel, `DiagnosisNotes` and the pin table reading from the store with a source badge.
- Same effort as Sean's UI, roughly a day, and the result is the platform's first general knowledge surface rather than its third one-off.
- The translation gate stays exactly as written; it applies to every channel that carries prose.

Follow-ups, not this release: the local channel (fold worklist notes into the layer), the export, the wiki pull, TVW/BRD file channels.

## 6. Decisions needed

1. Adopt the OBD-derived shape as the native per-board knowledge model (recommended; it is the community's format and the one the copilot already reads).
2. Rename the Tools ▸ Wiki placeholder to what it will be, **Board notes**, or drop it until the layer has a panel of its own. The Info tab is the surface for this release.
3. Whether the local channel replaces the worklist's note fields or mirrors them. Replacing is cleaner; mirroring is safer for the existing worklist specs.
