# MCP Interface Expansion — Visual/Text/Download Access, Prompting Harness, Knowledge Base

**Status:** Design (approved for spec write)
**Date:** 2026-07-09
**Extends:** `docs/specs/2026-06-15-mcp-server-live-board-bridge-design.md` (the base MCP server + live-board bridge)
**Scope:** three phased layers on top of the existing MCP server. Each phase is independently shippable and gets its own implementation plan.

## 1. Motivation

Today the MCP server lets a connected model read the board's netlist/parts, drive the UI, run library-wide PDF text search, and cooperate on the worklist. Three gaps block a model from actually *understanding and repairing* a board the way a technician does:

1. **No eyes.** The model cannot see the board or the schematic — only text. It cannot read a schematic that has no machine-readable text layer, and cannot visually correlate a part on the board with its symbol on the schematic.
2. **Open-PDF blindness.** The model cannot tell which PDF the user has open, cannot get that PDF's page text or search it as a document, and cannot pull the PDF down to read it natively.
3. **No priming or reusable knowledge.** Every session starts cold. There is no technician persona, no step-by-step method, and no reference knowledge the model can pull on demand — so it re-derives method every time and burns context.

This design closes all three, centered on the **active browser session** (MCP here is used live, alongside an open board/schematic), while keeping library-wide search and retrieval available with no session open.

## 2. Goals

- Give the model **visual** access to both the boardview and the schematic.
- Give the model **textual** access to the open PDF (page text + search) and to the **whole indexed PDF library** (existing FTS).
- Let the model **download** a PDF (the open one, or any library file) to read it natively.
- **Prime** the model at connect as a repair technician, and offer **invokable step-by-step prompt workflows**.
- Provide an **on-demand knowledge base** (reference chunks) so the model pulls relevant method/heuristics instead of carrying them in every handshake.

## 3. Non-goals

- **Backend/headless PDF rasterization.** Rendering is browser-only (see §5.1 rationale). The `klippa/go-pdfium` render API is available but intentionally unused here.
- **A self-growing knowledge base.** Distilling solved worklist cases into new KB chunks is deferred (§9).
- Changing the existing auth/handshake, worklist, or drive-UI trust model.

## 4. Current state (baseline)

- **Transport:** Streamable HTTP at `/api/mcp` behind `GateAuto` (`main.go:423`). Bridge WebSocket at `/api/mcp/bridge`.
- **Auth:** 404 when disabled. Static per-install bearer secret (`.mcp-secret`, constant-time compare) by default; optional OAuth 2.1 mode with discovery/DCR/PKCE.
- **Handshake:** SDK `initialize` returns `Implementation{boardripper,1}`, **tools** capability, and `Instructions: boardripperInstructions`. Only the Tools primitive is used today — **Prompts and Resources are unused** and are the natural homes for Phases 2 and 3.
- **Live bridge:** browser answers live tools from in-memory `BoardData` / `pdfStore`. `PdfDocument` already retains `doc` (pdf.js proxy), `originalBuffer` (raw bytes), `textPages` (per-page text), and `fileId` (library linkage); `openPdfEntries()` lists all open PDFs. **The active-session plane needs almost no new state — it reads what is already in memory.**

**Design principle carried throughout:** `Instructions` is sent on every connect, so it must stay lean (persona + tool map). Detailed knowledge is pulled on demand via Resources / `kb_search`, never dumped into the handshake.

---

## 5. Phase 1 — Access (visual / text / download)

Two planes, each tool single-purpose.

### 5.1 Plane A — Active session (browser bridge)

New ops in `src/frontend/src/store/mcp-bridge.ts`, registered as `liveTool`s in `tools_live.go`. All read the browser's in-memory state.

| Tool | Args | Source | Returns |
|---|---|---|---|
| `board_overview` | `session?` | one-call orientation, all browser-known state (see §12.1) | `{session, board:{name,boardNumber?,parts,nets,side,generation}, pdfs:[…], worklist:{…}}` |
| `board_snapshot` | `session?`, `fit?` (`view`\|`board`, default `view`), `around?` (refdes\|bbox — crop, see §12.3) | PixiJS `renderer.extract` of the active board canvas | MCP **image** content (PNG) + `{session, w, h}` |
| `pdf_page_image` | `page?` (default current), `session?`, `scale?`, `region?` (bbox — sub-rectangle, see §12.3) | pdf.js `getPage(n).render()` → offscreen canvas → PNG; honors rotation/mirror | MCP **image** content (PNG) + `{page, w, h}` |
| `pdf_page_text` | `page?` (default current; omit-all = whole doc, capped), `session?` | `PdfDocument.textPages` (already cached; no re-extract) | `{page, text}` or `{pages:[{page,text}]}` |
| `pdf_search_open` | `query`, `session?`, `limit?` | substring/token search over in-memory `textPages` (instant; works for dropped files). *Named to not collide with library-wide `pdf_search` — see §12.4* | `{matches:[{page, snippet}], total}` |
| `pdf_download` | `session?` | the open doc's `originalBuffer` | MCP **resource/blob** (application/pdf) + `{name, size}` |

Descriptor change (fixes the open-PDF exposure gap): `boardDescriptor()` gains `pdfs: [{name, page, pageCount, fileId?}]` sourced from `openPdfEntries()` + current page. Reported in `board_active`, `board_sessions`, and the richer `board_overview` (§12.1). This is what lets the model (a) know which schematic is on screen and (b) hand its `fileId` to Plane B.

**Why browser-only rendering:** MCP here is used with a live session; the board is *only* rendered client-side (PixiJS — the backend has no board renderer at all), and the browser already holds the PDF's pixels, bytes, and text. Browser capture reflects exactly what the user sees (side, zoom, highlight, rotation, mirror, clean-mode) and covers drag-dropped files that never reach the server. A backend renderer would duplicate the pipeline, miss the user's view state, and only work for library files.

New frontend helpers (the only genuinely new surface):
- `boardStore.snapshotActiveCanvas(fit): Promise<Blob>` — PixiJS v8 `app.renderer.extract` on the active tab's stage/canvas, capped to longest side ≤ ~2000px.
- a small pdf.js render-to-PNG helper in/near `pdf-store.ts` reusing the loaded proxy + the doc's rotation/mirror.

### 5.2 Plane B — Library (backend native)

In `tools_native.go`. Work with no session open.

| Tool | Change | Returns |
|---|---|---|
| `pdf_search` | *keep + enhance*: existing library-wide FTS5 search; add optional `file_id` to scope to one indexed doc (wires the already-supported `restrictTo`) | `{hits:[{file_id, page, snippet}], total}` |
| `file_download` | *new*: read any library file by `file_id` (eager read, path-sandboxed to library root, size-capped) | MCP **resource/blob** + `{filename, mime, size}` |

`file_download` makes a `pdf_search` hit actionable (find → pull → read natively). It also serves the open doc when that doc is library-linked (via the descriptor's `fileId`).

### 5.3 How the planes connect

`pdf_search` → `file_id` → `file_download(file_id)` to read the PDF, **or** `pdf_goto`/ask the user to open it, after which Plane A gives the live view. The descriptor's `fileId` ties an open doc back to its library entry so both planes address the same file.

### 5.4 Interfaces / isolation

- Keep the backend byte path in one place: a new `Deps` member `FileBytes(ctx, id) ([]byte, name, mime string, err error)` that owns file-id→path resolution + the cloud-aware eager read (`serveFileEager` semantics: truncation/deadline/`EDEADLK` → surfaced as tool errors, not corrupt bytes). `file_download` composes it; nothing else in the SQLite stores changes.
- Browser tools read existing stores; new surface limited to the two helpers in §5.1.

### 5.5 MCP content-block mapping (build-time verification item)

Image tools return `mcp.ImageContent{Data, MIMEType}`; download tools return an embedded resource/blob with base64 data + MIME. Structured `TOut` carries the metadata (`{page,w,h}` / `{filename,mime,size}`). **First implementation step verifies the exact go-sdk content types** (`mcp.ImageContent`, embedded-resource shape) so Claude Code surfaces images as vision and PDFs as documents. If the SDK requires a specific wrapper, adjust the return shape — this is a wiring detail, not a design change.

### 5.6 Safety / limits

- Images capped (longest side ≤ ~2000px, PNG).
- `pdf_download` / `file_download` hard-capped by a config value (default 50 MB); over cap → tool error pointing at `pdf_page_image`/`pdf_page_text`.
- `file_download` path-sandboxed to the library root; cloud-placeholder 503 semantics preserved.
- No new drive-UI gating: all Phase-1 tools are **read-only** (annotate `ReadOnlyHint: true`). They observe/retrieve; they do not mutate UI or files.

### 5.7 Known limitation

A drag-dropped PDF (no `fileId`, no server path) is reachable only via Plane A (`board_snapshot` is board-only; `pdf_page_*`/`pdf_search_open`/`pdf_download` all work on it because the browser holds it). Plane B (`pdf_search` corpus, `file_download`) cannot see it until it is added to the library. The primary flow — a board plus its library-linked schematic (via BindLink) — is fully covered. Documented, not worked around.

---

## 6. Phase 2 — Prompting harness

Two layers. No new config toggle: the persona rides in `Instructions` whenever MCP is enabled; prompts are opt-in by invocation.

### 6.1 Persona preamble (always-on, portable)

Prepend a short role framing to `boardripperInstructions` so every client gets the technician mindset at init. Kept tight to protect handshake size. Draft (final wording owned by the user). Note: the `kb_search` mention is added only when Phase 3 lands — if Phase 2 ships first, drop that clause so the persona never advertises a tool that isn't registered:

> You are acting as an electronics repair technician working a live board in BoardRipper. Understand the circuit before you judge it: build a mental model step by step from what the board and its schematic actually show, form hypotheses, and test them with measurements rather than guessing. Work incrementally — identify the board, map its power domains, follow the suspect signal, narrow down. You have eyes (`board_snapshot`, `pdf_page_image`), the schematic and its text (`pdf_page_text`, `pdf_search_open`, `pdf_search`), the netlist/parts, reference data (`obd_*`), a knowledge base (`kb_search`), and a shared worklist to record findings and ask the user to probe. Prefer evidence over assumption; when unsure, request a measurement and wait. **Never guess** — don't invent a net's function, a part's role, or an expected value you don't have; if you must infer, say so and lower your confidence. Treat **unlabeled / auto-named nets as low-trust**: they carry no meaning, so infer their role only from what they connect to, state that you're inferring, and confirm before acting on it (§12.9).
>
> When you request measurements, be economical and correct: don't ask for the same electrical node twice — nets bridged by a populated 0Ω resistor or closed jumper are one node (but have the user confirm the link if it may be unpopulated). Pick the meter mode that fits the target: diode mode for data lines, **not** for power rails or CPU/GPU phases (there it reads low and meter-dependent); use voltage or resistance-to-ground for rails; reserve continuity mode for continuity only. Remind the user to power down before resistance/diode probing and to re-check any abnormal reading — but calibrate these safety reminders to their apparent skill and drop them for an evidently experienced tech. `kb_search('measurement')` has the full rationale.
>
> Teach as you fix. Explain your reasoning and the circuit in plain terms, calibrated to the user's level — enough that they learn *why*, not just *what*. Ground every explanation in the board (nets/parts as `[n:]`/`[p:]` chips, the schematic to point at the actual circuit), and define jargon the first time you use it. Prefer a clear analogy over precision the user can't yet use.

**Adaptive guardrails:** the *correctness/efficiency* rules (no redundant same-node request; correct meter mode per net class) always apply — they make the model sharper, not chattier. The *safety/procedure* reminders (power-off, continuity-mode misuse, double-check abnormal) and the *teaching depth* (§13) are delivered adaptively: they are the **same dial** — the single user model in §13.1 — so safety verbosity, explanation depth, and terseness of findings move together off one inferred read of the user's expertise. This is persona behavior, not a KB chunk (it governs how the model behaves, not reference data).

### 6.2 Invokable prompt templates (`Server.AddPrompt`)

Registered via the SDK Prompts capability; surface in Claude Code as `/mcp__boardripper__<name>`. Each returns a `user`-role `PromptMessage` priming the persona + a concrete tool-wired loop, parameterized by `PromptArgument`s.

- **`understand_circuit`** — arg `focus?` (net/part/area). Loop: orient (`board_overview` → `board_resolve`) → see (`board_snapshot`, `pdf_page_image`) → read (`list_nets`/`list_parts`, `net_info`/`part_info`/`net_neighbors`/`pin_connectivity`, `pdf_search_open`/`pdf_search`/`pdf_page_text`) → model (describe power domains + signal path) → verify (`request_measurement`). Emphasis: build understanding incrementally, show reasoning, don't jump to conclusions.
- **`diagnose`** — arg `symptom?`. Loop: read the case (`worklist_get` + `get_measurements`) → orient + reference (`board_resolve`, `obd_match`/`obd_data`) → localize (symptom → domain, bounded via `net_neighbors` + schematic) → hypothesize+test (`worklist_add`, `request_measurement`, `get_measurements`) → narrow → record (`worklist_set_list_note` + `post_message`).
- **`trace_rail`** *(optional, may land with Phase 2 or defer)* — arg `rail`/net. Trace a power/signal net via `net_neighbors` + schematic cross-ref + `request_measurement` at each stage.
- **`explain`** — arg `topic?` (a net, part, subsystem, or general concept). Teach it in simple, clean terms, grounded in the open board where relevant: what it is, what it does *here*, how it connects, what "healthy" looks like. Calibrated to the user model (§13.1). Distinct from `understand_circuit` (the model building *its own* understanding); `explain` is the model **teaching the user** (§13.3).

Prompts instruct the model to `kb_search` for the relevant technique or concept (composition with Phase 3), and follow the convergence/stop discipline in §12.7.

### 6.3 Relationship to the `boardripper-repair-helper` skill

No conflict. That skill is the Claude-Code-native entry; the server prompts are the **portable** layer (any MCP client) plus explicit slash-command starting points. The skill is untouched by this work.

---

## 7. Phase 3 — Knowledge base

Adds the **Resources** primitive + a search tool. Purpose: reusable reference the model pulls on demand → less handshake bloat, focused context, consistent method.

### 7.1 Content

A curated `kb/` of small markdown chunks, `go:embed`-ed into the backend binary (versioned with releases). Each chunk has frontmatter `{id, title, tags[], applies_to[]}`. Categories:
- **Method**: short-to-ground localization, no-power tree, power-sequencing checks, liquid-damage protocol.
- **Measurement practice** (authoritative — user-provided, see §7.5): request hygiene (0Ω/jumper node collapsing), diode-mode applicability, safety/validity.
- **Failure-mode catalog** per subsystem: PMIC, charging, backlight, SSD/storage, USB-C/PD, etc.
- **Measurement norms**: expected healthy diode/voltage readings per rail class, cap-to-ground short thresholds.
- **Conventions**: rail/net naming across formats (including which name patterns are *synthetic*/auto-generated per format — feeds the §12.9 `named`/`synthetic` classifier and warns the model where names are obfuscated or vendor-specific), glossary; board-family quirks keyed to `board_resolve` families.
- **Concepts** (teaching material, see §13.4): plain-language explainers — buck converter / LDO, power sequencing, diode drop & why diode mode works, pull-ups, decoupling, common rails. Method chunks explain *how to work*; concept chunks explain *how electronics work*, for the user.

**Authoring:** system built first; chunks drafted by the implementer and **clearly marked draft**, then reviewed/corrected by the user (domain expert) before shipping. No fabricated measurement thresholds ship as authoritative.

### 7.2 Access — both paths

1. **Resources** — each chunk exposed as `boardripper://kb/<id>`, listable via `resources/list`, readable via `resources/read`, plus a resource template `boardripper://kb/{id}` for direct addressing. Standards-native browsing for any client.
2. **`kb_search(query, tags?, k?)` tool** — returns top-k relevant chunk summaries + ids (and optionally full text). Implementation: reuse the SQLite FTS5 pattern from `pdfindex` **or** in-memory keyword scoring (KB is small, ~dozens of chunks; start in-memory, promote to FTS5 only if it grows). This is the efficiency lever.

### 7.3 Composition

Prompt (the loop) → `kb_search` (the technique) → chunk (the reference) → `obd_*` + `board_resolve` (this-board facts). General method + board-specific data, combined, without loading everything up front.

### 7.4 Loading / caching

Chunks parsed once at startup from the embedded FS into an in-memory index (id → {frontmatter, body}). Resources and `kb_search` read that index. No new persistent DB unless promoted to FTS5.

### 7.5 Measurement-practice chunks (authoritative, user-provided)

These three chunks encode the user's own measurement rules verbatim-in-intent; they ship without the "draft" caveat (domain-expert authored). The correctness/efficiency rules also surface as always-on persona behavior (§6.1); the chunks carry the full rationale the model pulls on demand.

```markdown
---
id: measurement-request-hygiene
title: Requesting measurements economically
tags: [measurement, method, efficiency]
applies_to: [any]
---
- Treat nets bridged by a populated 0Ω resistor or a closed jumper as ONE
  electrical node. Don't request (or ask the user to probe) the same node twice.
- Before collapsing two nets into one node, confirm the bridging link is actually
  populated. A 0Ω resistor / jumper pad left unpopulated (DNP / open) does NOT
  connect the nets — if the link may be open, have the user verify it is bridged
  on this board before treating the nets as one.
- Detecting a bridge: net_neighbors surfaces nets reachable through 2-pin parts;
  part_info on the bridging part gives its value. Only a 0Ω-class link (0 / 0R /
  jumper) collapses the node; a real resistor does not.
```

```markdown
---
id: diode-mode-usage
title: When diode mode helps and when it misleads
tags: [measurement, diode, method]
applies_to: [any]
---
- Diode mode is very useful on DATA lines (USB, PCIe, DP/LVDS, I2C, …): it
  reveals shorts, leakage, and blown ESD/protection diodes, with readings that
  compare meaningfully pin-to-pin.
- Do NOT rely on diode mode for major power rails or CPU/GPU phase (VCORE) nodes.
  Those readings are low and vary a lot with the meter's diode-test voltage, so
  they are neither diagnostic nor comparable between meters.
- For power rails: measure VOLTAGE (board powered) or RESISTANCE-to-ground (board
  unpowered) instead.
```

```markdown
---
id: measurement-safety
title: Safe and valid measurement practice
tags: [measurement, safety, method]
applies_to: [any]
---
- Resistance and diode measurements require the board UNPOWERED. Never measure
  ohms or diode on a powered-up board.
- Continuity (beep) mode is for continuity ONLY — connected vs open. Never infer
  a resistance value or a rail's health from the beep.
- If a reading is abnormal (outside the expected range), double-check before
  acting: re-seat probes, confirm range/mode, re-probe. Bad contact and wrong
  mode cause more false readings than real faults.
```

Delivery note: `measurement-request-hygiene` and `diode-mode-usage` inform *how the model chooses* `request_measurement` targets/kinds and always apply. `measurement-safety` is surfaced to the user adaptively per §6.1 (dropped for an experienced tech).

---

## 8. Cross-cutting

- **Config:** one new value for the download size cap (default 50 MB). No new enable toggles — everything rides the existing `mcp_enabled`; drive-UI is irrelevant (all new tools are read-only). Prompts/Resources are always advertised when MCP is enabled.
- **Capabilities:** `initialize` now advertises tools **+ prompts + resources**. Verify clients that only speak tools degrade gracefully (they ignore the extra capabilities).
- **Activity panel:** existing receiving-middleware records `tools/call`; consider also surfacing prompt/resource usage in `/api/mcp/status` (minor, optional).
- **Security:** new byte-serving path (`file_download`) reuses the library-root sandbox + eager-read cloud semantics; images/blobs are size-capped; bridge trust model unchanged (replies bound to authenticated session).

## 9. Out of scope / future

- Backend headless PDF rasterization (render API exists but unused).
- Self-growing KB: distilling solved worklist cases into new chunks (needs write/curation path, shipped-vs-per-install separation, dedup).
- Per-install user KB overlay (user's own notes alongside the shipped KB).

## 10. Testing

**Phase 1 (Go):** `pdf_search` file scoping; `file_download` cap + path-sandbox + cloud-error passthrough; content-block shape (image/resource) via the in-memory self-test client. **(Frontend):** `board_overview` returns board+pdfs+worklist summary; `board_snapshot` op returns a PNG (and honours `around=` crop); `pdf_page_image`/`pdf_page_text`/`pdf_search_open` against a fixture PDF; descriptor exposes `pdfs[]`; feedback-rich drive-UI returns (`highlight_net`→pins, `select_part`→found/side, `set_side`→side); net results carry the §12.9 `named`/`synthetic` reliability flag (a known auto-name like `N$12` classifies `synthetic`, a real rail name classifies `named`).
**Phase 2 (Go):** `prompts/list` includes `understand_circuit`/`diagnose`/`explain`; `prompts/get` returns well-formed messages with arg substitution; persona (technician + educator) present in `Instructions`.
**Phase 3 (Go):** `resources/list`/`resources/read` for chunks; `kb_search` ranks a known query to the expected chunk (incl. a concept chunk for an `explain`-style query); embedded FS parses all chunks (frontmatter valid, all categories incl. concepts).

## 11. Phasing / sequencing

1. **Phase 1 — Access** (largest; the capability the rest builds on).
2. **Phase 2 — Harness** (small; depends on Phase-1 tool names being final so prompts reference real tools).
3. **Phase 3 — Knowledge** (independent of 1–2 mechanically, but prompts in Phase 2 reference `kb_search`, so land 3 before or with the final prompt wording).

Each phase gets its own implementation plan and can ship independently. New surface added by §12/§13 slots into the phases: `board_overview` + region-cropped snapshots + feedback-rich drive-UI returns → Phase 1; the `explain` prompt + educator persona → Phase 2; the **concepts** teaching chunks → Phase 3.

---

## 12. Designing for the agent (Claude-experience refinements)

The tool surface is the model's entire world; its ergonomics decide whether the agent is fast and grounded or slow and hallucinating. These refinements apply across all phases — they are how a capable model is *made* capable here.

### 12.1 One-call orientation — `board_overview`
Cold-start should be one call, not eight. New live (bridge) tool `board_overview` returns everything the browser knows in a single read: `{session, board:{name, boardNumber?, parts, nets, side, generation}, pdfs:[{name,page,pageCount,fileId?}], worklist:{parts, nets, pendingMeasurements, unreadUserMessages, hasListNote}}`. It carries the raw `boardNumber` so the model can `board_resolve`/`obd_match` next. Keep the lightweight `board_active` for cheap staleness polling (its `generation` token); `board_overview` is the deliberate "lay of the land," the recommended first call in every prompt. Single-plane (browser-side) so it composes no cross-plane calls.

### 12.2 Feedback-rich returns — close the loop
Every action returns its observable effect, so the model needn't issue a follow-up read to learn what happened. Enrich the existing drive-UI tools: `highlight_net` → `{net, pins_highlighted, parts}`; `select_part` → `{refdes, found, side, centered}`; `set_side` → `{side}`; `pdf_goto` → `{page, matched?}`. When a visual check is warranted the model can `board_snapshot` to confirm — actions and eyes form a closed loop instead of open-loop guessing.

### 12.3 Token & vision discipline — text first, pixels when they add information
Vision is the most expensive context the agent spends. Guidance (in the persona and the visual tools' descriptions): reach for topology/text first (`net_info`, `part_info`, `pdf_page_text`, `pdf_search_open`); reach for `board_snapshot`/`pdf_page_image` when text is insufficient — no schematic text layer, reading a specific region, or visually correlating board↔schematic. To keep images cheap *and* legible, both visual tools take an optional region: `board_snapshot(around=refdes|bbox)` crops to a part/area; `pdf_page_image(region=bbox)` renders a sub-rectangle. A tight crop beats a full-page dump on both cost and accuracy. Default resolution is tuned for legibility, not maximum.

### 12.4 Names that self-disambiguate
Tool names are the model's API docs. The two PDF searches must never be confusable: `pdf_search` = library-wide FTS (established name, keep); `pdf_search_open` = within the open document (renamed from `pdf_find`). Convention: open-doc tools (`pdf_page_image`/`_text`/`_search_open`/`_download`, `board_snapshot`, `board_overview`) act on the focused session; library tools (`pdf_search`, `file_download`) take explicit ids. Each description states its scope in the first sentence.

### 12.5 Ambiguity returns candidates, not errors
When a reference is ambiguous, return ranked candidates with disambiguating fields rather than failing: `select_part`/`part_info` on a non-unique refdes → candidates with side/value/package; multiple open sessions with no `session` arg → the session list; `board_resolve` near-miss → close matches. The model picks; it never dead-ends on a lookup.

### 12.6 Evidence grounding — measured vs known vs inferred
Confidently-wrong repair advice is dangerous. The model distinguishes and labels its basis: **measured** (a `get_measurements` reading), **known-good** (OBD / KB norm), or **inferred** (topology/reasoning). Worklist notes and conclusions tag the source; when the basis is "inferred" and the stakes are high (a part-replacement call), prefer `request_measurement` over asserting. `expected` fields on measurement requests carry the spec so user and model compare against the same number.

### 12.7 Convergence & stop conditions
Agents rabbit-hole. The prompts encode: after a few inconclusive probes, step back and re-scope rather than drilling; converge to a single most-likely hypothesis before recommending a fix; and always leave the worklist in a state the user can act on — current suspects plus the *one* next measurement that would most reduce uncertainty. Know when to stop: a confirmed cause, or a clear "here's what I need from you to proceed."

### 12.8 Non-destructive, attributed writes
Shared-worklist writes never clobber the user's content: agent entries are additive and attributed (`source=agent`), and the model reads the worklist (`board_overview`/`worklist_get`) before writing so it augments rather than overwrites. Writes/drive stay gated; reads are always free — explore freely with reads, act deliberately with writes.

### 12.9 Never guess; unlabeled nets are low-trust
Guessing is *the* failure mode to design out for a repair agent — wrong advice here costs the user a board. Two rules, enforced by data and persona so the model can't drift into confident fabrication:

- **No fabrication.** The model never invents a net's function, a part's role, or an expected value it doesn't have. When it must infer, it labels the claim *inferred* (§12.6), lowers confidence, and does not present inference as fact. "I don't have enough to be sure" is a valid — often correct — answer.
- **Unlabeled / synthetic nets are low-trust.** Many boardviews carry auto-generated net names (`N$123`, `NET0042`, bare numbers, empty strings) that encode *no* semantics. The model must not read function into them — an unlabeled net is not "probably ground"; that is inference stacked on an identifier that means nothing. To make this a property of the **data** rather than a per-format pattern the model must recognize, every net-bearing result (`list_nets`, `net_info`, `net_neighbors`, `pin_connectivity`, `board_overview`) annotates each net with a reliability flag — `named` vs `synthetic`. The classifier is a heuristic (format-specific auto-name patterns) plus a parser-provided "named-in-source" signal where a parser can supply it (ideal; may be added per-format over time). On a `synthetic` net the agent leans harder on topology + measurement and says so explicitly: *"this net is unlabeled, so I'm inferring its role from what it connects to — worth confirming before we act."*

This composes with §12.6: named + measured is high-trust; synthetic + inferred is the weakest basis and must never drive a part-replacement recommendation without a confirming probe.

## 13. Educating the user, not just fixing

A primary goal of the harness: **teach**, don't just diagnose. A repair that leaves the user understanding *why* is worth more than a silently-fixed board. Education is a first-class behavior, not a footnote.

### 13.1 One user model drives all adaptivity
The agent maintains one lightweight model of the user — expertise and intent — inferred from their notes, corrections, terminology, questions, and any explicit statement. That single model governs three dials in lock-step:
- **Explanation depth** — from first-principles teaching (what a PMIC is; why this rail sequences after that one) to terse expert shorthand.
- **Safety-reminder verbosity** — the §6.1 guardrails, dropped for an evident expert.
- **Terseness of findings** — beginners get narrated reasoning; experts get conclusion + evidence.

When unsure, start in the middle and adjust on signal; it's fine to briefly ask "how deep should I go?" once. This unifies the adaptivity already specified for safety with the teaching dimension — there is *one* dial, not three.

### 13.2 Teach the why, grounded in this board
Explanations are always tied to the board in front of the user: reference real nets/parts with `[n:NET]` / `[p:REFDES:PIN]` chips, use the schematic (`pdf_page_image`) to point at the actual circuit, prefer plain language + analogy over jargon, and define a term the first time it's used. The model explains *as it works* ("I'm checking this rail because it feeds the CPU, and a short here would explain your symptom") so the diagnosis itself is the lesson.

### 13.3 The `explain` prompt
New invokable prompt `explain` (§6.2) — the model **teaching the user**, as opposed to `understand_circuit` (the model building its own understanding). Given a topic (net/part/subsystem/concept) it explains in simple, clean terms, grounded in the open board when relevant, calibrated to the user model.

### 13.4 KB chunks are teaching material too
The knowledge base serves the user, not only the model. The **concepts** category (§7.1) holds plain-language explainer chunks that `kb_search` surfaces for `explain` and that the model quotes/adapts to the user's level. Method chunks explain *how to work*; concept chunks explain *how electronics work*.

### 13.5 Why this fits the medium
The board and schematic are already on screen and addressable (nets, parts, pins, chips, snapshots). That makes grounded teaching cheap: the agent can point at the real thing the user is holding rather than explaining in the abstract. Education here is not a bolt-on — it's the natural payoff of a live, addressable board plus a model that can see and reason about it.
