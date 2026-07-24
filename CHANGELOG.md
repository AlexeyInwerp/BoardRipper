# BoardRipper changelog

## v0.31.44 — 2026-07-24

Interactive Mode: size any board element by clicking it. Plus the offline
single-file build, and a batch of rendering fixes — including two faults that
could stop the renderer mid-session.

### Interactive Mode (new)

- **Click a board element to resize it** — a toggle at the top of Settings ▸
  Board turns a plain click into a sizing gesture: whatever you click opens a
  popup at the cursor with the handles relevant to it, and the whole board
  previews live as you drag. Pan and zoom keep working. `f37157a8` `1c163d36`
- **Handles grouped by what you clicked** — a pin offers pin size, pin-number
  size, net-label size, diode-value size, selection-highlight size/opacity and
  the selected-label floor/LOD; a component offers its label size and outline
  width; a highlighted net's connection line offers width, colour and opacity;
  empty board offers board opacity. Every handle carries a one-line
  description, scroll-to-nudge and double-click-to-reset.
  `c798d216` `a387fb20` `746e761a` `82070a22` `e83eed9a`
- **Sizes that previously wouldn't budge** — pin, pin-number, net-label,
  component-label and diode-value sizes are now true multipliers, so they
  scale on every board instead of only nudging labels that happened to sit at
  the old minimum-size floor. `6bee409f` `9f80f81e` `b40523b4`

### Rendering

- **Fixed: the renderer could stop on any settings change** — with spotlight
  (darklight) dimming and a part selected, the selection halo was destroyed
  along with the scene on each rebuild and then drawn again, halting the
  ticker until "Restart Render". `856c4343` `5ff71f69`
- **Fixed: garbage lines across big nets** — net-line, punch-through and glow
  geometry is chunked below the 65,535-vertex index ceiling, and the chunk
  budget now adapts when pins are scaled up.
  `657ea5ef` `c40dffde` `3df9f6f0` `d656e3c9`
- **Component names step aside as you zoom in** — a large BGA designator fades
  to a ghost as it grows, so the net names underneath stay readable instead of
  being blanketed by it. `1ab634f0` `8babb0cc`
- **Fixed: nets on dense BGAs wouldn't select** — a click landed on the net
  label and selected the whole component, which highlights no net; clicks now
  resolve to the specific pin. `e1805871`
- **Safari/Polaris net-line artefacts** and **hover lag on Windows Firefox**.
  `6a1777cf` `d7b0ed8e`

### Offline & lite build

- **Offline copy** — a single-file `boardripper-lite.html` that runs straight
  from `file://`, downloadable from the toolbar, with the lite web app
  deployed alongside each release.
  `2f39348b` `a23175ac` `9aaa692d` `5dc6d080` `954f614b`

### Library, PDF & Settings

- **Donor boards moved under the PDF tab** as a sub-view, mirroring the
  Folders source menu. `263686e1`
- **Fixed: repeated index clicks stacked prompts** — starting a PDF index now
  claims its slot immediately instead of after a long enumeration, so extra
  clicks fail fast rather than queueing a "stop previous index?" dialog each.
  `b2ca9c82`
- **Settings tabs are icons** that expand to labels when there's room and
  collapse when there isn't; the search bar moved below them.
  `077b6827` `6c74fe14` `686d6439`
- **Fixed: PDF linked auto-switch** now prefers the active bound board tab.
  `6e8c8f56`

### MCP

- **Fixed: stale 0/0 board descriptor** — the descriptor is re-pushed once
  parsed data lands. `2b3987b0`


## v0.31.43 — 2026-07-20

MCP auth follow-ups to v0.31.42's session separation: clearer errors for
logged-out agents, and mixed authentication so OAuth users and token users
can coexist on one install.

### MCP server

- **Mixed authentication** — OAuth mode is now a strict superset of token
  mode: per-browser and shared bearer tokens keep working when
  Authentication is set to "OAuth (no token)", so some users can connect
  via OAuth while others keep their tokens on the same install. `16e0b674`
- **Clear errors instead of "oauth 404"** — invalid-token responses now
  carry an RFC 6750 `WWW-Authenticate` challenge explaining the v0.31.42
  token reset, and the OAuth endpoints answer an explicit 403 ("OAuth is
  disabled on this install") in token mode rather than a hidden 404. The
  404 remains only while the MCP server is disabled entirely.
  `b35c1c7c` `16e0b674`


## v0.31.42 — 2026-07-20

Multi-user MCP: per-browser agent pairing. On installs shared by several
technicians every agent used one shared token and targeted the
most-recently-focused page install-wide — so one user's agent could read
(and even drive) another user's board. Sessions are now separated by
pairing each browser with its own token.

### MCP server

- **Per-browser agent tokens** — Settings ▸ Integrations now offers two
  token sources: **"This browser's agent"** (default; scoped to the boards
  open in this browser, with an editable label and one-click rotate) and
  **"Shared (all sessions)"** (the install-wide token, kept for
  deliberately analyzing other users' sessions). An agent with a paired
  token only sees and drives its own browser's pages, and its default
  target is that browser's focused page — wrong-board mixups between
  users are gone by construction. `e2c29dde` `4c1b1c90` `84b91b63`
  `f1dd68cd` `95b1526c`
- **One-time token reset** — on the first start after this update the
  shared MCP token is regenerated once: agents configured before the
  update are logged out, because resetting the shared credential was the
  only way to migrate it properly. The 401 response and a notice in
  Settings ▸ Integrations explain the reset and point to the new tokens;
  open BoardRipper pages re-join the bridge automatically. `fec25f66`
- **board_sessions** now reports each page's `client_label` and
  `focused_at_ms`, so multiple open sessions are distinguishable — and
  with the shared token lists every page, while a paired token lists only
  its own. `f1dd68cd`
- **Fix:** a background window's periodic bridge reconnect no longer
  steals the "most recently focused" default target from the window the
  user is actually working in. `84b91b63`


## v0.31.41 — 2026-07-20

Renderer follow-up round: less per-frame work during interaction, no more
rebuild storms across tabs, and Text fast mode is now on for everyone.

### Board view

- **Text fast mode is enabled once for existing installations** (it became
  the default for new installs in v0.31.40). A one-time notice on first
  start explains the change and links to Settings; the previous text
  renderer remains available under Settings ▸ Performance & Debug ▸
  "Text fast mode", and turning it off sticks.
- **Search + auto-dim in fast mode** now spotlights the matching parts'
  labels, matching the classic renderer.
- **Fix:** flipping/rotating the board could briefly cull labels against
  stale transforms.

### Parsers

- **XZZ oblong pads** render as capsules (shape 0x01 with width ≠ height),
  with a plausibility guard against implausibly huge pins (PL5TU1B).
  `7a474e6a` *(shipped in this release but missing from its original
  notes; added retroactively.)*

### Performance

- **Theme and settings changes no longer rebuild every open tab at once** —
  inactive tabs rebuild once, when you switch back to them.
- **Selection/worklist highlight outlines** skip their redraw on pan frames
  entirely (previously re-stroked every frame while the viewport moved).
- **Net-line pulse** animates a pre-baked layer's opacity instead of
  rebuilding all line geometry 60× per second.
- **Net connection chains** recompute only when the selection actually
  changes, not on every hover while dimmed.
- **Memory:** fixed a leak that kept abandoned board derivations alive
  after fold/filter toggles; deep-paused background tabs now release the
  fast-mode text layer's memory too.


## v0.31.40 — 2026-07-19

Merges the renderer-optimization branch — the implementation round of our
renderer performance plans from earlier this summer (see
`docs/research/rendering-review-2026-07-12.md` and
`docs/research/wasm-webgpu-acceleration-plan.md`).

### Board view

- **Text fast mode** (new default): board text draws on a lightweight 2D
  overlay instead of tens of thousands of in-scene text objects — much
  higher FPS on label-dense boards (11→60 fps measured on a dense board).
  The previous text renderer stays available: Settings ▸ Performance &
  Debug ▸ "Text fast mode".
- **Smooth wheel zoom** (default on): wheel and keyboard zoom glide toward
  the cursor at the same speed as before. Disable in Settings ▸
  Performance & Debug. Trackpad pinch, Ctrl-zoom and drag-zoom unchanged.
- **Selected part labels** now follow zoom level-of-detail; a new
  "Selected Part Labels" slider (Settings ▸ Zoom Level of Detail) controls
  their minimum on-screen size.
- **Fix:** labels could disappear after changing visual settings while
  zoomed in — long-standing culling bug, affects both text modes.
- **FPS cap is off by default** (the 60 fps cap remains in Settings).

### Performance

- **Smoother hovering** on dense boards: pointer handling coalesced per
  frame, tooltip measurement cached, trace lookup on a spatial grid.

## v0.31.39 — 2026-07-18

A small fix round: converter-produced GenCAD files open again, XZZ diode maps
draw their zero readings, and pin numbers can be toggled straight from the
View tab.

### Parsers

- **NUL-prefixed GenCAD files open again.** Honhan/GOCCANH "TO CAD" converter
  exports (e.g. `DAX3ACMBAF0 X3AC Rev F.CAD`) start with NUL bytes before
  `$HEADER`, which content detection didn't strip — so the `.cad` fallback
  routed the file to the Mentor Neutral parser, which rejected it with
  "contains no placed components". Detection now tolerates the NUL prefix;
  the X3AC sample opens with 2,834 components / 1,732 nets. (`7c00bd90`)
- **XZZ zero diode readings are drawn.** `=0=` records in XZZ diode maps were
  classified as "not measured" and hidden from the on-pin overlay, tooltip
  and component info — but a literal 0 is a real measurement (short to
  ground), and on connector diode maps it's most of the table (776 of 1,144
  on the iPhone 15 Pro map). Zeros now draw as "0" on the pin and show as
  0.000 V in the tooltip and info pane; cached boards re-parse
  automatically. (`9d178fa5`)

### Board view

- **Pin numbers toggle in the View tab.** On diode-value maps the pin-number
  labels compete with the on-pin readings; hiding them previously meant a
  trip to Settings. The View tab now has a Pin numbers visibility toggle next
  to Diode values, mirroring the same global setting. (`ec30722c`)

Also riding along: the desktop MCP-sidecar groundwork from v0.31.38 (an
Electron-only release) is in a Docker image for the first time here; it is
gated on Electron and inert in the web build.

## v0.31.37 — 2026-07-14

An MCP release: the assistant can now drive the live board — open library
files into tabs, work across several open boards at once, and read a
selected component's pins — plus a smarter library search that finds a board
by any of its metadata, including its folder path.

### MCP server

- **Open library files into the live view.** New `open_file` tool loads a
  board (and its auto-bound schematic PDFs) or a document by file id, so the
  assistant can go from a search hit to an open board on its own instead of
  waiting for the user to open it. (`9eb9f0f6`)
- **Work across several open boards.** New `board_tabs` lists the open board
  tabs and `switch_tab` changes the active one; the inspection tools
  (`part_info`, `net_info`, `list_parts`, …) take an optional `tab`, so the
  assistant can compare two boards without losing its place — e.g. a
  pin-for-pin comparison of the same chip on two variants. (`439f921e`,
  `9eb9f0f6`)
- **Read the selected component.** New `selected_part` returns the pins and
  nets of whatever the user has clicked, so the assistant can pick the
  conversation up from the board. (`439f921e`)
- **Search finds a board by any of its metadata.** `file_list` now matches
  the folder path, manufacturer and extension in addition to filename /
  board number / model, with multi-word AND matching — so searching an Apple
  A-number like "A2991" returns its boardview even though the file is named
  by its 820-number and sits in an `A2991 …` folder. (`1d05729a`)
- **Don't download boardviews as blobs.** The download tool now tells the
  assistant that boardview files (BRD/FZ/XZZ/BDV-ASC …) are encrypted or
  obfuscated and must be read through the live board tools, not fetched as
  raw bytes. (`439f921e`)
- **Fixed `board_sessions`.** It failed output-schema validation and returned
  an error instead of the list of open boards; now returns cleanly.
  (`1d41e169`)

### Library

- **Search matches the folder path too.** The Library search box now finds a
  board by any metadata including its folder path, with multi-word matching,
  so typing an Apple A-number surfaces the boardview even when its filename
  only carries the board number. (`23ad492f`)

## v0.31.36 — 2026-07-13

A memory and parse-performance release: closing board tabs now actually
returns their memory, big boards parse without freezing the UI, and the
status bar shows live memory usage.

### Memory

- **Closing a board tab releases its memory.** Two independent leaks meant
  every opened board stayed in memory forever — its parsed data (~15 MB per
  board, held via leftover viewport/resize callbacks) and its entire GPU
  scene (batched geometry and buffers, ~130 MB per few boards, pinned by
  PixiJS context-loss listeners and a pooling bug patched via
  `patch-package`). A session that opened and closed a handful of large
  boards used to park at 1 GB+; the same cycle now settles back near
  baseline, and background-tab deep-pause cycles no longer leak either.
  A regression test with GC-forced WeakRef canaries guards both fixes.
  (`d5e16ee9`, `2f3e49a6`)
- **Live memory readout in the status bar.** Shows precise JS memory
  (including the parse worker) where the browser supports it — the app is
  now served cross-origin isolated to unlock that API — and falls back to
  an approximate heap figure marked `≈` elsewhere. (`466e2b74`)

### Performance

- **Board files parse in a background worker.** First open of a large board
  (100+ MB Allegro/BRD/TVW) no longer freezes the tab for the whole parse —
  the UI stays responsive while the progress overlay runs. Encrypted FZ
  files, the key dialog, and drag-and-drop all behave as before; if the
  worker is unavailable the old inline path is used automatically.
  (`1e6d7e1a`)
- **First paint no longer waits for the board cache.** The parsed-board
  IndexedDB write (hundreds of ms on big boards) now happens in the
  background, and a failed write no longer fails the whole load.
  (`2f1a80a8`)
- **Faster parse internals, identical output.** XZZ outline clustering
  dropped its all-pairs scan for a spatial hash, ghost-component detection
  got a sweep prefilter, and the FZ RC6 loop lost an array shuffle — each
  parity-tested byte-for-byte against the previous implementation, so no
  re-parse of cached boards is needed. Parse stages now log timings to the
  Debug panel (`perf` scope). (`ce455ab1`, `d7af8e5e`, `2fb7723e`,
  `3986f879`)

### Fixes

- **XZZ: 2-pin capacitor/coil pads render full-size again.** Placeholder
  pad geometry from the parser shrank them. (`7b14c221`)

## v0.31.35 — 2026-07-11

A selection and small-UI fix pass.

### Fixes

- **A nearby test point no longer steals a click meant for the component.** From
  a zoomed-out view the "pin click radius" (a screen-pixel grab distance) grew
  large in board units, so a small surrounding test point registered as the click
  and — being the smallest thing there — won selection. Clicking inside a
  component now takes priority over a merely-nearby pin, and the default Pin Click
  Radius is tighter (30→15px). Genuinely stacked components still cycle
  smallest-first. (`eb5eac27`, `ec18e86c`, #24)
- **Component names no longer render doubled when the board is rotated or
  mirrored.** The white highlight copy of a selected / net-highlighted name stayed
  frozen at its old orientation while the base name re-oriented, leaving two
  overlapping offset copies; the highlight now re-syncs on rotate/mirror.
  (`eb5eac27`)
- **Worklist notes wrap in the board hover tooltip.** A long note used to stretch
  into one very wide line with its own line breaks collapsed; it now wraps and
  keeps its newlines. (`d9127ee2`)
- **The MCP connection Copy button works over plain HTTP.** On a LAN / NAS address
  (not HTTPS or localhost) the browser Clipboard API is unavailable, so the button
  silently did nothing; it now falls back to a copy path that works there.
  (`d9127ee2`)

## v0.31.34 — 2026-07-09

Continues the MCP build-out: a connected AI assistant now arrives primed as a
repair technician and can pull on a built-in repair knowledge base. Off by
default; enable it in Settings ▸ Integrations.

### MCP integration

- **The assistant is primed as a repair technician and teacher.** Every MCP
  connection now carries a persona: understand the circuit before judging it,
  work from evidence not guesses, treat unlabeled nets as low-trust, follow
  sound measurement practice (diode mode for data lines, not power rails; ohms
  and diode only on an unpowered board; continuity mode for continuity only),
  and teach the *why* in plain terms — calibrated to how much guidance you want.
  (`d59e812`)
- **Three step-by-step workflows you can invoke.** `understand_circuit`,
  `diagnose`, and `explain` (they appear as slash commands in Claude Code) walk
  the assistant through learning a circuit, running a symptom-driven diagnosis
  on the shared worklist, or teaching you about a net/part/concept — each
  grounded in the board you have open. (`093a5c4`)
- **A built-in repair knowledge base.** The assistant can pull concise method
  and concept notes on demand — short-to-ground localization, measurement
  hygiene, when diode mode helps vs misleads, power-rail basics — through a
  `kb_search` tool and read each note as an addressable resource. It searches by
  relevance rather than loading everything, so the connection stays lean.
  (`a779430`, `4800d3c`, `53719d3`)

## v0.31.33 — 2026-07-09

Expands the MCP integration so a connected AI assistant can actually see and
read the board it's helping with — the first of a phased build-out. Off by
default; enable it in Settings ▸ Integrations.

### MCP integration

- **The assistant can see the board and schematic now.** `board_snapshot`
  captures the live board view as an image and `pdf_page_image` renders any page
  of the open schematic, so a copilot can visually correlate a part on the board
  with its symbol on the print instead of working from net names alone.
  (`32ccf34`, `6789416`)
- **Text access to the open PDF, plus scoped library search.** `pdf_page_text`
  returns a page's text and `pdf_search_open` searches within the open document
  instantly; the existing library-wide `pdf_search` now also accepts a single
  file id to scope a search. (`f5db6d4`, `908da01`)
- **Pull a PDF down to read it natively.** `pdf_download` hands the open
  schematic's bytes to the assistant and `file_download` retrieves any indexed
  library file by id, so a search hit becomes a document the model can read
  end-to-end. (`4730d06`, `3c49c0e`)
- **One-call orientation.** `board_overview` reports the open board, its
  part/net counts, shown side, every open PDF (name/page/id), and a worklist
  summary in a single call — and the bridge now tells the assistant which PDF
  you have open. (`39f30a1`)
- **Unlabeled nets are flagged low-trust.** Every net the assistant reads is
  tagged `named` or `synthetic`, so it won't read a function into an
  auto-generated name like `N$123`. (`cba1b66`)
- **Drive-UI actions report their effect.** Highlighting a net, selecting a
  part, or flipping sides now returns what actually happened (pins highlighted,
  part found and its side), so the assistant can confirm an action instead of
  guessing. (`4fc071c`)

### Fixes

- **Large images and downloads no longer drop the bridge.** The board↔assistant
  WebSocket capped messages at 32 KiB and tore down the connection on any real
  image or PDF; the limit is raised so snapshots, page renders, and downloads
  round-trip cleanly. (`a4ef066`)

## v0.31.32 — 2026-07-08

A memory-optimization pass. Across a long session BoardRipper now releases
memory back to the system instead of holding on to many gigabytes — both in the
browser (open boards and PDFs) and in the Docker backend.

### Performance

- **Hidden board tabs release their GPU memory.** Each open board used to keep a
  full WebGL context and scene graph alive for the whole session, so opening many
  boards piled up gigabytes that came back only slowly. A board that stays hidden
  now releases its renderer and rebuilds — restoring the exact view you left — the
  moment you switch back to it. (`1301612`, `2935c2d`, `6d1761d`, `697ce08`)
- **PDFs no longer accumulate memory as you scroll.** Long schematics kept every
  visited page's render data until the document was closed; page resources are now
  trimmed as you navigate, off-screen tile and preview images are freed promptly
  instead of waiting for the browser's garbage collector, and clean mode no longer
  keeps a second copy of the document loaded once it's switched off. (`31cc953`,
  `84ea23a`, `200b2de`)
- **The backend returns freed memory to the OS.** The Go server now derives a
  memory budget from its container limit and hands freed pages back promptly; the
  PDF-index workers cap and recycle their memory instead of holding a permanent
  high-water mark; large files stream to the browser instead of being buffered
  whole; and a real container memory limit is now actually enforced. (`c5260ff`,
  `ad6d9d2`)
- **Smaller idle footprint elsewhere.** The board renderer frees its overlay
  textures and detaches its ticker on teardown, and per-board diagnosis lookups
  are capped so a long browsing session doesn't grow them without bound.
  (`b6c104c`)

## v0.31.31 — 2026-07-08

A broad correctness-and-hardening pass from a full multi-directional audit, plus
a Library panel cleanup.

### Fixes

- **Removed / renamed library files get pruned again.** A deletion-path bug meant
  files that vanished from disk were never removed from the database after the
  first restart, so the folder tree, file list, and duplicate groups slowly
  filled with ghost entries. (`1227506`)
- **PDF text search no longer returns stale hits.** Re-indexing a changed PDF now
  clears its old pages first, so search never surfaces text from a previous
  version of a file, and the watermark re-index reliably strips added watermark
  terms. (`1227506`)
- **A failed or rolled-back update can be retried.** An update that rolled back
  (slow boot, transient Docker error) used to consume the release and could never
  be re-applied from the in-app updater; it now re-offers the same release, and a
  Docker image-load error is detected instead of being reported as success.
  (`1227506`)
- **Tighter file serving.** The legacy file endpoints now only serve or delete
  actual board and PDF files, closing an over-broad path that could reach other
  files in the data directory. (`1227506`)
- **GenCAD boards in non-mil units render correctly.** Files authored in inches or
  millimetres are scaled properly instead of collapsing to an invisible speck.
  (`409f570`)
- **Better part orientation, honest part types.** Rotated parts from more formats
  get a correctly-oriented outline box, and formats that can't distinguish SMD
  from through-hole now report "unknown" rather than guessing "SMD". (`409f570`)
- **More robust AI-copilot worklist entries.** Net or part names with different
  casing no longer create duplicate "(missing)" rows, an out-of-range repair mark
  can't corrupt the board highlight, and measurement requests reach the right
  net. (`c5d4d3a`)
- **PDF viewer memory and speed.** Fixed a decoded-page memory leak on panel
  resize and made in-document search noticeably faster on large schematics.
  (`7efd5b3`)
- **Library trees fill in during the first load.** On a fresh load or rescan the
  Board# and Model views no longer stay empty while files stream in. (`90ac02a`)
- **Cloud-storage placeholders fail fast.** Opening a not-yet-materialised cloud
  file surfaces the "materialize on host" message immediately instead of retrying
  for three minutes. (`90ac02a`)
- **Keyboard and theming polish.** Board rotate/mirror/pan shortcuts no longer
  fire while a list panel is focused, and bright accent colours stay legible as
  text on light themes. (`8357207`)

### Library panel

- **Reorganised for less clutter.** The Folder tab now sits next to Board #; the
  status line is a single row pinned at the bottom that expands — on click, or
  while a scan/index is running — to the full breakdown, keeping the "view failed"
  button; and switching tabs focuses the search field so you can type straight
  away. (`d45d37c`)
- **DB / Live folder source is a quick dropdown.** Clicking the Folder tab drops a
  small Database / Live menu that auto-dismisses, instead of taking a permanent
  row for one control. (`8248438`)

### Under the hood

- The MCP live-board bridge is now authenticated and gated, and its OAuth surface
  is bounded and hidden when the integration is off. Renderer pan/zoom hot paths
  shed redundant per-frame work. (`1227506`, `c5d4d3a`)

## v0.31.30 — 2026-07-06

Select components hidden under others, and get a clearer read on what's selected
versus what's merely on the same net.

### Features

- **Select stacked / overlapping components.** When parts overlap (alternates on
  shared pads, a small part on a big pad, a component under a shield), a click
  now selects the smallest part under the cursor; clicking the same spot again
  cycles through the stack. On 2-pin parts the second click selects the whole
  component — the first still selects the pin/net. Right-clicking a stack lists
  every overlapping part so any of them can be pinned to a worklist or looked up
  directly. (`be05bef`, `0358378`, `6ec512b`)

### Fixes

- **Clearer selected-component highlight.** The clicked part now draws a bold
  white outline with a white name label — distinct from the net-member parts it
  shares a net with (which stay in the net colour) and from the worklist mark
  colours. The selected name stays white at every zoom. (`6ec512b`, `aeeaced`,
  `9142a7d`)
- **Worklist mark highlights repaint on toggle.** Turning the worklist Highlight
  on/off now updates the on-board outlines immediately instead of waiting for the
  next pan or zoom. (`aeeaced`)
- **Worklist scroll stays put.** A long worklist no longer jumps back to the top
  when you click the board or switch the sidebar tab away and back. (#22,
  `6961bb8`)
- **ASUS X540 BDV boards align to their pins.** Boards whose file supplies no
  per-part geometry (all-zero part corners, e.g. X540UV 60NB0HF0-MB1020) had
  every part's outline and label pulled toward the board origin; parts now derive
  their box from their pins. (`e8aa6b7`)

## v0.31.29 — 2026-07-01

The session-restore boot prompt now lets you pick which boards and PDFs to reopen
instead of restoring all-or-nothing.

### Features

- **Session-restore file picker.** The "Reopen your last session?" prompt now
  lists every board and PDF that was open with a per-file checkbox (all checked
  by default). Uncheck any you don't want and only the rest reopen; the primary
  button reflects the count ("Reopen (N)") and disables when nothing is selected.
  Discard still clears the whole saved session. (`e4ca016`)

## v0.31.28 — 2026-06-30

Board↔PDF links now persist across reloads, the worklist records full multimeter
readings per net, two reported bugs (#20, #21) are fixed, and the tab/tooltip
chrome got a round of polish.

### Features

- **Board↔PDF links persist.** Linking a board and a PDF from the tab `∞` now
  writes a durable backend binding — a single row no matter which side you link
  from — so the link survives a reload + reopen, and auto-open / auto-switch keep
  working. Unlinking *demotes* the link (it won't auto-open or get resurrected)
  instead of destroying it. Dropped files are ingested into the library with a
  real id at drop time, so they bind and restore just like library files.
  (`9b18933`, `bc2855a`, `7ed1c8a`)
- **Worklist records all three measurements per net.** A net can hold a voltage,
  a diode drop, *and* a resistance reading at once — three independent slots
  instead of one value you had to switch the type of. Copying a worklist carries
  the nets and their readings as round-trippable text. (`c869aaa`, `62ea78d`,
  `8d06ceb`)
- **Worklist info in the board hover tooltip.** Hovering a part or net that's on
  the active worklist shows its mark + note inline; net readings render with the
  diode glyph. (`e459913`, `69bee13`)

### Fixes

- **#21 — self-update no longer drops Docker networks.** The in-app update only
  preserved image/env/mounts/ports; it now also re-attaches the container's
  user-defined networks (with aliases), Compose labels, and memory/CPU limits —
  fixing the reverse-proxy **502** that hit networked deployments after updating.
  (`cd95a7d`)
- **#20 — PDF pan/zoom is kept when switching PDF tabs.** Switching away and back
  no longer snaps the view to the top-left. (`8b8dc67`)
- **Session restore reopens PDFs.** A restored session reopened boards but loaded
  PDFs invisibly (no panel); they now reopen, and the "reopened N" toast counts
  what actually opened. (`f2cf83c`)
- **Link indicator + tab polish.** The `∞` / `○○` glyph is now proper link /
  link-off icons (identical size on Chrome and Safari). Long file names in tabs
  are truncated with a hover tooltip. Tab colours no longer flip when a group
  loses focus, so board↔PDF switching is visually stable. (`bc2855a`, `f2cf83c`,
  `af1731b`, `0f7609d`)
- **Clearer menu wording.** Right-click "Donor PDFs" → **"Search in PDF files"**,
  and the PDF `∞` "auto-open boardview" toggle is renamed **"auto switch
  boardview"**. (`f2cf83c`, `bc2855a`)

## v0.31.27 — 2026-06-25

Reload no longer loses your work, and the update dropdown now shows what's new
before you update.

### Features

- **Session restore — reopen your boards + PDFs after a reload or update.** When
  boards/PDFs were open and the page reloads (manually or after a self-update),
  BoardRipper now asks whether to **Reopen** or **Discard** the previous session.
  It never auto-restores — so if you reloaded *because* something hung, you just
  discard and nothing reloads. The open set is persisted continuously (so even a
  hard hang/crash leaves a record). On Reopen, library files re-fetch from the
  server, dropped files come back via the library's `incoming/` folder, and a
  dropped board that isn't on the server falls back to the local parsed-board
  cache; anything genuinely unavailable is reported. (`188e3c6`, `28d9b13`,
  `c7d7802`, `b2fbb48`)
- **"What's new" in the update dropdown.** The update badge now shows the new
  release's notes inline, under a collapsible **What's new** spoiler, instead of
  only linking out. The notes are embedded in the **signed** update manifest
  (sliced from this changelog at release time), so they're trustworthy and work
  offline; releases without embedded notes fall back to the "Release notes ↗"
  link. (Appears for updates *to* releases cut from here on.) (`94108dc`,
  `e7d88c0`, `65fb86d`, `5afddcc`)

## v0.31.26 — 2026-06-25

Two new features — a **Donor boards** library tab that turns marked PDFs into a
managed, auto-indexed, reset-proof donor pool, and **Worklist v2 Phase 1**
(inline per-net measurements + a relay-only AI section) — plus interface and MCP
fixes.

### Features

- **Donor boards.** A new Library tab gathers every PDF marked as a donor, each
  row showing its live index status and linked board. Click a row to open its
  detail (bindings + Open); double-click to open the PDF. Export / Import /
  Restore controls manage the pool. (`e562176`, `212e08e`)
- **Marking a donor guarantees it gets indexed.** Adding a PDF to the donor pool
  triggers a scoped backend pdfium index of exactly that file (server-side, so the
  UI, an MCP tool, or a script all benefit), plus a boot-time backfill of any
  donors that weren't indexed yet — so "search donors only" no longer silently
  misses a never-opened PDF. (`b4367c4`, `af499d2`, `e148eae`)
- **The donor pool survives "Reset Database".** A path-keyed JSON snapshot is
  auto-written before a reset and restorable in one click, with manual
  Export / Import for portability — wiping the scan no longer loses your donors;
  they re-resolve to the rescanned files by path. (`98308fd`, `e9c8cc5`, `0df3351`)
- **Per-net inline measurements on worklist rows.** Each net row now carries a
  V / Diode / Ω strip where the technician types a reading directly — no separate
  "to measure" list. Values are stored as `NetMeasurement` objects with unit,
  value, timestamp, and source (`user` | `agent`). (`a288871`, `4a73959`)
- **Relay-only AI section.** The AI section in the worklist panel is now a relay
  transcript (messages + prompt box) only — measurement requests that target a
  **net** route to the net row's inline field, while part/pin targets land in the
  relay as a pending row the user answers or skips. (`1b7902c`, `7429650`)
- **Source-agnostic `get_measurements`.** The MCP `get_measurements` tool returns
  all net readings regardless of who recorded them — the technician typing a value
  directly on a net row and the agent requesting it via `request_measurement` both
  appear in the same snapshot. Optional `status` (`pending` | `answered` | `skipped`)
  and `source` (`user` | `agent`) filters narrow the result. (`7429650`)
- **Single off-by-default Highlight toggle.** One **Highlight** button replaces the
  old always-on automatic outlines: when on, worklist parts render in their mark
  colours and any net shared by two or more worklist parts glows; when off, the
  board is unaffected. The Clear button is decoupled from the toggle. (`b200bb6`,
  `85a00f9`)
- **Hydrate-time migration of legacy measurements.** Opening a worklist saved before
  Phase 1 migrates any flat-array AI measurement entries onto the corresponding net
  rows automatically, so existing worklists carry forward without data loss.
  (`7f2e5cc`)

### Fixes

- **Toolbar tooltips no longer spill off-screen.** The top-bar tooltips were
  pure-CSS pseudo-elements that couldn't clamp to the viewport, so buttons near
  the right edge ran off the screen. They're now a single JS-positioned tooltip
  that clamps horizontally and flips above the button when it would overflow the
  bottom; the board hover tooltip also clamps on every edge. (`8e97b36`, `be1c442`)
- **Board info sidebar is drag-resizable.** A left-edge handle resizes the overlay
  sidebar (width persisted to localStorage), its tab labels no longer sit under the
  ☰ toggle, and the redundant `×` close button was removed — the ☰ toggle is the
  single close affordance. (`be1c442`, `8e97b36`)
- **MCP bridge stops when MCP is disabled.** Turning MCP off (or removing it by any
  means) now tears the WebSocket bridge down instead of reconnecting to a dead
  endpoint every three seconds forever; each reconnect re-checks that MCP is still
  enabled before retrying. (`526f0a7`)

## v0.31.25 — 2026-06-24

Smarter schematic lookup, and two fixes that make ASUS laptop `.cad`
boardviews open correctly.

### Features

- **Context-scored schematic lookup.** Double-clicking a component or net to find it in a linked schematic PDF now picks the *best* occurrence instead of the first. A scorer ranks every match by page context (the net/pin labels around it), then designator font size, then on-page proximity — so a large BGA lands on its **schematic symbol sheet** rather than a shared pin/connector index table, even though its reference designator sits far from the radiating net labels. Purely-numeric pin tokens (the sequential 10, 11, 12… a BVR exposes) are dropped from matching since they pack tables and carry no signal; ball-style alphanumeric names are kept. Verified across the 8 largest BGAs on an Apple M1 820-02020. (`9b6996b`, `2bc2cb4`, `84a1548`)

### Fixes

- **ASUS `.cad` boards no longer open as a pile of giant overlapping components.** TESTCAD/IMPACT exports (FA506QR, X415JA, G513IM…) store each part's true position in its shape coordinates and use PLACE only as a tiny nudge — the inverse of the case the shape-recentering logic was built for. Recentering crushed the board to a fraction of its size and left components 5–50× oversized (one part covering half the board). BoardRipper now detects this convention file-wide and skips recentering, restoring the real layout — cross-checked against the FZ export of the same chassis. Clean GenCAD, multi-revision V382, and Quanta files are untouched. (`6310b1a`)
- **ASUS `.cad` boards that froze the tab on open now load.** The same exports re-list each component once per net/device record, so a large BGA listed thousands of times over a full-footprint shape produced millions of phantom pins and exhausted memory (FA506QR ≈ 9.1M pins). Consecutive byte-identical component records are now collapsed to one; genuine multi-revision files are unaffected. (`7e878aa`)

## v0.31.24 — 2026-06-23

Extends the MCP integration with a two-way **worklist AI-mode loop** — an
agent (e.g. Claude Code via the BoardRipper MCP) and the bench technician
collaborate on the same worklist, no in-app LLM required.

### Features

- **Worklist AI-mode feedback loop (agent ↔ worklist ↔ user).** The agent writes worklist entries, marks, and list notes, *requests specific measurements*, and posts relay messages; the user answers (or skips) each measurement inline and types back through a prompt box the agent reads. New live MCP tools — `worklist_get` / `worklist_get_measurements` / `worklist_get_user_messages` (read) and `worklist_add` / `worklist_update` / `worklist_set_list_note` / `request_measurement` / `post_message` (write, gated on the `mcp_drive_ui` toggle) — plus matching bridge dispatch handlers. The WorklistPanel grows an AI section: measurement rows with answer/skip, a relay transcript with a prompt box, and clickable `[n:]` / `[p:]` net/part chips (the `DiagnosisNotes` note renderer is now exported and reused). The `boardripper-repair-helper` skill gains a guided worklist-loop playbook and tool quick-reference. Design spec: `docs/specs/2026-06-16-worklist-ai-mode-feedback-loop-design.md`. (`a2d21b3`, `f77eb38`)

## v0.31.23 — 2026-06-19

BoardRipper can now be driven by an AI agent: a built-in MCP server exposes the
open board — its connectivity, the schematic PDFs, OpenBoardData and the board
database — to Claude Code (or any MCP client), and a bundled repair-helper skill
turns that into a hands-on bench copilot.

### Features

- **MCP server — analyse and drive a board from an AI agent.** A standards-compliant Model Context Protocol server (Streamable HTTP at `/api/mcp`), **off by default**, enabled in a new **Settings ▸ Integrations** tab. 21 tools: PDF full-text search, OpenBoardData diode/voltage/resistance readings, board-reference resolve, and file inventory answered by the backend; plus — over a WebSocket bridge to the board open in your browser — live connectivity (list/inspect nets and parts, pin-to-pin, net-neighbour power-sequence tracing) and **drive-UI** (highlight a net, select a part, flip the side, jump a linked PDF) so the agent narrates *and* shows the answer on your screen. (`74dfdb4`, `6ea651c`, `e742cdf`)
- **Part info over MCP, including descriptions.** `part_info` returns a component's full metadata — value, serial, package, type, side — and a new **`find_parts`** free-text-searches reference designators *and* those description fields, so a component can be located by its real name/number even when no schematic PDF is available. `list_parts`/`list_nets` gained substring/side filters + pagination, and `board_active` reports a generation token so the helper notices when you switch boards. (`b936dc0`, `bf45adc`)
- **Repair-helper skill.** A bundled Claude Code skill (`boardripper-repair-helper`) that turns the raw tools into a structured copilot with playbooks for find-a-component-by-function (evidence order PDF → part descriptions → OpenBoardData → connectivity), power-rail / no-power triage, signal tracing, and short-to-ground hunts. (`b936dc0`, `bf45adc`)
- **One-click connect + OAuth onboarding.** Connect with a bearer token or zero-token **OAuth 2.1** (approve in the browser, nothing to copy). The Integrations tab has per-client connect cards (Claude Code, Claude Desktop, Cursor), a live status line with connected-page and tool-call counts, and a **Test connection** button. (`e9e8556`, `ed9ff71`, `5de9a60`)

## v0.31.22 — 2026-06-18

A theming overhaul: three light themes, an editable custom theme, and a
net-class pin-colour system — all carried by the theme — plus the cleanup
that makes light themes genuinely readable.

### Features

- **Light themes.** Three new themes — Drafting Paper, Daylight and Blueprint (light) — join the dark set. Body text now auto-flips to a dark graphite pair on light backgrounds, the secondary surface/border tiers shade the right direction (lighten on dark, darken on light), and a semantic token layer (scrims, tooltips, hover/active surfaces, highlight washes, the neon binding chips) tracks the theme instead of baking in dark literals. A WCAG visibility test guards every theme against unreadable / white-on-white text. (`5273252`)
- **Custom theme editor.** A single editable theme: tune the interface, the board canvas, the pin-group colours, the net-label styling and the component fills, all in Settings ▸ Theme. Editing any colour while a built-in theme is active forks it into your custom slot (one confirm) and switches to it — built-in themes are never mutated. (`0f80877`, `d8878f1`)
- **Pin colours by net class.** Pin fill colours are now grouped — Power / Ground / Datalines / Logical / Misc — each an editable list of keyword→colour rules (comma-separated, with `*` and `#` wildcards). Analog ground gets its own shade (AGND ≡ VSS), the Misc group is "outline-only" for no-connects, and the whole palette is carried by the theme. Component fill colours and the per-side default pin colour ride along too; the Pad/Body shape columns were retired from the editor. (`1052c3b`, `d8878f1`)
- **Editable net-label background + shadow toggle.** The net-name label background box (previously a hardcoded black at 60%) is now an editable colour + opacity, sitting next to the net-label font colour in the Theme tab. A new "Pin Label Shadow" toggle (Board ▸ Labels) controls the drop shadow on pin numbers and net names — net names were previously always shadowed with no way to turn it off. (`c1be911`, `3c89432`)

### Changes

- **Landrex is a true black-and-white theme.** It now behaves like any other theme (selectable, editable, forks-to-custom) but renders fully monochrome: greyscale pins/parts, no net/component colour, white labels on a black board. Readable — no more white-on-white — and one pin-group edit away from colour if you want it. (`9e3cea6`, `6c22b0b`)

### Fixes

- **Board labels re-tint live on a theme switch.** Switching to a theme that changed no render setting (the light themes) updated the canvas background but left the already-drawn pin/net/part labels their old colour, because the scene rebuild was gated on render-settings the light themes don't touch. (`c269ffd`)
- **Dockview tab strip stayed dark on light themes.** Dockview silently adds its built-in "abyss" theme class, whose hardcoded dark variables out-specificity ours and froze the tab header dark. (`c35f666`)
- **Theme overrides now apply on board load.** A board opened under a saved override-theme (Landrex, or a custom theme carrying pin colours) rendered with un-merged settings until the next theme switch — `setActiveBoard` only recomputed for per-board overrides, not theme ones. (`6c22b0b`)

### Performance

- **Colour editing no longer blocks the UI.** Each colour-picker change forced a synchronous full scene rebuild on every drag-frame; rebuilds now coalesce ~140 ms after the last change and run off the input handler, so the picker stays responsive on dense boards. (`6883f17`)

## v0.31.21 — 2026-06-16

Two features: PDF orientation controls and a diode-value channel for XZZ
boards.

### Features

- **PDF rotation, mirror & page modes.** PDF documents gain per-document 90° rotation (Q/E, or ⌘←/→), a horizontal mirror (⌘↑), and a single-page / continuous page-mode toggle (default continuous; rotation forces single but restores your page mode when un-rotated). Rotation flows through every viewport so fit-width, the click/highlight transform, and the tile grid all adapt; mirror is a wrapper flip that carries the page, highlight, and overlays together. The orientation controls sit just right of the page-switching group, and the board↔PDF link (∞) control now lives in the PDF tab. (`fe6d9f4`, `2de7955`, `8bbed00`)
- **Diode-value channel for XZZ boards.** XZZ "Middle layer diode value" `.pcb` companions carry reference diode-mode readings in a table after the file's `v6` marker; these are now parsed and drawn **directly on the pins** (white, per-pin), with **OpenBoardData** as a second source feeding the same display via each pin's net. Toggle it from the board sidebar's **View** tab (or Settings ▸ Pins); readings also appear in the hover tooltip and the Component Info pin table. The control only shows on boards that actually carry readings. (`3d4b6b6`, `e017f3d`, `1bda8a9`, `fa9513c`)

## v0.31.20 — 2026-06-13

Point fix for the board-side link menu shipped in v0.31.19.

### Fixes

- **Board-tab ∞ link menu opened off-screen.** The dropdown is mounted inside the dockview tab header — a clipped / transformed container — so the in-flow absolute menu was clipped and `position:fixed` resolved against the transformed ancestor instead of the viewport, landing the menu in the wrong place. It now renders through a portal to `<body>` with measured viewport coordinates, so it drops down directly under the icon; outside-click detection checks the portaled node, and it holds off first paint until positioned. Added a geometry regression test (asserts the dropdown box is on-screen and anchored under its button — verified failing on the pre-fix code) since the original `toBeVisible()` probe passed even with the menu off-screen. (`c7bcdc8`)

## v0.31.19 — 2026-06-13

A broad UX pass driven by a six-phase improvement plan plus bench
feedback, layered on top of the library drop-to-incoming and
auto-indexing work. Headline: the in-tab board panel now opens on
component **Info** for single-layer boards instead of the visibility
tab, board↔PDF linking works from both sides, PDF paging and search
stop losing your place, Settings commit behaviour is consistent, and a
clutch of long-standing rough edges (the `vv0.31.x` version badge, the
interface-scale slider jitter, the inconsistent library stats line) are
gone.

### Features

- **Drop-to-incoming with auto-organisation.** Files dragged onto the app are now routed into `incoming/{brand}/{model}/` (with a brand fall-through when the model is unknown), the new row is force-streamed so it appears immediately, and dropped PDFs are auto-indexed for full-text search. The DB folder tree gains a per-folder index button. (`335dec1`, `311a08f`, `49f2a8e`)
- **PDF indexer re-queues on modify + manual Force re-index.** The scanner now marks a PDF pending again when its bytes change, and Settings ▸ Library exposes verbose index status plus a Force re-index control. (`d7e014d`)
- **Board↔PDF linking from both sides.** The ∞ control is now a full link menu on the board tab *and* the PDF toolbar (it was PDF-only); the 5-second auto-close that kept dismissing the menu mid-decision is gone, the unlinked state reads "Link board…", and a "Boardview" section header was added. (`325afda`)
- **PDF paging that keeps your place.** The page-number box commits on Enter/blur instead of navigating per keystroke (typing "250" no longer visits 2 then 25); PageUp/PageDown page even while the search field is focused; new Home/End jump to first/last page; a zero-result Ctrl-F shows `0/0` with a one-click handoff to the library-wide PDF search. (`0495267`, `42a34f9`)
- **'?' shortcut overlay.** Press `?` anywhere to bring the full keyboard-shortcut cheat sheet up over your work — previously it was only visible on the empty home screen. Tab-jump and arrow match-navigation are now listed, and ⌘O/⌘P collapse to one "Open File" row (they open the same picker). (`42a34f9`)
- **Worklist + hidden-parts affordances.** Shift-click add/remove now toasts both directions and only force-opens the sidebar on first use; hiding a part shows an Undo toast and a "Hidden parts (N) / Restore all" row in the Layers tab so a hidden part is recoverable. (`0495267`, `db72f69`)
- **First-contact polish.** The Library boots to the Board# view when history is empty, empty states point at the right action, dropped files that match no parser now say so, and the welcome modal's "Skip for now" no longer means "never again". (`567366a`)
- **Unrecognized files keep their filesystem layout** under a labelled divider in the Board# tree instead of collapsing into one bucket. (`1f66453`, `7a5268f`, `3e57b38`)

### Changes

- **Settings restructured for coherence.** Input/System fields commit immediately (matching the home-screen Quick settings); the Preview/Apply/Cancel footer and Reset render only on the Board tab they govern; the Navigation section now leads the Input tab; the Library tab splits into "Scanning & Indexing" and "Database info"; software-update moved to its own System-tab section with a Check-now button and the drop-to-update recovery note; Library Sync collapses with an on/off summary; settings search shows a "no matches on this tab — N on X" hint. (`98de9d5`, `bb4d2e1`)
- **Single-layer boards open on Info.** The in-tab sidebar now defaults to component detail (Info) on boards with no layer stack, and Layers on multi-layer boards; Info is first in the strip. (`30c1d9a`)
- **SearchTab handles dense boards.** The part/net lists are memoized and capped at 400 rendered rows with an overflow hint, so the search tab no longer janks every keystroke on 5–8 k-part boards. (`f0bf6d7`)
- **Library housekeeping** — stats/progress moved below the search row, scan/index actions moved to Settings, collapse-all relocated to the statsbar, the failed-index modal gained filename + path, brand grouping is case-insensitive with a canonical display label, and the dead "Save as BVR3" toolbar button was removed. (`8e64479`, `48c672f`, `bc49a0b`, `f0bf6d7`)

### Fixes

- **Update badge showed `vv0.31.x`.** The backend version already carries a `v` prefix, so the up-to-date badge double-prefixed it while the update-available path showed it raw — the two never matched. A single normalizer fixes all five display sites (and the dev-build "vdev"). (`325afda`)
- **Interface-scale slider jitter.** The conditional "Reset" button appeared/disappeared as the value crossed 100% and shifted the track width mid-drag. Removed it; reset is now double-click on the slider (which previously did nothing here). (`bb4d2e1`)
- **Library stats line jumped between tabs.** It sat below the filter input, which only renders on non-PDF tabs, so the line shifted up a row on the PDF tab. Pinned directly under the tab row. (`bb4d2e1`)
- **Adversarial-review regressions** from the UX work — board-tab link indicator vanishing when the bound PDF wasn't open, a Settings re-sync subscriber clobbering global slider baselines, a collapsed-only summary chip, split-view scoping of "Restore all", and a stale fixed-position dropdown — all fixed before ship. (`db72f69`)
- **Sorted-section gating** in the Board# tree now requires both brand and model (and `resolution_status === 'resolved'`), and the re-resolve gate triggers on any metadata-field change. (`70433d7`, `0fa860d`, `7005f75`, `73aec8c`)

## v0.31.18 — 2026-06-11

Bigger update than the recent point-releases — covers four areas. The
library-list pipeline was rebuilt around a streaming endpoint with an
IDB chunk cache so opening a 100 k-file library no longer freezes the
UI; the PDF text-click path got a stack of lookup-precision fixes;
holding Space now lets you peek at the other side of the board and
returns on release; the Landrex theme's selection halo behaviour
matches its lower-contrast aesthetic.

### Features

- **Streaming library load with visible progress.** Opening the library on a NAS install with ~80 k files used to block the main thread for several seconds — `res.json()` on `/api/databank/files` parsed the full 50–100 MB payload synchronously, the search input was frozen until the parse finished, and there was no progress UI. New backend endpoint `GET /api/databank/files/stream` emits NDJSON (begin → one file per line → done), the frontend reads via `fetch().body.getReader()` and batches 2 048 rows at a time, yields the main thread between batches, and surfaces a progress strip + counter inside the Library statsbar. Filter input gets a "streaming database from server… 12 k / 80 k" chip so partial-state search is discoverable. ETag/304 fast-path preserved on both endpoints. (`0a61705`, `9ca16b9`)
- **Hold Space to peek at the other board side.** Tap Space still flips top↔bottom permanently (existing behaviour). Hold Space — past a 350 ms threshold — flips while held and returns to the original side on release. Casual taps never trigger peek; the gesture is autorepeat-gated so holding doesn't re-flip every tick, and a window blur mid-hold drops the press state so an alt-tab doesn't strand the next tap. A small floating hint chip ("Peeking other side — release Space to revert") appears bottom-center once the threshold trips, auto-vanishes 3 s in, and is suppressed entirely for taps under the threshold. PDF-panel context (Space → fit-to-width) unchanged. (`ff36fbe`, `47d239f`, `e1f3549`, `5ad47e7`, `da114ee`)
- **Landrex theme — selection halo overlay suppressed.** The yellow halo overlay that lit every pin on the selected net was overpowering against Landrex's lower-contrast pastel palette and made the actual board geometry hard to read. Suppressed in that theme; pin recolouring still runs so the selected net is distinguishable by pin colour alone. (`b291ad5`, `f8ea9b4`)

### Fixes

- **streamChunks auto-commit bug truncated warm load at chunk size.** The IDB cache walk's cursor handler was `cursorReq.onsuccess = async () => { await onChunk(...); cursor.continue(); }`. The `await` created a microtask gap where IDB had no pending request, so the read transaction auto-committed and the cursor silently aborted. `tx.oncomplete` then fired "successfully" with only the first chunk — every warm load stopped at exactly 2 048 files regardless of how many were cached. Made the cursor handler strictly synchronous (no `async`, no `await`, no `Promise<void>` return — and the doc-comment loudly forbids reintroducing them). Added a sticky "Library load incomplete — N of M files" chip with a one-click Reload that bypasses the cache via `fetchFiles({ force: true })` so a torn cache always recovers. (`51ffbfa`, `189acfd`, `07fc4eb`)
- **Rescan no longer leaves the library showing stale data without progress.** Two interacting bugs: `fetchFiles()` coalesces against `_filesInflight`, so the post-scan call was awaiting the pre-scan promise and returning — the post-scan file set never landed. And `_doFetchFiles`'s in-memory shortcut could collide on a signature-stable rescan, skip `libraryLoadStore.begin/setPhase` entirely, and leave the progress strip permanently hidden. Drain the inflight load and null out `_filesComplete`/`_filesSignature` before the refresh fetch in both `_startScanPolling` and `stopScan`. (`7a8db93`)
- **`extractWord` keeps decimal values whole.** Clicking on `0.001Ohm` or `0.002` used to split into `0` and `001Ohm` / `002` because `.` was a hard word boundary. `.` now counts as a word char only when it's a true decimal point inside a number (digits on both sides, digit-run-tail not preceded by a letter/underscore) — so `R5960.3` / `U5960.6` still break at the dot for designator→pin lookups, but `0.001Ohm` stays one selection. Click exactly on the dot of `0.001` also seeds the expansion. (`33e8d20`)
- **`extractWord` keeps digit↔digit space so designator+pin lookups don't fuse.** Adjacent runs like `R5960 1` were fusing into `R59601` for the click-extracted word because the consolidated text-item string lost the visual gap. Preserved the boundary so designator and pin number are separately lookable. (`097bb7c`)
- **PDF click highlight no longer bleeds into the adjacent pin label.** `extractWord` correctly returned `R5960`, but the rendered highlight rectangle was inflated by `pad = 2 / z` pixels on every side plus a 1.5 px border. In dense schematic layouts where the designator and its pin label sit a sub-pixel apart, those extra pixels visibly extended the orange highlight box over the next glyph — looking like the click selected `R5960 1` together. Dropped the horizontal padding so the rect hugs the word's actual extent tight. (`33604a6`)
- **PDF click highlight no longer triggers a parent re-render / focus loss.** Moved the highlight rendering to an imperative path so a single click doesn't propagate through React's reconciliation and blur the focused element. (`112e773`)
- **ODM fallback in the Board# metadata tree.** Files whose `manufacturer` is empty but whose `board_manufacturer` (ODM) was pattern-matched now group under `[ODM] Wistron` / `[ODM] Quanta` / `[ODM] Compal` instead of all piling into one giant "Unknown" bucket. (`189acfd`)

### Performance

- **Folder tree cached in IDB so warm loads are instant.** On a warm reload the file list came from the chunk cache in ~100 ms, but `fetchTree` still hit the network every time — ~700 ms over a typical home/Tailscale link plus JSON.parse on a 2 MB body. Tree now lives alongside the file chunks under the same `last_file_scan_at:count` signature so they invalidate together; the first Folders click writes the response back to IDB and every subsequent visit is instant. Folder-tree fetch also surfaces an indeterminate progress strip during the cold path (no per-row signal available — it's one HTTP call), and prefetches in the background after every `fetchFiles` so the first visit is usually already warm. (`b7541c1`, `c992250`)
- **Streaming-load diff cleanup.** Post-audit pass: drop the dead getRaw/put cache methods, single-tx cursor walks where they're safe to use, parallel stats+meta fetch (saves one RTT on warm TTFB), in-place `delete msg.type` instead of `{ type, ...rest }` per-row spread (≈ 100 k allocations saved per cold load on a big library), backend NDJSON encoder gets `SetEscapeHTML(false)`, and `WHERE file_type IN ('board','pdf')` matches the streaming query to the ETag's count source so the `begin.total` advisory can never overshoot. (`51d2493`)

## v0.31.17 — 2026-06-08

Follow-up to v0.31.16. Same root cause (pdfjs-dist@5 targets a modern V8
baseline the Legacy Mac build's Electron 22 doesn't have), broader fix:
audited every pdfjs reference against Chromium 108 and polyfilled the
full set so this stops being a whack-a-mole.

### Fixes

- **Legacy Mac build now renders PDF text again.** v0.31.16 polyfilled `Promise.try` and PDFs would open — image sprites rendered, but no text. The worker was dying during font / annotation setup on the *next* unguarded modern API. Comprehensive sweep over `pdfjs-dist@5.5.207`'s call sites against the Chromium 108 baseline turned up four more: `URL.parse` (Chrome 120+, 8 sites), `ArrayBuffer.prototype.transferToFixedLength` (Chrome 129+, 4 sites — used for right-sizing font-substitution write buffers), `Uint8Array.prototype.toBase64` and `Uint8Array.fromBase64` (Chrome 140+, used for image data: URLs and XFA payload decoding), plus `Promise.withResolvers` worker-side (Chrome 119+, 14 sites — would have been the very next crash, fires at module init around stream-handler setup). All five shipped as idempotent shims — `src/frontend/src/polyfills.ts` covers the main-thread path; the pdfjs-dist patch's top-of-worker hunk covers the real Web Worker (separate global). `transferToFixedLength` can't replicate detachment semantics from pure JS, so the shim copies; pdfjs drops the source ref immediately either way, so peak memory is unchanged. `toBase64` is chunked at 0x8000 stride to dodge the `String.fromCharCode.apply` argv-length limit on large image buffers. Current Electron 35 (Chromium 134) was never affected by any of these — this is purely the Legacy `BoardRipper-Legacy-macOS-x64-*` zip (Electron 22 / Chromium 108, kept for macOS 10.15 Catalina). (`0691836`)

## v0.31.16 — 2026-06-08

Defensive fix for a PDF crash observed in an older Electron build —
verified against current Electron 35, lands as forward insurance against
future Chromium baseline lag relative to pdfjs-dist.

### Fixes

- **`Promise.try is not a function` no longer kills the PDF panel on older Electron.** pdfjs-dist@5.5.207's worker message-channel dispatch calls `Promise.try(handler, data)` for `RESOLVE` / `STREAM` / `PULL` / `CANCEL` — four sites in pdf.js's own `MessageHandler`. `Promise.try` is ES2025 (Chrome 128+ / V8 12.8+). On older Electron Chromium baselines (the BoardRipper Legacy `.app` shipped earlier this year is one), the first message after worker boot throws and the PDF panel dies on open. Shim added in two places, both idempotent: `src/frontend/src/polyfills.ts` covers fake-worker mode (Electron `file://` runs the worker on the main thread via dynamic import, shares the main global), and a new top-of-file hunk in the pdfjs-dist patch covers the real Web Worker case — main-thread polyfills don't cross the Worker boundary. Current Electron 35 (Chromium 134) was never affected; this is forward insurance against the next pdfjs-dist baseline ratchet. (`4073325`)

## v0.31.15 — 2026-06-07

New top-level interface knob: a global scaling factor that resizes every
chrome surface so the app reads well on dense laptop screens and 4K
displays alike, without touching board / PDF render resolution.

### Features

- **Global interface scaling factor (50–150%).** A new slider, exposed in two places: the **Theme** tab of Settings (after the chrome / accent / background pickers) and a dedicated centred row directly under the welcome banner on the start page. Mechanism: `body { zoom: var(--ui-scale) }` propagates the scale across the React tree and every portal mounted under `document.body`; the two heavy canvas hosts — `.board-panel-canvas` and `.pdf-canvas-container` — counter-zoom via `calc(1 / var(--ui-scale))` so PixiJS and pdf.js keep rendering at their native pixel resolution regardless of the chrome scale. `themeStore.scale` persists under `boardripper-ui-scale`, clamps to `[0.50, 1.50]` in 5% steps, and applies before first paint so a reload doesn't flash at 100%. The slider commits on pointer-up only — the thumb tracks a local draft during drag — so the control doesn't rescale out from under the pointer mid-drag. Electron picks this up for free; the OS-level Cmd/Ctrl +/- still stacks independently. (`0e012ee`)

## v0.31.14 — 2026-06-07

Follow-up to v0.31.13. The load-overlay UI lockout had a second source
on the linked-PDF auto-load path.

### Fixes

- **Linked-PDF auto-load no longer hijacks the board load-progress overlay.** `LibraryPanel.handleOpenFile` auto-loads bound PDFs right after the board fetch completes — and both calls flow through `databankStore.fetchFileBuffer`, which unconditionally fired `loadProgressStore.start()`. The PDF call wiped the board's in-flight state (sitting at "Building scene"), and since PDFs go through `boardStore.addPdf` rather than `loadFile` no one ever called `finish()` for the PDF, leaving the overlay open at "Downloading" until v0.31.13's watchdog fired 30 s later. Gated every `loadProgressStore` call in `fetchFileBuffer` on `file.file_type === 'board'`; PDF / schematic / image / future non-board fetches skip the overlay entirely. (`3304386`)

## v0.31.13 — 2026-06-07

Hotfix for v0.31.12 — multiple users reported the load-progress overlay
blocking the entire UI, including cases where the board was clearly
loaded behind it but the overlay refused to close.

### Fixes

- **Load-progress overlay no longer blocks the UI.** Three compounding problems: the overlay was reusing the self-update modal's CSS (position:fixed inset:0 backdrop-blur z-index 99999), the X / Dismiss button only rendered when the load was `failed`, and there was no watchdog if `BoardRenderer.activateScene` failed to call back into `finishIfMatching`. The overlay is now a non-blocking bottom-right corner panel — `pointer-events:none` on the wrapper, `auto` only on the panel itself — with an always-visible X close button and a 30-second watchdog that force-dismisses on stalled-load state. A legitimate slow load still keeps the overlay open as long as any sub-step (downloading bytes, parser sub-phases, cache write) keeps poking `setPhase` / `setPhaseDetail` / `pushLog`. (`bc0b31f`)

## v0.31.12 — 2026-06-07

Pad geometry pass across every format that exposes it. TVW chamfered
pads draw their real outline, XZZ pads carry net-coloured rectangles
instead of generic circles, 2-pin overrides no longer halo. A clean-up
sweep on XZZ orientation made every X-fold board (A2338, A2681, most
Apple MLBs) display correctly, and the worst-case wrong files now stick
to a manual rotation override. Plus a new toggleable Copper-fills layer
for ground planes, a load-progress overlay so cold opens have feedback,
and the part outline / selection rectangle finally hugs the real pads
on resistor packs and overhanging-pad ICs.

### Features

- **Copper fills overlay (TVW Surface blocks).** New "Show copper fills" toggle in the layers / view sidebar renders ground planes and power pours from each copper layer of a TVW file. Tints with the matching layer colour at 0.25 alpha so the trace network still reads on top of the dim fill. Multi-layer wiring (per-layer container under `surfacesLayer`) follows the same emphasis machinery as traces. (`e96077a`, `2119ccf`, `b012c24`)
- **Per-file rotation + mirror overrides, persisted.** New IndexedDB store (`boardripper-file-view-prefs`) records the user's rotation / mirrorX / mirrorY / flipAxis choices keyed on `${name}:${size}:${lastModified}`. Auto-rotation still runs first, but the saved override wins. The XZZ auto-rotation heuristic gets right for ~all M1 / M2 MacBook boards now (after this release's fold-axis fixes), but a few outliers — A2338, A2681 — needed an extra 180°. Fix once via the rotate-180 toolbar button; subsequent opens auto-apply. Stays per-file so a fix on one MLB doesn't change another. (`79cf870`)
- **Per-file load-progress overlay.** Cold opens (29 MB TVW, encrypted XZZ, etc.) now show phase-level timing: Downloading → Cache lookup → Reading file bytes → Parsing → Post-process → Writing cache → Building scene. Each phase carries elapsed-ms and free-form log entries; the overlay stays open through `buildBoardScene` (where most of the wait sits) and auto-dismisses 1.5 s after the last phase completes. Diagnostic markers inside the scene builder report the cost of surfaces, traces, pads, the parts loop and grid flush so we can localise future slow-loads without re-instrumenting. (`79242de`, `daae3a9`)
- **Re-open-same-file is instant + safe.** Clicking an already-loaded file in the library doesn't re-download or re-parse it — focus jumps to the existing tab and the load overlay dismisses cleanly instead of hanging at "Downloading…" forever. (`a94f55e`)

### TVW + Allegro + XZZ pad geometry

- **TVW pad/pin doubling fixed; chamfered pads render as their real outline.** The earlier doubling artefact — circle pin showing through a copper rectangle on every chip — went away by routing the pin layer through the parser-supplied `pin.padShape` + `padBounds`. Chamfered pads (poly D-code) now trace the actual vertex outline instead of falling back to the rotated AABB; the poly extraction was capturing the wrong centre, fixed by emitting the shape-local verts verbatim. Trace-join `cap: 'round'` doubling at L-bends gone via segment chaining; T- and 4-way junctions still get a small spot, deferred. (`9b8d598`, `c96b280`)
- **XZZ pin emission now carries real pad geometry.** XZZ `.pcb` files expose width/height/shape/rotation per pin in the 0x09 sub-block; previous releases only used them for the `board.pads` overlay, never on the `Pin` itself. Selection halo, pin sprite, and pad overlay now all trace the same outline. (`1fc462d`)
- **2-pin parts (caps / inductors / resistors) honour the real pad rectangle.** Synthesised FlexBV-style rect was wider than the real SMD pad on every TVW/Allegro/XZZ file, so the rect poked out as a halo around the pad overlay. Pin loop now uses `pin.padBounds` for 2-pin geometry when supplied, falls back to FlexBV synth for BVR/BDV/CAD/Mentor. (`e41a379`, `9cd6638`)
- **2-pin pad overrides (per-type `padShape: 'round' / 'square'`) no longer halo.** Same fix as the natural path — the override branches were still sizing themselves from the synth-FlexBV `eb` rect, so any override on a 2-pin part recreated the doubling. Refactored so the pad rect comes from `pin.padBounds` regardless of which shape variant gets drawn. (`9cd6638`)
- **Pads-off restores the classic FlexBV circular pin look.** Reversing the earlier "pin always draws pad shape" decision: pin sprite is a classic circle inscribed in `min(padW, padH)/2`. Pad overlay sits ABOVE the pin and covers it when toggled on; selection halo follows whichever shape is currently visible. (`e865353`, `cce8d9f`, `1720872`)
- **Pad overlay z-order + colouring overhaul.** Pads draw BELOW the pin layer on multi-layer boards (so net-coloured pins win) and ABOVE on single-layer XZZ; in both cases pads are now coloured per-net (via `resolvePinColor`) instead of the uniform warm-copper that hid GND/VCC distinctions on every file. Single-layer XZZ no longer skips the pad layer entirely — that was a regression from a partial-fix that hid the sidebar's Pads toggle. (`335e8a4`, `b35e654`, `5a7e664`)
- **Pad toggle is instant.** Earlier intermediate state baked the pin sprite shape into the pin Graphics at build time, so toggling pads triggered a full scene rebuild. The current implementation pre-builds inscribed-circle pins once and just flips `padsTop.visible` / `padsBottom.visible`. (`1720872`)
- **Part outline + selection rectangle include real pad extents.** `computeEffectiveBounds` was using the AABB of pin CENTRES only, so RP-series resistor packs and other parts with pads overhanging the pin centres had their outline + selection halo cutting through the pads. Now union of `pin.padBounds` first. Parsers without per-pin pad bounds (BVR/BDV/CAD/Mentor) hit the union as a no-op; identical to pre-fix. (`c05e5bc`)

### XZZ orientation

- **Every X-fold XZZ board has been rendering horizontally mirrored.** Root cause: the original X-fold patch (`e72a562`, March) set `tab.mirrorY = true` on load to compensate for the renderer doing the unfold. The parser has since fully unfolded the bottom half inline (`p.x = 2 * fold.axis - p.x`), so the leftover mirrorY became a free Y-flip. With 270° auto-rotation applied to tall boards (every X-fold result is tall), the Y-flip rotated into screen-X. Dropped the auto-mirror in all three sites — cache-load, fresh-parse, and `syncMirrorsToDerivedFold`. Y-fold boards (820-02016) were getting no auto-mirror in the load paths and displaying correctly; both fold types now match. (`d989252`)
- **X-fold boards land 180° off after the mirror removal; fixed by branching auto-rotation.** Removing `mirrorY=true` un-mirrored them but every X-fold board then sat 180° rotated from where the user expects to see it. The parser's bottom-half X-flip leaves the geometry in a frame where 270° auto-rotation (standard for tall flipY formats) maps the screen's top 180° from the board's top. `computeAutoRotation` now returns 90° for X-fold + flipY (vs 270°). Y-fold path unchanged so 820-02016 still lands correctly. (`3d0ae42`)
- **Axis-aligned chips with diagonally-oriented pads no longer get diagonal outlines.** XZZ pad-angle-majority detection (commit `3fea5ad`, May) was firing on chips whose pads are drawn at 45° but whose body sits straight on the board — UN/UF/UR/U-series ICs on A2442 and 820-02016. Added a perimeter test mirroring `computeDiagonalOBB`'s axis-aligned guard: if pins on both a horizontal and a vertical AABB edge, the chip is axis-aligned regardless of what the pad angles say. (`7146246`)
- **Perimeter guard tightened to actually catch BGAs.** The first cut required ≥40% of pins on the AABB perimeter — fine for small chips, fails for big BGAs where most pins sit inside the grid (UN000 has 25%, UF500 27%). The `hasH && hasV` check (≥2 pins on horizontal AND vertical edges) is geometrically enough — a true 45°-rotated chip touches the AABB only at four vertex pins (one per side, `onL=onR=onT=onB=1`) and that fails `hasH/hasV`. Dropped the threshold. (`1a9ec35`)

### Other fixes

- **Selection halo for pads-off matches the pin sprite.** Selection redraw path was always using `drawPadShape` when pins had `padBounds`, so clicking a pin under "Show pads off" snapped the halo to the pad outline — visually "revealing" the pad the user had just hidden. Gated on `boardStore.showPads`. (`cce8d9f`)
- **`board.surfaces` survives the IndexedDB round-trip.** `SerializedBoardData` schema never learned about `surfaces`, so first load populated them in memory (Copper-fills toggle visible) and every subsequent cache hit dropped the field (toggle gone). Three lines: add the field to the type, serialize, deserialize. `PARSER_VERSION 68→69`. (`2119ccf`)
- **pdfindex per-file failures log path + concrete cause.** Earlier `INFO[pdfindex] file extract failed` lines didn't say which file or why; now both surface so a user with a single broken PDF in a 200-PDF library can identify it instead of grepping warnings. (`49b04d2`)

### Internal

- **PARSER_VERSION 67 → 72** across the release: 67→68 (TVW poly polygons), 68→69 (cache surfaces), 69→70 (XZZ debug probe), 70→71 (axis-aligned chip guard v1), 71→72 (guard v2 dropping onAny). Each bump invalidates entries that baked stale derived state into IndexedDB; first open after upgrading re-parses, subsequent opens hit cache normally.

## v0.31.11 — 2026-06-06

XZZ pass: the parser now extracts the geometry that was sitting
unread in every Apple boardview — real pad shapes, per-part silkscreen
outlines, via drills — and renders rotated chips with rotated
outlines instead of axis-aligned boxes that miss the body. Plus an
issue-#19 UX fix so a PDF-driven selection respects your dim
preference.

### Features

- **Real pad geometry from XZZ pin sub-blocks.** Previously framed as "no pad polygon data" — wrong. The pad rectangle (width, height, shape byte, rotation) is in the variable-length region of the 0x09 pin sub-block past the pin name; the old parser read four fields and skipped 32 bytes of "unknown" data which turned out to be three repeated copies of the same (u32 w, u32 h, u8 shape) chunk, with rotation 8 bytes earlier. A2442 mainboard yields 20,046 pads (8,620 round BGA balls + 11,426 rect SMD) feeding the existing `showPads` toggle. Pin radius now scales to `min(padW, padH)/2` so N4090's 2,971 SoC balls draw at their real 6.75 mil instead of the hard-coded 8 mil that drew dots over real pads. `PARSER_VERSION` bumped 66→67 so stale caches don't hide the change. (`aed68a5`)
- **Per-part silkscreen outlines.** Each XZZ part block carries four 0x05 sub-blocks on layer 17 — the four edges of the silkscreen rectangle drawn around the component. The parser emits them as four 2-point `SilkscreenPath`s tagged with the part's side; the existing silkscreen overlay renders them. The chip-side rectangles now match real PCB silkscreen, not just an inferred bounding box. 17,428 per-part paths on A2442. (`7d7c72d`)
- **Board-wide silkscreen routed to the overlay.** Top-level layer-17 segments (board logo art, polarity dots, the legacy print on every board) now flow into `board.silkscreen` instead of being discarded. Chained via `chainByComponent` so the sparse art renders with few GPU draw calls. (`33c8184`)
- **Via blocks (drill + annular ring + net).** 0x02 sub-blocks parsed: 17,273 vias on A2442 with diameter and net. The renderer's via overlay matches connected layers to nearby trace endpoints regardless of the layer-pair field (which is flag-coded `1, 5` on every surveyed Apple file with no observed variance — blind/buried stack-ups unrecoverable until a counter-example shows up). (`e365add`)

### Fixes

- **Rotated XZZ chip outlines follow the chip, not the AABB.** A 45°-rotated multi-pin chip (e.g. N3842 on A2442 — a 19-pad diamond) was drawn with an axis-aligned selection box because `computeDiagonalOBB`'s area-saving gate rejected the OBB: scattered thermal pads at the centre and a single "wing" pin at the AABB edge inflated the rotated rectangle until it saved less than 30% over the AABB and the gate fell through to the rect fallback. The format already records rotation per pad; on a tilted chip every pad's angle (mod 90°, since rectangles are centro-symmetric) lands in the same bucket. The parser now resolves that bucket once and stashes it on `Part.angleDeg`. `computePartRenderPoly` projects pins onto the recorded axis directly when set, bypassing PCA. `board-scene`'s per-part border path flows through the same wrapper so the always-on body rect picks up the same OBB as the selection highlight. Detection gated on ≥70% pad-angle agreement so a chip with one oddly-rotated annotation pad still flips through, but a chip with a single rotated pad on a straight body doesn't get falsely tilted. (`3fea5ad`)
- **XZZ file-wide X-mirror after butterfly fold.** A whole class of Apple files came out X-flipped on the screen after the butterfly unfold. The pin-direction detector now runs after the fold and corrects, so the file-wide orientation matches the physical board. (`56cdd26`)
- **XZZ mirror axis after renderer auto-rotation.** Vertical-oriented XZZ files that the renderer auto-rotates 270° were mirroring on the wrong axis (X-mirror on screen instead of Y-mirror, or vice versa) after the rotation swapped scene and screen axes. The mirror now picks the correct axis post-rotation. (`c8fdb42`)
- **PDF-driven selection respects `dimMode=off` (#19).** The Auto-dim-on-search switch (default ON) was overriding an explicit per-tab `dimMode=off`: clicking a designator in a PDF lit the full dim overlay even when the user had explicitly disabled dimming for that board. The auto-dim rule now only *promotes* a view that's already dimmed (Dim or Darklight); it never introduces dim against an opt-out. No setting migration needed. (`df04f73`)

## v0.31.10 — 2026-06-05

Hotfix for v0.31.9 — opening a PDF while 2-Window Mode was already on
silently added it to the popout but didn't raise the popout window, so
the user looking at the main window saw nothing happen.

### Fixes

- **2-Window Mode: focus the popout when adding a PDF to an existing group.** When mode is ON and a popout already exists, `ensurePdfPanel` correctly drops the new panel into the popout group as the active tab — but Chromium does not raise the popout's window automatically, so the user sees no visible change in the main window and concludes the open didn't work. Fixed by calling `popoutGroup.api.location.getWindow().focus()` after the addPanel call. The lazy-popout path (no existing popout) already raises naturally via `window.open()`. Added E2E B8 covering "second PDF while popout exists" with an active-tab assertion. (`ba82ddf`)

## v0.31.9 — 2026-06-05

2-Window Mode: a single toolbar toggle that pops the entire PDF group
out into its own browser/Electron window so the board can live on one
display and the schematic on another, with the click-board → jump-PDF
link still working across windows.

### Features

- **2-Window Mode toggle.** New toolbar button (next to the sidebar/library toggle, labelled "2 window mode") detaches the PDF Dockview group into a separate OS window. Library + BoardView stay in the main window. Toggling off re-docks the PDF into the main grid; closing the popout window via the OS close button does the same and flips the mode off. Persisted to localStorage so the preference survives reloads — the first PDF you open in the new session reopens in a popout automatically. Icon flips between `IconLayoutBoardSplit` (single-window, internal splits) and `IconBoxMultiple` (multiple stacked windows) to communicate state. (`6a8f7d2`, `8e3963e`, `6fa6069`, `f69e011`, `cccd299`, `193cb52`, `f726735`, `9bae652`)
- **Link maintained across windows.** Because Dockview popouts share the parent's JS context, the existing board↔PDF click-to-jump, BindLink dropdown, PDF↔PDF cross-link, and auto-switch-linked-panel behaviour keep working with no IPC. Clicking a designator on the board (main window) still jumps the PDF in the popout. Mode is symmetric across the browser build and the Electron desktop app — same primitive on both. (`6fa6069`, `cccd299`)
- **Cross-window plumbing.** Theme classes on `<body>` mirror into every popout window via a `MutationObserver`, so accent/dark-mode changes propagate without a manual refresh. Global keyboard shortcuts (Cmd-F, etc.) attach to every popout's document via a 500 ms poll so they fire when focus is inside the detached window. (`fe56c12`, `8b549c3`)
- **Electron child-window chrome.** `mainWindow.webContents.setWindowOpenHandler` overrides the spawned BrowserWindow's options so the PDF popout has a native title bar ("BoardRipper PDF"), no application menu, the BoardRipper icon, and the same preload script as main. `popoutUrl` is set to a relative path (`popout.html`) so it resolves correctly under both `http://` (browser dev) and `file://` (packaged Electron). (`cccd299`)

### Fixes

- **Redock must not destroy the pdf.js document.** `App.tsx`'s `onDidRemovePanel` handler calls `pdfStore.closeFile()` plus board-binding cleanup whenever any `pdf-*` panel is removed — designed for the user clicking the panel's X. But the 2-Window-Mode redock path uses `panel.api.close()` purely as a move-mechanism (Dockview's `panel.api.moveTo` only accepts a target group, and there isn't always a same-window PDF group to move into). That fired the same cleanup, destroying the pdf.js doc and clearing bindings, so after toggling off the panel came back but rendered empty. Fixed via an `isRedockingPdf(name)` predicate exported from `dockview-api.ts`; the panel-remove handler short-circuits cleanup while a name is in transit. Both the drag-drop and file-picker open paths flow through the same code, so both are covered. (`90d498c`)

### Cleanup

- **Worklist button removed from the toolbar.** It's still reachable through the sidebar tabs and the keyboard shortcut; freeing the toolbar slot lets the new 2-Window toggle sit next to the sidebar/library toggle without crowding. (`193cb52`)

### Tests

- **17 new tests in `tests/two-window-mode.spec.ts` + `tests/two-window-mode-store.spec.ts`.** Cover sections A (toggle state machine + multi-PDF migration), B (lazy popout), D (window-lifecycle: OS-close, reload-with-mode-on), H (persistence + corrupt-localStorage), I (mixed-group safety: non-PDF panels parked in a PDF group stay in main), J (mode-OFF regression). PDF fixtures generated in-memory via `pdf-lib` so the suite runs without `samples/`. D13 uses `popup.evaluate(() => window.close())` instead of `popup.close()` to reliably fire the `beforeunload` event Dockview hangs the popout-close chain off. (`f0f75d2`, `e05d5ad`)

## v0.31.8 — 2026-06-03

PDF open path broken on older browsers — single-edit hotfix to the
vendored pdf.js worker.

### Fixes

- **PDF `loadFile failed: hashOriginal.toHex is not a function` on Chrome < 136 / Firefox < 132 / Safari < 18 and legacy Electron forks.** pdf.js 5.5 calls `Uint8Array.prototype.toHex` (Chrome 136+) directly inside the worker's `fingerprints` getter, and `Map.prototype.getOrInsertComputed` (Chrome 134+) in 5 places across font/AcroForm/XFA caches. The main-thread polyfills in `pdf-store.ts` don't cross the Web Worker isolation boundary, so every PDF open crashed on those clients. The vendored-pdf.js patch (`patches/pdfjs-dist+5.5.207.patch`) now prepends an idempotent shim block to `pdf.worker.mjs` covering both methods. Electron and modern Chromium are unaffected (the `typeof !== 'function'` guard keeps native impls). Sixth edit added to the existing patch; `patches/README.md` updated.

## v0.31.7 — 2026-06-03

Settings panel cleanup pass plus a new global search inside Settings.
Mechanical-part auto-detection extended and made calmer. Desktop
artifacts now mirror to ripperdoc.de alongside the landing-page rework.

### Features

- **Settings search.** Top-of-panel filter box (or press `/` to focus) that lives-filters every Slider, Toggle, section heading, and subsection by label + tooltip + curated keyword synonyms. Tab pills show per-tab match counts so cross-tab discovery works; sections with no matches hide; sections matched by name auto-open and show all their controls. Esc or the ✕ button clears. (`95fb2a7`, `fa2781f`)
- **Net-line colour chain.** Net Lines section exposes the primary and chain-adjacent colours as a two-swatch row `[primary] → [adjacent]`. Both fields were already read by the renderer but had no UI. (`27dae0e`)
- **Min Label Size — single slider.** The four-control "Active Size S/M/L + three tier sliders" apparatus collapses to one "Min Label Size" floor. Migration picks whichever tier was active and assigns its value to the new field so previously-tuned settings carry across the upgrade. (`2db9073`)
- **Mechanical parts: auto-skip body fill.** EMI shields, heatsink frames, and oversized through-hole connector shadows are now auto-detected (footprint contains ≥5 other component origins, description mentions SHIELD/HEATSINK/FRAME, or trailing-dot duplicate set) and rendered without a body fill so the smaller components beneath stay visible. Border outline and pins still draw normally. Right-click any part for a per-component override. `PARSER_VERSION` bumped so stale IndexedDB caches don't hide the change. (`ca318e9`, `a5eebe8`, `415b4de`)

### Cleanup

- **Settings tooltips and section labels.** Label Atlas Resolution default tooltip fixed (8, not 12). PDF Pan Boundaries default tooltip fixed (true, not OFF) — and the toggle moves out of [Debug] into PDF Viewer ▸ Navigation. "Pin Colors by Net" section renamed to **Pin Color Rules** so the name no longer collides with the new net-line colour chain. Dead `selectionHalo` field dropped. (`d0b9ebe`)
- **Board fill controls united.** "Use board metadata color" toggle moves from Theme tab into Board ▸ Board Outline, sitting next to the Board Fill alpha slider it was already paired with semantically. (`d0b9ebe`)
- **Library tab visual unification.** Library Folder & Database, Library Sync, and OpenBoardData now all use the same collapsible-chevron treatment instead of three different visual shapes. (`e53fd6c`)
- **HomeBackdrop cache controls removed.** Settings is the single source for cache wipes; the Quick settings card no longer carries a parallel set of buttons. (`d0b9ebe`)

### Infra

- **Desktop zip mirror on ripperdoc.de + landing-page rework.** Desktop artifacts now publish to the public mirror alongside the signed update pipeline; landing page restructured for the new format. (`47154eb`)

## v0.31.6 — 2026-05-31

Worklist gains first-class net support — pin a net to a worklist from
the search tab or right-click, mark it short/solved/absent, optionally
flag it with the lightning-bolt surge tag.

### Features

- **Pin button on every search result row.** Each component AND net row in the sidebar Search tab now has a trailing `IconPin` button (turns into `IconPinFilled` + accent tint when already pinned to the active worklist). Clicking pushes the item to the active worklist, auto-creating one if none exists. Click stops propagation so the row's existing focus action still fires when you click the body. (`ebb88a4`)
- **Nets are first-class worklist entries.** The `Worklist` data model gains a `netEntries: NetWorklistEntry[]` array parallel to the existing parts list; old persisted records hydrate with `[]` (back-filled in `resolveEntries`, no schema migration). Each net entry carries a `mark`, `note`, and an optional `surge` flag — the signal analogue of `waterdamage`, indicating an over-current / ESD event, displayed as a lightning bolt. A subtle "Nets" sub-heading separates the two sections in the panel when both are populated. (`ebb88a4`)
- **Net-specific mark vocabulary: short / solved / absent.** Separate `NetWorklistMark` type, not the part `replaced/reworked/cleaned` vocab — those describe physical actions on a component and don't map onto a signal. Short = fault identified (red `IconAlertTriangle`); solved = resolved (green `IconCheck`); absent = net not present / not reaching (slate `IconUnlink`). The type system prevents the part vocab from leaking into a net entry. (`bdc0552`)
- **Right-click pin a net** — the net chip in the board context-menu header now carries the same `IconPin → IconPinFilled` toggle as the component chip. Click to add the net to the active worklist; click again to remove. Auto-creates a worklist on first use, opens the Worklist sidebar tab, and surfaces a toast. (`bdc0552`)

### Internal

- New store API: `pushNets`, `pushNetToActive`, `removeNetEntry`, `setNetMark`, `setNetNote`, `cycleNetMark`, `toggleSurge`. Parallel to the existing part-side methods. Net names are case-canonicalised against the loaded board on push so the entry stays in sync with the board's casing. (`ebb88a4`)
- New `NET_MARK_*` tables in `WorklistPanel.tsx` (`NET_MARK_ICON`, `NET_MARK_SHORT_LABEL`, `NET_MARK_TITLE`, `NET_MARK_BTN_COLOR`) mirror the existing part-side tables. `WorklistNetRow` is structurally identical to `WorklistRow` apart from the icon set + handler routing. (`bdc0552`)
- New `qa-worklist-net` testid on the context-menu net chip parallels the existing `qa-worklist-part`, enabling future regression tests to assert against the net chip independently. (`bdc0552`)

### Known limitations

- **Canvas highlight for worklist net entries is not yet wired**. The current `multiHighlightGfx` system only paints part outlines. Layering a worklist-net highlight on top of the existing single-`highlightedNet` machinery without colour collision is a larger refactor — net worklist entries are panel-only for this release. Clicking a net-row in the worklist focuses the net via the standard `focusNet` path, which respects the user's Zoom Mode setting from v0.31.5.

## v0.31.5 — 2026-05-30

Sidebar Search tab redesign, configurable navigate-to-component zoom, disco
mode polish, and a green-CI cleanup that knocked 91 lint warnings off the
codebase. Same-day follow-on to v0.31.4.

### Features

- **Sidebar Search tab is now usable as a navigation panel.** Sections (Components / Nets) and expanded spoilers stay sticky at the top of the scroll container so you can collapse them from anywhere in the list. Component rows expand to show every net the part touches, sorted by the first pin that hits it (mirrors the existing net→components sublist). Both sublists now show the connecting pin id as a compact monospace chip. Net rows in the Nets section now navigate (zoom/pan) on click; previously they only highlighted. Row spacing tightened (28→22 px). Chevrons upgraded to Tabler icons at 18 px so the expand affordance is actually visible. Expansion is decoupled from `boardStore.selection` so clicking a net inside an expanded component (or vice-versa) no longer collapses the spoiler. (`2893d19`, `9e9145c`)
- **New Settings ▸ Navigation ▸ Navigate-to-component controls.** Two new knobs that affect every navigation entry point (sidebar Search, standalone Search panel, Worklist, NetList, NetsDropdown/PartsDropdown, PDF cross-target click): (`845b0a0`, `e483f6b`, `44b3a0b`)
  - **Component Size** (0.05–0.90, default 0.25) — fraction of the smaller viewport dimension the component should fill after navigating.
  - **Zoom Mode**: *Auto* (default) keeps the current zoom when the part lands in the 1.5%–70% comfortable band and snaps only when extreme; *Keep* never changes zoom, just pans; *Always* snaps to Component Size on every click.
- **Disco mode peak alpha is now 1.0** — at the top of each heartbeat the part is solid red, then fades back out over the silent 70% of the cycle. Reads as an actual blink instead of a faint tint. (`e134f4b`)

### Fixes

- **Removed the 3× fit-to-board relative cap inside `zoomToBounds`** that silently clipped `navTargetSize` on small boards. Caught by a new Playwright test (`tests/nav-target-size.spec.ts`) which failed on first run with `scaleSmall === scaleLarge` even with the target doubled in *Always* mode — the cap was masking the setting. Kept only the 6× absolute ceiling. (`e483f6b`)
- **Ghost button icon set is now consistent across all three states.** Previously the *off* state used `IconGhost3` (a stripped-down ghost with no smile), which read as a different shape vs the *on* state's `IconGhost2`. Now uses `IconGhost2` for off/ghosts (off conveyed purely by the absence of `.active` — no slash/strikethrough variant) and `IconGhost2Filled` for disco (the existing `.disco-active` hue-rotate animation gives it the flashing-ghost feel). (`e135e11`, `7b0e420`)
- **autoZoom too-small threshold lowered from 5% to 1.5%** of the smaller viewport dim. At fit-to-board zoom on a typical 100 mm board, even mid-sized ICs land below 5% of screen — so the old threshold caused *Auto* mode to fall through to the *Always*-snap branch for almost every click, defeating the point. New threshold means only sub-pixel passives trigger a zoom-in; mid-board ICs stay at the user's current zoom and just pan. (`44b3a0b`)

### Internal

- **CI is green again** for the first time since v0.31.0. Two `react-hooks/set-state-in-effect` errors (in `FZKeyDialog.tsx` and `WorklistPanel.tsx`) and an orphan `computeFitToBoardScale` had been silently failing `lint-and-typecheck` for ~7 days. Releases worked because the release pipeline doesn't depend on CI; user testing surfaced it. (`b9ffb09`, `7b0e420`)
- **Lint warning sweep: 103 → 12** via four parallel agent passes covering non-overlapping scopes (test specs / PDF subsystem / sidebar+toolbar / panels+renderer). Highlights:
  - 4 real React 19 *"ref accessed during render"* bugs fixed in `SettingsMockup` and `SettingsPanel/PartTypeRow` — the ref pattern was rewritten using React's official "previous-render state" pattern (`useState` + render-time comparison + `setState`).
  - 9 stale-closure dep bugs in `PdfViewerPanel` callbacks (`syncTransform`, `rescaleWrapperChildren` missing from `useCallback`/`useEffect` arrays — real correctness issues, not just lint noise).
  - 3 new sibling files extracted from oversized components: `Sidebar.utils.ts`, `BoardSidebar.utils.ts`, `panels/board-viewer-bridge.ts`.
  - All `any` casts at pdf.js boundaries replaced with structural `as unknown as { ... }` casts; pdf.js / type-decl mismatch documented inline.
  - 12 remaining warnings are all `react-refresh/only-export-components` (helpers exported alongside React components in three panel files) — pre-existing structural refactor, out of this round's scope. (`2016512`)
- **New Playwright test** `tests/nav-target-size.spec.ts` exercises (a) `Always` mode + `navTargetSize` change → proportional viewport scale change, and (b) `Keep` mode preserves scale across navigate. Exposes a `__renderSettings` window hook in DEV builds alongside the existing `__boardStore` / `__boardRenderer`. (`e483f6b`)

## v0.31.4 — 2026-05-30

Two new things you can play with: an interactive first-run gesture setup, and a
disco highlight mode on the ghost-toggle button that pulses every same-net part
red on both sides.

### Features

- **First-run "Set up by gesture" interactive welcome.** A modal walks you through four bindings (Board Pan/Zoom, PDF Pan/Zoom) by asking you to *demonstrate* the gesture you want in a shared test window — scroll, swipe, pinch, or drag is detected and bound via `recommendSetting`. The opposite action auto-fills, then it advances to the next surface. OS-momentum is detected live so BoardRipper's own glide stays OFF when your trackpad already provides inertia (no compounding). Re-openable from the start page's Quick settings ("Set up by gesture (interactive)"). The Playwright suite isn't affected — auto-show is suppressed under `navigator.webdriver`. (`5c06d4d`)
- **Disco highlight mode on the ghost button.** The hidden-side ghost toggle is now a three-way cycle: off → ghosts → disco. In disco mode every part on the highlighted net (both sides) heartbeats red — a body-fill flash + outline ring tied to a threshold-clamped sine so ~70% of each second is silent and only the top ~30% blooms. Same-net only; no selected net means no halo. The button hue-rotates while active, and the animation is disabled under `prefers-reduced-motion`. (`76701ce`, `3294553`, `82d3085`, `228a841`, `ee14b99`)

### Fixes

- **Start-page supported-formats list now matches the parser registry.** The list previously claimed `.xzz` (wrong — XZZ PCB is `.pcb`) and omitted `.bv`. Updated with dual-purpose notes for `.brd` / `.cad` / `.bdv`. (`5c06d4d`)

### Internal

- **Verbose Debug-panel gesture recognizer** kept alongside the welcome modal for research: raw event dump, classification reasons, momentum stats, per-gesture confirm-and-apply. `recommendInertia` direction stays in lock-step with the welcome checkbox semantics. (`5c06d4d`)
- **Renderer refactor:** `expandPoly` / `drawPoly` / `drawPartOutline` are now module-level so cross-side ghost + disco halo share the part-shape primitive instead of open-coding the poly/AABB dichotomy. Introduced a `GhostMode` type alias to replace the inline `'off' | 'ghosts' | 'disco'` union across the seven sites that referenced it. (`aa10364`)
- **Disco silent-phase short-circuit:** `renderDiscoHalo` skips path building during the ~70% silent window of each cycle and only fires `needsRender` on the transition into silence, tracked via `discoHaloDirty`. The ticker now gates `renderNetLines` on `netLineMode !== 'off' && highlightedNet`, so disco-only frames don't pay for a net-line clear. (`aa10364`)

## v0.31.3 — 2026-05-29

A roundup release: new multilayer trace-layer controls, PDF viewer default and
zoom refinements, two format-robustness fixes (PADS rejection, TVW parts
recovery), and a batch of audit-driven backend/UI hardening.

### Features

- **Multilayer trace layers — bump/pin a layer to the top, and reveal it on select or pin.** On butterfly/multi-layer boards you can promote a copper layer above the others; selecting or pinning a layer now reveals it (a bare select reveals transiently, only a pin flips its persistent visibility). (`67dcd9c`, `b2a0e09`, `85b2650`)
- **PDF viewer defaults: Pan Boundaries ON and Standard render mode out of the box**, with zoom locked to fit-width while Pan Boundaries is active so the view can't bounce off the page edge. (`1b50386`, `c965a31`)

### Fixes

- **Mentor PADS Layout binary `.pcb` files are now rejected with a clear message** instead of the cryptic `XZZ: invalid header offsets`. The `.pcb` extension is shared with the supported XZZ boardview format; PADS Layout's native binary database (magic `00 FF 26 20`) is detected and refused up-front. (`43b7d64`)
- **TVW: recover the parts list when the probe/fixture skip overshoots.** On some Landrex/Gigabyte boards a probe body declared a garbage element count, running the parser cursor to EOF and silently dropping every component (board opened with copper but no parts/pins/nets). A parts-section scan now relocates the list — the same recovery the net table already uses. (`315e0ae`)
- **Renderer: type-hidden parts are truly hidden, and the MEC shield ref-designator prefix is handled.** (`d0136ec`)
- **UI hardening: AZERTY keyboard shortcuts, a panel error boundary, and a unified ComponentInfo** across its two render sites. (`ac94e40`)
- **Backend: update-progress no longer 500s** (gzip Flusher/SSE fix), plus exact-byte content dedup and zero-byte-file skip during scans; BOM reason labels de-duplicated. (`deb43ef`, `42c2d22`)

### Internal

- **DevOps/CI:** `.dockerignore`, CI Go 1.25, release-signature self-verify, and a native-amd64 boot smoke-test gate before publishing. (`271ea48`, `048f33e`)
- **Tests/docs:** XZZ parser spec with sample-fixture skip-guards; documentation corrections (watermark terms, deps, store names, boards.db). (`da41437`, `657a9cf`)

## v0.31.2 — 2026-05-26

The real fix for the v0.31.0 update failure. v0.31.1 turned out to address the
wrong cause — this release makes the update actually succeed on installs with a
large existing library. As before, no install was harmed: the orchestrator
healthcheck rolled every failed update back to the prior working version.

### Fixes

- **Fix update rollback on installs with a large pre-v0.31 PDF index.** The v0→v1 pdf-index migration drops the legacy in-process `pdf_text` (FTS5) / `pdf_pages` tables, whose content moved to the separate `pdfindex.db`. On a populated library that drop (a) opens a SQLite *statement journal* — but the scratch image has no `/tmp` and the runtime CWD `/` isn't writable by UID 65532, so SQLite returned `SQLITE_IOERR_GETTEMPPATH` (`disk I/O error (6410)`); and (b) frees hundreds of thousands of pages, taking ~60 s — which blocked `/api/health` past the updater orchestrator's 60 s healthcheck and got the update rolled back. Two-part fix: point SQLite's temp files at the always-writable data volume (`SQLITE_TMPDIR=/data`), and split the migration so only the fast `pdf_donors` table is created on the boot path while the heavy legacy-table drop runs in a background goroutine after the server is serving. Boot-to-health on a real 1.5 GB database dropped from a rollback-inducing >67 s to 24 s. Verified against a copy of the real failing database on amd64 hardware. (`7da5bc3`)
- **Note on v0.31.1:** its `modernc.org/sqlite` bump (v1.34.5 → v1.50.1, for Go 1.25) is retained as worthwhile dependency hygiene, but it did **not** fix the boot failure — both v0.31.0 and v0.31.1 failed identically on a large database. The cause was the temp-dir / migration-timing issue fixed here, not the SQLite driver version.

## v0.31.1 — 2026-05-26

Hotfix for v0.31.0, which failed to boot on `linux/amd64`. No user was left
stranded — the orchestrator's healthcheck rolled every failed update back to the
prior working version — but v0.31.0 could not be installed. This release makes
the update succeed.

### Fixes

- **Fix boot failure: `Failed to open databank: unable to open database file: out of memory (14)`.** v0.31.0 bumped the Go toolchain to 1.25 (required by the new pdfium/wazero PDF indexer) but left `modernc.org/sqlite` pinned at v1.34.5, whose transpiled libc (v1.55.3) was generated for Go 1.21. Under the Go 1.25 runtime its memory layer failed at the first `mmap`, so SQLite could not open `databank.db` and the server exited before serving `/api/health`. Bumped `modernc.org/sqlite` to v1.50.1 (libc v1.72.3, regenerated for Go 1.25), kept in lock-step with the `golang:1.25` build image. Verified by an isolated `linux/amd64` boot test on real hardware. (`c4e2482`)
- **Build backend by cross-compiling per `$TARGETARCH` from `$BUILDPLATFORM`** instead of QEMU-emulating the target toolchain during multi-arch buildx — faster and removes an emulation variable from the build. (`c4e2482`)

## v0.31.0 — 2026-05-26

Library-wide PDF full-text search rebuilt on a real backend index, automatic
content-deduplication folded into the scan, streaming search results, and a
Brand → Model → Board# reorganisation of the Board# view.

### PDF text search (new backend index)

- **Backend pdfium/wazero text index with SQLite FTS5 — replaces the old in-process rsc.io/pdf extractor.** PDF text now lives in a separate `pdfindex.db` (FTS5 external-content, porter+prefix tokenizer) built by a pooled pdfium-via-wazero engine with a per-file kill timer; the container stays CGO-free/scratch. Opening a PDF auto-indexes it via a client-side fast-path so it's searchable immediately; an autonomous backend indexer with a priority queue + stale-row watchdog handles the bulk. (`ba6f7c9`, `eb5ef97`, `fe99c03`, `97e6399`, `8846388`, `0076fbc`, `1fd9860`, `9faeed1`, `d8c2445`, `3bb915a`)
- **Streaming search results with live progress.** `GET /api/databank/search/stream` emits one result per file as the FTS cursor finds it (NDJSON), so the list builds up immediately with a "Searching… N found" indicator instead of an ~8 s freeze. Results are one row per file with a hit count, single-click selects (info pane), double-click opens and jumps to the match. (`37c42a8`, `f9739ec`, `051d5ac`, `4b89a6e`, `182464a`)
- **Dedicated PDF Search tab** with donor-scoped search, a donor-list management view, folder-scoped indexing ("Index this folder"), and a backend progress UI with ETA/rate and failed-file drill-down. (`f602566`, `a67bf8e`, `1457c11`, `b622427`, `16bd267`, `ca1125d`)
- **Watermark terms sync to the backend** and offer a reindex of affected files when changed. Container memory floor raised to 1 GB; Go base bumped to 1.25 for the wazero runtime. (`77c1b96`, `f94134c`, `3168ffa`)
- **Search fix:** prefix-match terms so a partial part number matches its variants (`AOZ5332` → `AOZ5332QI`). (`8bc3ebe`)

### Library content deduplication

- **Duplicates are detected and marked during the filesystem scan**, so each scan yields a clean, deduped file list and the PDF indexer never re-extracts byte-identical copies. Detection is size-bucket + sampled hash (`sha256(size ‖ full-file ≤192 KiB else head/mid/tail 64 KiB)`) — a unique byte size is never read. (`51311e7`, `34920e1`, `86ea2f1`, `58f0094`, `b92d939`)
- **Parallel hashing + same-(name,size) representative.** The dedup phase hashes with a worker pool and reads one representative per same-named/sized cluster instead of every copy — much faster on large libraries, still byte-exact. (`08f2b6f`)
- **The PDF indexer enumerates only canonical files** — non-canonical duplicates never reach its work queue. (`815bdeb`, `88c007d`, `3d5df43`)
- **Content-oriented views collapse duplicates; the Folder view shows everything.** Board#/Model and search results show one canonical row + an "N copies" badge across the whole view (even across board numbers); the on-demand "Find duplicates" pass + stats live in Settings ▸ Library. (`f152df3`, `2be750e`, `b3e6e4b`, `c2c814d`, `8844394`, `2525c13`)
- **Reset PDF Text** wipes the index by recreating `pdfindex.db` (O(1), not a multi-minute row delete) and is no longer gated on a running file scan. (`61f626d`, `6b8c514`, `10a0c3a`, `9055b75`)

### Library views

- **Board# view regrouped Brand → Model → Board#**, with same-named files under a board number folded into an expandable spoiler so re-saved copies from different sources don't clog the tree. The Model tab is hidden (its grouping is now redundant). (`85c2e03`, `f485694`)

### Scan

- **Auto-binding is off by default** (opt-in via `auto_bind`) — the O(boards×pdfs) match loop was adding hours to large-library scans. Scan status now updates live during the long walk/compare phases. (`a937f2d`, `e296fbc`, `fb828c9`)

## v0.30.13 — 2026-05-25

Cross-lookup between two linked PDFs — for boards that only exist as PDF — plus
copy-to-clipboard for the current selection, drag-dropped files filed into the
library, and an FZ unit-detection fix.

### PDF↔PDF cross-lookup

- **Link two open PDFs and cross-probe designators between them.** When a board is only available as PDFs (e.g. a schematic sheet and a layout sheet), open both and link them 1:1 from the PDF's bind (∞) menu — a new **Cross-link PDF** section after the board bindings. Single-clicking a component designator in either PDF jumps the linked PDF to a matching occurrence and highlights it — reusing the existing search → snap-to-match → highlight path — and re-clicking the same token cycles through multiple matches. Fully bidirectional. Text (vector) PDFs only: matching is on the designator string, so no nets or pins are needed. The link is symmetric and persisted across reloads. (`62297b1`, `ecff231`, `6191dca`, `de9c710`)
- **Cross-lookup feedback as a toast.** "No match for X in Y" and "Linked PDF not open" surface as a toast rather than inline toolbar text, which had collided with the search hint and broken the toolbar layout. (`de9c710`)

### Selection

- **Cmd/Ctrl+C copies the selected component, pin, or net name** to the clipboard, so a designator can be pasted straight into notes or a search. (`c00e1af`)

### Files

- **Drag-dropped boards and PDFs are saved into the library's `incoming/`** instead of living only in the browser session, so a dropped file is kept for later. (`224a00a`)

### FZ parser

- **Don't trust `UNIT:millimeters` on mil-coordinate files.** Some ASUS `.fz` files declare millimetre units while their coordinates are actually in mils; the mislabel scaled the board down ~25×, rendering pins sub-pixel ("opens but no pins/nets"). Unit detection no longer takes the header at face value on such files. (`0a72b40`)

## v0.30.12 — 2026-05-25

Worklist connection-highlighting and a more capable hierarchical net-line mode,
plus GenCAD bottom-side placement fixes and a clearer error for encrypted
BRD_V1.0 boardviews.

### Worklist

- **"Connections" highlight — see which nets a group of parts share.** The worklist's old one-way "Highlight" button is now a **Connections** toggle: turning it on selects every part in the active worklist (cyan) and glows every net shared by two or more of them, so the interconnections inside a repair set stand out at a glance. Toggling off clears both — the one-click un-highlight the panel was missing — and the highlight also clears automatically when its source worklist is switched, wiped, or deleted. No connecting lines are drawn for these shared nets; net-lines stay reserved for an explicitly selected net. (`aad93b1`)
- **Selecting a 2-pin component in hierarchical net-line mode now lights both pins.** Picking a 2-pin part by its body — which previously highlighted nothing — seeds the highlight from one pin's net, so the one-hop adjacency carries it through to the other pin's net and both chains draw. (`aad93b1`)

### Net lines (hierarchical mode)

- **Per-part-type "bridge" override — carry the hierarchy through >2-pin parts.** The chain-adjacent mode previously hopped only through 2-pin parts. A new **Bridge** checkbox in Settings ▸ Part properties lets a whole part type pass the propagation regardless of pin count, so 4-pin Kelvin/current-sense resistors — and, when enabled, 3-pin transistors — carry the trace. Resistors, **inductors, and diodes** bridge by default; every other type is off and toggleable. (`0bd6f0e`, `0836107`)
- **Editable hierarchy depth.** The propagation depth is no longer hard-coded — a **Hierarchy Depth** slider (1–4, default 2) at the top of Part properties controls how many hops the highlight follows down a series chain, and changing it updates a live highlight immediately. (`0836107`)

### CAD (GenCAD) parser

- **Place bottom-side parts correctly (`SHAPE … MIRRORY`).** Allegro2CAD `.cad` exports store bottom components with a `MIRRORY FLIP` shape flag and shape-local pins; the parser dropped the mirror token, X-flipping every bottom footprint about its placement origin — 1006 of 2900 parts (~35%) misplaced on the Dell XPS 9560 LA-E331P. The mirror is now applied in shape-local space before rotation; verified against an independent world-coordinate export, all 7,579 bottom-side pins match to <1 mil. (`3e475f3`)
- **Correct top/bottom via pin-majority.** Allegro2CAD `.cad` inherits the same side-labelling quirk as Allegro `.brd`, so the parser now applies the identical pin-majority heuristic (>55% of pins on the declared bottom side ⇒ flip the primary side). The Dell board (62% bottom pins) now matches its source `.brd`. A `$BOARD`-derived real outline was prototyped in the same investigation but reverted — `$BOARD` content is too exporter-specific to stitch reliably — so the synthetic rectangular outline is unchanged for now. (`5308dc4`, `2619e17`)

### BRD parser

- **Clear error for encrypted BRD_V1.0 boardviews.** Opening a `BRD_V1.0` container (e.g. ASUS TURBO-RTX3080) failed with a misleading "BDV file … may be corrupt or empty" — its fully-encrypted body matched no format and the `.brd` fallback handed it to the wrong parser. Detection now recognises the 8-byte `BRD_V1.0` magic and routes to the BRD parser's friendly "proprietary, encoded format — support may be added" message. (`b9ec51e`)

## v0.30.11 — 2026-05-24

Two parser fixes surfaced by ASUS G513R laptop boards (FZ and GenCAD exports
of the same `6050A3348801/03` design), plus a Landrex theme refinement.

### FZ parser

- **Decode the GOCCANH "GCVN" variant via a raw-deflate fallback.** ASUS boards re-exported by the GOCCANH Vietnamese tool decrypt to a `GCVN` magic and a `0x78 0x9c` zlib header, but the body is a raw DEFLATE stream that zlib-mode inflate rejects ("invalid distance too far back") — and on the bounded content slice it silently inflates to empty rather than throwing, so the file fell through to "no parts or pins" despite a valid key. The content-decompress step is now an ordered set of fallbacks (standard zlib → `descrSize+4` zlib for the GOCCANH-XJ tail chop → raw deflate skipping the zlib header), each accepted only if it yields non-empty text. ASUS G513R `6050A3348801` now parses (4138 parts / 2936 nets); standard Acer N22Q22 FZ unaffected. (`16c4935`)

### CAD (GenCAD) parser

- **Surface the `$DEVICES` PART description as component value + serial.** The parser ignored the `$DEVICES` catalogue, so ComponentInfo showed only the COMPONENT's inline DEVICE field — which on Mentor CAMCAD exports (Compal/ASUS boards, e.g. G513R `6050A3348803`) is just "Device &lt;refdes&gt;". The real BOM data (device type, value, package, manufacturer, MPN) lives in each device's PART line. We now parse `$DEVICES` into a device→PART map and split the PART string on `//`: the left side becomes the value (e.g. "RES 200K OHM 1/20W (0201) 5%"), the right becomes the serial (e.g. "TA-I/RM02JTN204"). Falls back to the inline device name when no PART exists, dropping the placeholder, and skips per-refdes shape names that just echo the component name. (`e6375e0`)

### Theme

- **Landrex is now a board-only high-contrast style.** Switching to Landrex Classic no longer repaints the interface chrome — its `ui` block mirrors the default theme, so the toolbar, panels, accent, text, and library badges stay put. Every board label is forced white: part labels (was gray) and net labels (was blue) were static palette entries that ignored the theme, so they're now theme slots, set white under Landrex for maximum contrast against the black canvas. Pin labels already followed the theme. (`f92c0e5`)

## v0.30.10 — 2026-05-20

Allegro parser fixes surfaced by a Dell Nvidia Quadro 5000M board
(`Nvidia_5000M_Dell.brd`) — the first v17.4, millimetre-units file in the
corpus — plus the PDF pan-boundary follow-up.

### Allegro parser

- **Honour `boardUnits` when scaling coordinates to mils.** The assembler divided every coordinate and dimension by `unitsDivisor` alone, implicitly assuming MILS. That is correct for the ~10 MILS boards we had, but silently mis-scaled the two metric files: a millimetre-units board (divisor 10000) came out **39.37× too small** — a 5.2″×3.6″ board collapsed into a ~3 mm blob where every part overlapped into one tiny mass. Fold the per-unit mils factor into the divisor at the single source point so all downstream conversions land in mils; MILS files are byte-for-byte unchanged. Also corrects a µm-units file that was silently oversized. (`c3d3157`)
- **Derive component side from the assembly-graphic subclass.** Some exporters leave the `0x2D` footprint-instance layer byte 0 for every part regardless of side, so the Nvidia board reported 838 top / 4 bottom when it is really ~389 top / ~453 bottom — every bottom-side part rendered on top. Allegro also records side on each footprint's PACKAGE_GEOMETRY assembly drawing via the `0x14` graphic layer subclass (`0xF7`=top, `0xF6`=bottom); that subclass agrees with the instance flag on every other corpus file where it appears, so prefer it when present and fall back to the instance flag otherwise. (`05604fe`)
- **Skip footprint-definition via-in-pad templates.** `extractVias` walked every `0x33` block, including footprint-library via-in-pad templates whose net pointer references the parent `0x2B` footprint definition (not a `0x04` net) and whose coords are footprint-local. They rendered as a phantom BGA-style via grid at the board origin — ~2.8k vias (16 GDDR chips × 170 balls) on the Nvidia board, plus smaller clusters on Compal LA-H271P and Dell XPS 9560. Templates are now dropped. (`7288903`)
- **Skip footprint-definition copper-track templates.** Same root cause for traces: `extractTraces` picked up `0x05` ETCH tracks whose `netAssignment` points at a `0x2B` footprint def, dumping ~340 uniform local-coord segments as a phantom cluster at the origin. Both sites now share one `pointsToFootprintDef()` check. (`3f30b7b`)

### PDF viewer

- **Pan boundaries off by default; the panel no longer sticks mid-scroll.** Multiple users reported the PDF panel getting "stuck" on a page mid-document or refusing to scroll in some positions, traced to the pan-clamp logic interacting with the page-flip threshold. `clampPan` now returns immediately unless the new Settings ▸ Performance & Debug ▸ "PDF Pan Boundaries" toggle is on; the page-flip thresholds in the wheel handler still fire as the user crosses them. The zoom range stays at the historical 0.5×–10×. (`878c74d`, `340bee1`)

## v0.30.9 — 2026-05-19

Two self-update papercuts found while shipping v0.30.8.

### Updater

- **Default `docker-compose.yml` now mounts `/var/run/docker.sock`.** Without this mount, in-app `Update & Restart` is a no-op (the running container can't call the Docker Engine API to pull and swap itself), but nothing in the UI explains why — fresh installs that used the shipped compose ended up silently stuck on whatever version they originally pulled. Combined with the existing `user: "0:0"` line, this makes self-update work out of the box. Pre-existing installs need to add the same line and `docker compose up -d`. (`b8bfcab` follow-up)
- **Drop-to-update accepts `latest-update.tar` and `*.brupdate`.** The previous `isUpdateBundle` regex required the filename to start with `boardripper-update-v[0-9]`, which silently rejected the stable-alias filename our releases also publish. Loosened to accept the alias plus any file with our own `.brupdate` extension. (`b8bfcab`)
- **Friendly redirect when the wrong tarball is dropped.** Releases publish `boardripper-v0.30.X.tar.gz` (the Docker image, for `docker load`) and `boardripper-update-v0.30.X.tar` (the signed update bundle, for drag-drop) side-by-side. The image alphabetises first, so it's the easy mistake. Dropping the image now raises a toast pointing at the right filename instead of falling through silently. (`b8bfcab`)
- **Drop overlay copy mentions update bundles.** Previously read "Drop board or PDF files here" — no hint that the drop-to-update path existed at all. Now lists boards, PDFs, and the expected bundle filenames. (`b8bfcab`)

## v0.30.8 — 2026-05-18

Right-click context menu redesign and two parser fixes.

### Context menu

- **Density pass.** Font 12px, padding 4px 10px (was 0.9em / 6px 14px); the action strip is gone, replaced by inline chips inside the existing header row. Menu caps at 360px wide; long PDF / board donor names ellipsis-truncate with the full path available on hover (`title` attribute). The whole menu reads ~30% shorter at the same content. (`ac6fcc8`)
- **Header chips.** Each value (part / pin / net under the cursor) renders as a chip with a copy-on-click affordance; search-on-web and worklist-pin sit as 22px icon buttons on the chips that own them. No more "pin F11" prefix — the value alone speaks in chip context. The previous three-row Copy / Search / Worklist strip is gone; everything an action could target now lives next to its name. (`ac6fcc8`)
- **Pin chip leads + lit state for worklist membership.** The worklist pin sits FIRST inside the part chip, before the value name. When the right-clicked component is already in the active worklist the pin renders filled + accent-coloured (`IconPinFilled` on `.is-lit`), tooltip switches to "click to remove", and the click removes the entry — mirrors shift-click on the canvas. (`ac6fcc8`)
- **Donor row: chevron on the left, variant connector hairline.** The variant-expansion glyph moved from a 2em right-side icon (often misread as "submenu →") to a 1.4em left-side chevron in a fixed 18px slot, matching the file-tree disclosure pattern. Expanded variants now render inside a wrapper with a 1px left border that visually ties them to their donor row. (`ac6fcc8`)
- **Auto-expand donor groups when total donor rows < 5.** Small lists default to open — no extra clicks needed for the typical "one bound PDF + one sibling board" case. The chevron still toggles, and explicit user collapses persist for the lifetime of that menu open. (`ac6fcc8`)
- **`IconMinus` retired for the "no mark" worklist row.** Reads as "subtract"; replaced by a dim `·` (opacity 0.4). The mark-cycle popover already names the new state on click, so the row's idle look stays calm. (`ac6fcc8`)

### Parsers

- **BRD parser early-rejects the proprietary `BRD_V1.0` container.** New 16-byte ASCII header check at the top of `parseBRD` throws with a descriptive message: "proprietary, encoded boardview format. Decoding is under active investigation — support may be added in a future release." Without this gate, OpenBoardView-style decoding ran against the encoded body and emitted garbage geometry that took users a while to diagnose. (`8fe1b94`)
- **FZ alt-end fallback for non-canonical `descrSize`.** The Vietnamese GOCCANH-XJ converter writes `descrSize` 4 bytes longer than the canonical layout, which chops 4 bytes off the deflate stream and makes pako abort with "unexpected end of file". When the canonical slice fails, the parser now retries once with `contentEnd + 4` before reporting failure — symmetrical to the trailing-pointer trim already in place on the forward path. Fixes silent failures on a small but real set of community boards. (`8fe1b94`)

## v0.30.7 — 2026-05-18

PDF watermark wand toggle — fixes a long-standing bug where the user's custom watermark term list was destroyed on every wand-off→reload→wand-on cycle.

### PDF

- **Wand toggle preserves the list across reloads.** Pre-fix: clicking the wand button OFF wrote `pdfWatermarkFilter: []` to localStorage and stashed the previously-active list in a non-persistent `useRef`. On reload the ref reinitialised from `globalSettings.pdfWatermarkFilter` which was now `[]`, then fell through to a hard-coded 5-term fallback. Users who had edited their list (added a vendor watermark via right-click) lost those edits on every off/on cycle; users who toggled off and never toggled back on saw their full list as empty in Settings indefinitely with no auto-recovery path. Fix: split the on/off state into a new persistent `pdfWatermarkFilterEnabled: boolean` field — `pdfWatermarkFilter` now ALWAYS represents the user's list, the wand button only flips the flag. (`e664291`)
- **Centralised through `getActiveWatermarkFilter(settings)`.** Returns the list when enabled, `[]` when disabled. Routes all four consumers through it: the two `page.render()` call sites in `renderPageToBitmap` and `renderTiledPage`, the operator-list dispatch in `pdfStore.openDoc`, and the click-test in `mapClick`. Eliminates the "is the filter active?" question being answered by `filter.length > 0` four different times. (`e664291`)
- **Migration recovers users currently stuck with empty lists.** Existing localStorage entries with `pdfWatermarkFilter: []` and no `pdfWatermarkFilterEnabled` key get auto-bumped to `pdfWatermarkFilter: <5 current defaults>` + `pdfWatermarkFilterEnabled: false`. Toggling the wand back on then brings the 5 defaults back. Users with a non-empty list and no flag set get `enabled = true` (matches the pre-fix semantics where non-empty = active). New users get the 5 defaults + enabled = true via `DEFAULTS`. (`e664291`)
- **Context menu's "Add to watermark filter" now auto-enables the filter.** Adding a term implies the user wants it filtered now, so the right-click action sets `pdfWatermarkFilterEnabled: true` alongside appending the term. Previously, adding a term while the wand was off silently extended the list with no visible effect. (`e664291`)

## v0.30.6 — 2026-05-18

FZ format — removed the bundled ASUS RC6 decryption key. Users now obtain it themselves through a small in-app dialog (fetch from public GitHub mirror or paste).

### FZ

- **`DEFAULT_FZ_KEY` deleted from `fz-parser.ts`.** The 44 × uint32 key required to decrypt encrypted ASUS .fz boardview files is third-party material BoardRipper did not author and has no license to redistribute. Upstream OpenBoardView takes the same position — `FZFile::getBuiltinKey()` returns an empty array — and we now match. The parser still ships the parity-check fingerprint (also from OBV) so any user-supplied key is validated before use. Distributing the key alongside the binary raised exposure under anti-circumvention statutes (DMCA §1201 in the US, InfoSoc Directive Art. 6 / CDSM in the EU) even though the parsing logic itself is MIT-derived; cleaner posture is to have the user fetch it themselves. (`b09c777`)
- **Typed `FZKeyError` with `'missing' | 'invalid'` reason.** Encrypted file + no configured key → `'missing'`; configured key produces non-zlib output after RC6 → `'invalid'`. The board-store catches both and opens the FZ-key dialog; the `'invalid'` path additionally clears the bad stored key so the next fetch/paste replaces it without manual cleanup. (`b09c777`)
- **In-app FZ-key dialog (`components/FZKeyDialog.tsx`).** Opens automatically the first time a user drops an encrypted .fz file. Two paths: **Fetch** pulls from the public mirrors at `github.com/cryptonek/illegal-numbers` (primary) and `github.com/yliu-d/illegal-numbers` (fallback) in order until one yields a parity-valid key; **Paste** accepts any text containing 44 hex tokens. Both run through `validateFZKey()` before persisting to `localStorage` (`boardripper-fz-key`). A `cyrozap/pcbrepair-rs` GitHub mirror is intentionally excluded from the fallback list — its `FZ_EXPANDED_KEY[43] = 0x0945692e` is corrupted (the trailing `e` was appended to fix Rust syntax around the truncated `0x0945692` in upstream cryptonek; the canonical zero-padded value is `0x00945692`, the only one that passes parity). A collapsible "Why isn't the key bundled?" section in the dialog explains the legal reasoning in plain language. (`b09c777`)
- **`store/fz-key-store.ts`.** New singleton store extending `Emitter` for `useSyncExternalStore` integration. Exposes `getFzKey()`, `setKeyFromText()`, `clearKey()`, `fetchAndApply()`, plus a promise-based `ensureFzKey()` gate the board-store awaits before retrying an encrypted-FZ parse. `parseFzKeyText()` is regex-based (`0x[0-9a-fA-F]{1,8}|[0-9a-fA-F]{8}`), so the same parser handles cryptonek's markdown table, raw hex pastes, and Rust array literals indifferently. (`b09c777`)
- **No new CSS systems.** The dialog reuses the existing `.library-modal-*` chrome (backdrop, modal box, field rows, action row, primary-save button). Net CSS addition: `~15 lines` for a wider modal variant, a textarea that matches `.library-modal-field input`, and two inline-message colours. (`b09c777`)
- **Docs.** `docs/formats/FZ_FORMAT.md` and `THIRD_PARTY.md` updated. `THIRD_PARTY.md` now carries a dedicated *FZ decryption key — not bundled* entry that documents the posture and points users at the in-app dialog. The OpenBoardView attribution clarifies that the key is **not** part of what we inherit from upstream. (`b09c777`)

**Migration note for existing users.** After updating, the first time you open an encrypted .fz file you'll see the new dialog. One click on **Fetch** restores the previous behaviour. Unencrypted .fz files (the rare case where the raw zlib stream is already at offset 4) continue to open without prompting.

## v0.30.5 — 2026-05-17

PDF tile render path — single perf change with measurable settle-time win on fresh-tile renders.

### PDF

- **Pipeline tile `createImageBitmap` with the next tile's `page.render()`.** The tile loop in `renderTiledPage` used to await BOTH `page.render()` and `createImageBitmap` strictly in sequence per tile, leaving the pdf.js worker idle for the duration of each bitmap pump. The new structure holds each iteration's bitmap promise as `pending` and collects it at the top of the next iteration — meaning tile N+1's `page.render()` is in flight in the worker while tile N's pixels are being pumped into an `ImageBitmap` on the main thread. `page.render()` itself stays strictly serial per pdf.js's constraint (parallel calls on the same page produce flipped/mirrored tiles); only the JS-side bitmap creation overlaps. Cancellation drains the in-flight bitmap before returning so the LRU cache still gets valid pixels rendered before the cancel. Expected ~30–50% reduction on all-fresh-tile settle paths (zoom change, page change); no impact on cache-hit pan paths. Directly addresses the observation that Standard mode's crisp settle felt faster than Tiles mode's — the 2N awaits in sequence were the structural cause. (`40edb70`)

## v0.30.4 — 2026-05-16

PDF viewer feel — two complementary changes aimed at making zoom and multi-page navigation smoother on heavy schematics.

### PDF

- **Render-mode switch (Auto / Standard / Always-tile).** New control under Settings ▸ PDF ▸ Render mode. *Auto* (default) keeps the existing behaviour — tile above 1.05× zoom for crisp deep-zoom text, full-page below. *Standard* always renders the full page into one canvas (Firefox-style) — smoother during pinch/zoom and one fewer compositor layer; pixels go soft past the browser's canvas-max dimension (~5–6× on A4). *Always tile* is a debugging escape hatch. The router lives behind a `shouldUseTilesRef` predicate that reads both mode + zoom, replacing the four scattered `zoom > 1.05` literals; mode flips re-route the next render without a React-deps refresh. (`b84510a`)
- **Gesture-suspend during wheel-zoom bursts.** Adaptive-throttle renders inside `scheduleTierRender` are now paused while a trackpad pinch / Ctrl+wheel zoom is active (150 ms self-expiring `gestureActiveRef` set in `markGestureActive`). The 60 ms trailing debounce still fires once the burst ends, so the user sees CSS-transform-only motion during interaction and one crisp render at settle — same model Firefox's PDFViewer uses. Touch pinch and Safari `gesture*` paths already had this implicitly (neither calls `scheduleTierRender` mid-gesture); this brings the wheel-pinch path in line. (`b84510a`)
- **Min zoom floor dropped 1.0 → 0.5 to unstick multi-page navigation.** v0.27's fit-to-width zoom lock (`a876c74`) was masking a boundary-bounce glitch, but the side effect was that at zoom ≥ 1 each page is taller than the viewport and the wheel-pan flip threshold at `containerH/2` takes many wheel events to reach — felt like being "stuck" on one page mid-document. Restored the zoom-out-to-see-adjacent-pages workflow across all four zoom paths (wheel, Safari `gesturechange`, touch pinch, keyboard). 50% is far enough to see neighbours without re-surfacing the original glitch. (`e5ef926`)

## v0.30.3 — 2026-05-16

The headline feature is a complete rewrite of the **PDF watermark filter**: it now runs *inside* pdf.js (via a `patch-package`-managed patch) and drops watermark glyphs **at parse time** instead of at render dispatch. Plus a stack of Worklist polish (waterdamage flag, ticket note, custom soldering-iron icon) and a couple of tooltip / hover-info improvements from earlier in the session.

### Worklist

- **Per-row waterdamage flag.** Each entry has a binary "water damage observed" toggle alongside the existing mark cycle. Dim/transparent droplet icon when off, cyan-blue when on. Independent of the mark state — a part can be both water-damaged AND replaced. Roundtrips through the clipboard via a `[water]` token on the row (`R12[replaced][water] (note)`). (`762cfe5`)
- **Per-worklist ticket note.** A `Ticket note ▸` spoiler at the top of the active worklist holds a free-form note (~4 KB cap). Preview of the first line shows when collapsed. Roundtrips through the clipboard via `> `-prefixed lines immediately after the `-[name]-` header. (`762cfe5`)
- **Mark-cycle flash chip rendered through a React portal.** Previously the per-row "Replaced / Reworked / Cleaned" popover anchored to its button via `position: fixed` could land in the wrong place when an ancestor Dockview/sidebar wrapper created a containing block. Now portaled to `document.body` so `position: fixed` coords always reach viewport space. (`762cfe5`)
- **Custom soldering-iron icon for the "Reworked" mark.** New `IconSolderingIron` component in `src/icons/`: iron body from `mdi:soldering-iron` (Apache 2.0) with the cord subpath dropped and horizontally mirrored; smoke wisp hand-traced inspired by `game-icons:soldering-iron` (CC BY 3.0). Replaces the bandage emoji-substitute. Attributions in `THIRD_PARTY.md`. (`762cfe5`)
- **"Select" button renamed to "Highlight"** — matches what it does (load worklist parts into the cyan canvas overlay, not a real selection mutation). (`4bdc9ad`)

### PDF watermark filter — complete rewrite

The v0.4.2 – v0.30.2 implementation passed a `Set<number>` of pre-computed operator indices into pdf.js's public `operationsFilter` render callback. That had two latent bugs that manifested on more PDFs as the filter list grew: pdf.js's `getOperatorList` uses `NullOptimizer` (raw operator stream) while `render` uses `QueueOptimizer` (merges/reorders ops), so pre-computed indices didn't line up; and any PDF that emits one `showText` per glyph for sub-pixel positioning (Gigabyte schematics, for example) never matched substring filters per-op anyway.

The new design lives **inside the pdf.js worker**, via a `patch-package`-managed diff at `src/frontend/patches/pdfjs-dist+5.5.207.patch`. The patch:

- Adds a `watermarkFilter: string[]` option to `PDFPageProxy.render(...)`, forwarded through `_pumpOperatorList` → `GetOperatorList` worker message → `Page.getOperatorList` → `PartialEvaluator.getOperatorList`.
- In the evaluator's main switch, between `BT` and `ET`, tracks every `showText` op's `args` reference and the accumulated glyph-unicode string. Ops flow through `operatorList.addOp` in source order — no buffering, no reordering — so async-emitted state ops (`setFont`) land where pdf.js expects them.
- At `ET`, NFKC-normalises the accumulated string + each filter term, lowercases, strips whitespace, substring-matches. If any term matches, retroactively sets each tracked showText's `args[0] = []` so the op still executes but draws nothing.

Trade-offs and why this shape: we tried a per-op filter (broke on per-glyph PDFs), a whole-BT-buffer-then-emit approach (broke rendering whenever a real text block went through the buffer, because state ops emitted async to the operator list landed before the buffered BT did), and finally landed on in-place glyph-array zapping after the fact — the only approach that preserves pdf.js's strict op-stream ordering while still letting us decide at BT-block granularity.

Notable shipped fixes inside this rewrite:

- **NFKC normalisation** so Latin ligatures like `ﬁ` (U+FB01) decompose to `f` + `i`. Without it, `"Vinaﬁx.com"` never matches the user's `Vinafix` filter term. Click-test path (`isPdfWatermarkText` in `render-settings.ts`) uses the same rule, kept in lock-step by design.
- **`cMapUrl` + `standardFontDataUrl`** wired into every `pdfjsLib.getDocument` call. Some donor PDFs (Gigabyte schematics) ship fonts that reference CJK/vendor CMaps; without these URLs, pdf.js's font loader fails with `Ensure that the cMapUrl and cMapPacked API parameters are provided` and the glyphs arrive at the operator stream with no `.unicode` — the filter then has nothing to match against. Dev server points at unminified `pdf.worker.mjs` so the patch targets readable source; vite still minifies for production.
- **`flushOperatorListCache(fileName)` on filter toggle** — pdf.js's `intentStates` cacheKey doesn't include the filter, so a toggle alone leaves the cached operator list in place. We now call `page.doc.cleanup(true)` to force a re-parse with the new filter.
- **`self.` instead of `this.` in the showText branch.** The switch sits inside `new Promise(function promiseBody(resolve, reject) { … })`, a regular function — `this` is `undefined` in strict-mode module scope. The earlier `this.watermarkFilter` read threw a `TypeError` that pdf.js's `ignoreErrors` catch silently swallowed, dropping the whole operator list, which manifested as "no text renders at all". Caught via Playwright probe.
- **Right-click → "Hide as watermark"** context-menu item on PDF text. Adds the clicked text to `pdfWatermarkFilter`; the existing filter-change subscription flushes caches and triggers a re-parse with the new term.
- **Default filter expanded** to `Vinafix`, `www.chinafix.com`, `www.xinxunwei.com`, `notebookschematics.com`, `notebook-schematics.com`. Migration recognises any prior default list and upgrades automatically; explicit customisations are preserved.

The patch survives `npm install` / Docker builds via a `postinstall` script wired into `src/frontend/package.json`. Updating procedure for pdf.js version bumps is documented in `src/frontend/patches/README.md`.

### Hover tooltip

- **Value and Package surfaced in the hover tooltip.** On boards whose parsers fill `PartMeta` (primarily TVW; partial coverage from BVR/BDV/Allegro), a new line appears between `R123 · pin 2` and any OBD readings, joining `value` and `package` with ` · ` (e.g. `10uF · CHIP0603R`). Hidden entirely when both are empty so non-TVW tooltips stay compact. Matches what `ComponentInfoPanel` and `BoardSidebar` already show. (`07f018f`)
- **Trace-hover label cleaned up.** Was `Top · pin trace` (awkward). Now `trace · Top` (or just `trace` when no layer name). Net stays on line 1. (`07f018f`)

### Clipboard

- **Worklist Copy + context-menu Copy work over LAN / NAS / Tailscale, not just `localhost`.** `navigator.clipboard.writeText` is only defined on secure contexts (HTTPS or `http://localhost`); the dashboard accessed at `http://192.168.x.x:1336`, Vite's network URL, or a Tailscale `100.x.x.x` address left it undefined and the copy threw `Cannot read properties of undefined (reading 'writeText')`. A new `copyText()` helper in `src/clipboard.ts` falls back to a transient off-screen `<textarea>` + `document.execCommand('copy')`. (`4bdc9ad`)

### Renderer

- **`BoardRenderer.teardownForReinit` removes `multiHighlightGfx` alongside the other highlight layers** — was missing from one of the two teardown paths, leaking the graphics object on tab switch. (`762cfe5`)

## v0.30.2 — 2026-05-15

### Fixed

- **Worklist Copy + context-menu Copy worked over `localhost` but failed over LAN / NAS / Tailscale.** `navigator.clipboard.writeText` is only defined on secure contexts (HTTPS, or `http://localhost`). Opening BoardRipper at `http://192.168.x.x:1336`, the Vite dev server's network URL, or a Tailscale `100.x.x.x` address left `navigator.clipboard` undefined; both call sites threw `Cannot read properties of undefined (reading 'writeText')`. A new `copyText()` helper (`src/frontend/src/clipboard.ts`) tries the modern API first and falls back to a transient off-screen `<textarea>` + `document.execCommand('copy')` — works everywhere the dashboard is reachable.

### Polish

- **Worklist tab button "Select" renamed to "Highlight".** Better matches what the action actually does: it loads the worklist's parts into the cyan canvas highlight overlay, no real "selection" mutation. The Cyan-selection band's helper text was updated to match.

## v0.30.1 — 2026-05-15

### Polish

- **Hover tooltip surfaces Value and Package.** On boards whose parsers fill `PartMeta` (primarily TVW Teboview; partial coverage from BVR / BDV / Allegro), the in-canvas tooltip now shows a new line between `R123 · pin 2` and the OBD readings, joining whatever fields are present with ` · ` — e.g. `10uF · CHIP0603R`, `100K`, or `QFN32` on its own. The line is hidden entirely when both fields are empty, so boards without metadata keep the compact two-line tooltip. ComponentInfoPanel + BoardSidebar already showed these fields; the tooltip now matches without requiring a click. (`07f018f`)

- **Trace hover label is no longer "Top · pin trace".** The detail line on trace-only hits now reads `trace · Top` (or just `trace` when the source format has no layer name), keeping the trace's net name on line 1 as before. The old phrasing was a leftover from constructing the detail string from a part/pin pair; pin became optional in `showTooltip` so trace hits can drop the suffix. (`07f018f`)

## v0.30.0 — 2026-05-14

Headline addition: the **Worklist** — a per-board, persistent multi-select with named lists, marks, notes, and roundtrip clipboard sync. Plus a stack of PDF / scanner / updater fixes from the day after the v0.20.x cleanup.

The version jump from v0.20.9 to v0.30.0 marks the first release of the new stable pipeline (signed manifest + GHCR + ripperdoc.de archive + chat-runnable `release.sh`) as a milestone, distinct from the 0.20.x stabilisation series.

### New

- **Worklist** — per-board, multi-select-driven scratch list with named groups. Shift+click on the board adds/removes parts from an ephemeral multi-select set (cyan outline). Right-click ▸ "Add to worklist" or the toolbar Worklist button pushes the selection into a per-board named worklist (amber outline). Lists persist in IndexedDB (`boardripper-worklist`) keyed off the same fileName/size/mtime triple as the board cache — they survive reloads and container upgrades. Each row carries a cycling mark state (none → replaced → reworked → cleaned → bandage) plus an optional free-form note under a spoiler caret. Per-mark coloured outline + glyph on the board so you can see at-a-glance which parts are in which state. The whole list copies as `REFDES[mark] (note)` for paste-into-issue tracking. The panel lives as a tab inside the BoardSidebar (no separate Dockview window). (`2461b8c`, `59bf9ff`, `df50276`, `5cc5a02`, `872b750`, `b64f143`, `f106dac`)

- **Worklist roundtrip export + clipboard import.** Export writes the list name as the first line wrapped in a `-[<name>-<bnum>]-` marker, then `REFDES[mark] (note)` lines. Paste it back into another BoardRipper instance and the Worklist panel reads the marker, recreates the list, re-resolves refdeses against the open board, and restores marks + notes. `importFromText` is hardened against arbitrary clipboard payloads (random text doesn't accidentally create a list; only the marker-form is accepted). Survives renames + minor format drift in pasted content. (`c962d30`, `8dc817d`)

- **Butterfly mode allows board rotation.** Previously the rotation toolbar buttons were disabled in butterfly mode (the auto-separation axis logic didn't track manual rotation). The renderer's `applyFlips()` butterfly branch was actually already rotation-aware — it picks the separation axis from the rotated bounds and uses `axesSwapped` to flip the right board axis under 90°/270°. The toolbar gate was the only thing in the way. Preference persists per-install. (`6e2b835`)

### Fixed

- **PDF text extraction on Safari < 17.4.** `pdf.js` v5's `getTextContent()` iterates the underlying ReadableStream with `for await`, which needs `ReadableStream[@@asyncIterator]` — absent on Safari before 17.4. Users on Safari 16.4–17.3 could render PDFs fine (the `sendWithPromise` path is unaffected) but PDF text scan / search returned nothing. The text-extractor now drives `streamTextContent().getReader()` directly. Safari stacks omit `err.message`, so log lines explicitly include `err.name + err.message` for diagnosability on the field. (`609f8cc`)

- **PDF: macOS rubber-band overscroll killed, zoom/resize tightened.** Trackpad momentum-phase wheel events at the top of page 1 were leaking past `preventDefault` and triggering the browser-native rubber-band bounce, briefly showing the page behind the canvas. `overscroll-behavior: none` on html/body/#root and `contain` on `.pdf-canvas-container` close that. Additional polish: zoom-around-cursor honours `transformOrigin` consistently across resize transitions; ResizeObserver no longer fires spurious resizes during DPI changes. (`a876c74`)

- **Scanner: garbage-name PDF auto-binding cured + historical bindings pruned.** The auto-match phase scored 50 for any pair where one filename's lowercased base contained the other's — with no minimum-length guard. A PDF named `1.pdf` matched every board whose name contained a "1" (i.e., most of them); a single page-fragment with a short generic name silently latched onto dozens of unrelated boards. Now a minimum substring length (≥4 chars) and a stop-list (`pdf`, `boardview`, page-marker patterns) gate the score. `migrateV9` runs once on hydration to delete pre-existing garbage bindings produced by the old heuristic — the scan re-runs cleanly on next bind. (`e81bdcd`, `7c1ffce`)

### Self-update overlay

- **The update-in-progress overlay now shows the captured progress log + a live elapsed-time counter.** The first measured clean v0.20.8 → v0.20.9 update on local Docker swapped in 9 s end-to-end (vs. the previous "30–60 seconds" copy the overlay used to display). During those 9 s the SSE stream emitted 14 informative entries — "Tagged previous image", "Pulling …@digest", "Locating self container", "Orchestrator launched — this container will exit and the new image will start momentarily" — which were sitting in `updateStore.progress[]` but were never rendered to the user. The overlay now subscribes to that array via a primitive `progressLen` `useSyncExternalStore` snapshot (keeps the stability invariant intact) and renders the last 14 entries in a scrollable monospace list, reusing the toolbar dropdown's existing `.update-progress-line` styling. New `<Elapsed: Ns>` counter ticks every second from overlay mount — the inner-component split means each restart transition mounts a fresh instance, so the counter naturally resets to 0 without a `setState`-in-effect. (`8b87a16`, `7f753d9` for the inner-component refactor cleaning up the react-hooks lint warning)

## v0.20.9 — 2026-05-13

### Fixed

- **TVW board outlines: `0x0B` drill-code is an ARC record, not another slot variant.** ThinkPad P14s Gen 2 NM-D352 ships 59 of these `0x0B` records alongside 90 real `0x0A` slots in its OUTLINE Roul layer. The parser was folding `0x0A` and `0x0B` into the same `DrillSlot` branch (inherited from eagleview) and reading both as straight line segments — the misread center+radius bytes happened to plot as 4,000–12,000 mil diagonals back near the origin, and `gfx.fill()` then cross-hatched the board with PixiJS's even-odd rule across the 98 disjoint sub-paths. `0x0B` has the same 29-byte footprint as `0x0A` but a different field layout (`net:s32, tool:u32, center:Vec2S, radius:Fixed32, start:f32 deg, sweep:f32 deg`); the parser now tessellates it to a 16-segment polyline so `chainLines` sees connected geometry, matching the Logic-layer arc-tessellation constants. (`0cc71c8`)

- **Clean `docker compose up -d` no longer restart-loops on Linux hosts.** `Dockerfile:52` ships `USER 65532:65532` for safety, but a fresh `docker compose up` on Linux has the Docker daemon create `./data` as root, which UID 65532 can't write — `databank.Open` then `log.Fatal`s at boot and the container exits. The bundled `docker-compose.yml` now overrides `user: "0:0"` (mirrors `deploy-remote.sh`) so the documented one-command install works. Users who'd rather keep 65532 can remove that line and either `chown -R 65532:65532 ./data` or switch to a named volume — Docker initializes named volumes from `/data` inside the image (pre-chowned to 65532 in the Dockerfile), so USER 65532 stays meaningful. (`f456c12`)

### Release pipeline

- **`SOURCES_CSV` no longer lists GHCR as a manifest source.** GHCR is a Docker Distribution v2 registry; `https://ghcr.io/.../manifest.json` returns HTTP 405 (it only speaks `/v2/`). Every install ever shipped wasted one HTTP request on a guaranteed-fail there before falling through to ripperdoc.de. Both the compiled-in `SOURCES_CSV` and the manifest's `source_list_next` field are now single-entry. GHCR is still used during `Apply` for pull-by-digest — different protocol on the same hostname. (`c4666b0`)

- **`scripts/release.sh` is now fully non-interactive.** Set `MINISIGN_PASSWORD` in `~/.config/boardripper/release.env` and the script pipes it to `minisign -S` over stdin (minisign accepts stdin when not on a tty). Falls back to the interactive prompt if the env var is unset, so hands-on runs still work. Combined with the `Build desktop Electron apps too? [y/N]` prompt's existing tty-check (which falls through to "off" in non-tty contexts), a release now runs end-to-end with zero operator input — chat-driven, cron-driven, CI-driven all behave the same. `--desktop` flag forces Electron builds when needed. (`fb0f91a`)

- **Version archive page at <https://www.ripperdoc.de/boardripper/archive.html>** is now regenerated on every release. Lists every CHANGELOG entry with per-version Docker-tarball / drop-bundle / GHCR-pull / source-tag links. The GitHub Releases page is intentionally scoped to the current release (older entries cleaned out 2026-05-13); the archive is the canonical "give me an older version" landing. Retention policy and tier-migration procedure documented in `docs/RELEASE_ARCHIVE.md`. (`fb0f91a`)

### Docs

- **README**: docker-compose snippet now includes the `user: "0:0"` override matching the in-repo `docker-compose.yml` (was missing, copy-paste users hit the restart loop). Self-update section corrected — the signed manifest is fetched from ripperdoc.de, then the image is pulled by content-addressed digest from GHCR; the previous "GHCR primary, ripperdoc.de fallback" phrasing was backwards (GHCR can't serve manifests). A new "Older versions" subsection points at the archive page. (`eca9d11`)

### CI

- **`--max-warnings 100` dropped from the eslint step.** The previous cap meant nearly every push hit the cap and failed CI (30 of the last 50 runs failed on the same `react-hooks/preserve-manual-memoization` and `react-refresh/only-export-components` warnings the React Compiler emits in batches); `tsc -b --noEmit` + backend tests + docker-build never ran because they `needs: lint-and-typecheck`. The cap was raised once before in `55a3a12` for the same reason — drift faster than the rules. Warnings still print to the run log; `tsc --noEmit` stays as the hard gate. (`ae68bc7`)

## v0.20.8 — 2026-05-13

### Important: silent-update-failure root cause

- **Auto-update silently rolled back on every install whose `/data` is mixed-ownership.** Since `430a219` (2026-05-12) the image ships `USER 65532:65532`. Production installs that override that at runtime (`docker run --user 0:0`, e.g. the maintainer's `deploy-remote.sh:143` does this because the Synology bind-mounted data dir is mixed root/65532) ran the OLD container as root. The orchestrator's `createBody`, however, did not propagate `Config.User` into the NEW container — it always started at the image default `65532`. The new binary then `log.Fatal`'d on `databank.Open` and update-secret read/create because the OLD container had written `/data/databank.db` and `/data/.update-secret` as root and 65532 can't write them; the process exited before listening on `:8080`; the orchestrator's 60s `/api/health` poll on the new container's IP timed out; rollback restored the old container; and the user saw nothing — the update "succeeded" silently and reverted. `findSelfContainer` now reads `Config.User` and `orchestrateRestart` includes `"User": self.User` in the create body. Image-default-USER installs (`self.User == ""`) fall through unchanged. (`b9b5e10`)

  **Chicken-and-egg caveat:** the fix lives in v0.20.8's binary, but the orchestrator that creates v0.20.8's container runs v0.20.7's (or earlier) code — which still has the bug. So the v0.20.7 → v0.20.8 update on an affected install **will still roll back**. Recovery: one manual `NASdeploy.sh` / `docker pull ghcr.io/alexeyinwerp/boardripper:v0.20.8 && docker rm -f boardripper && docker run -d ... boardripper:v0.20.8` to land v0.20.8 in place. From v0.20.8 onward, every future auto-update works as designed.

  The update-test harness (`tools/update-test/run.sh`) now passes `--user 0:0` on the OLD container, mirroring production. This reproduces the bug end-to-end (without the fix the harness fails the same way production fails); with the fix the harness passes in ~10 s. The new `scripts/release.sh` runs the harness as a mandatory gate before signing — same class of regression cannot land silently again.

### Fixed

- **Clicking a pin on a selected part no longer crashes the renderer with `Cannot set properties of undefined (setting 'fontSize')`.** The selected part's pin labels get raised into `netLabelLayer` mid-pass so they render above the netDim overlay. When `pinNetLabelBg` is on, those entries are `Container` wrappers (background Graphics + BitmapText child) rather than bare BitmapTexts. A later `acquireNetLabel` call in the same `renderSelection` walked `netLabelPoolIdx` into the wrapper's slot, cast it as BitmapText, and crashed on `label.style.fontSize` because `Container` has no `.style`. `acquireNetLabel` now skips past any non-BitmapText children at the current pool index before reusing or creating. Reported from a deployed v0.20.7 install. (`248f8eb`)

### Release pipeline

- **Single command owns the end-to-end release.** Today's v0.20.7 mishap (electron-only desktop release tagged ahead of `release.sh`'s run, then `release.sh` committed counter 17, failed at `git tag`, and exited 128 with no rollback help) exposed that nothing enforced CHANGELOG-entry presence, tag-collision detection, type-check / build preflight, update-test before signing, push, or GitHub Release creation. `scripts/release.sh` now owns all of it. Interactive `Build desktop Electron apps too? [y/N]` prompt; `--desktop` / `--no-desktop` / `--desktop-only` bypass the prompt. After GHCR push the script runs `tools/update-test/run.sh` as a mandatory sanity gate before signing. After commit + tag it pushes `main` + tag and creates a GitHub Release with the sliced CHANGELOG section + (if built) Electron zips as assets. Pre-release tags (`.beta` / `.rc` / `.alpha`) get `--prerelease` instead of `--latest`. New `--desktop-only` mode bumps `package.json` + builds + ships Electron apps + creates a GH release **without** touching `.release-counter`, Docker, manifest signing, or FTP — the recovery path for "in-app updater is fine, but desktop users need a hotfix." See `docs/RELEASE_RUNBOOK.md` for the full flag cheatsheet. (`4508c2d`)

## v0.20.7 — 2026-05-13

### Fixed

- **Board outline now reads as a clean filled rectangle on TVW files whose CAD source ships only straight edges (no corner arcs).** Some Teboview Roul Through layers encode the board edge as drill-slot line segments. `chainLines` would return dozens of 2-point sub-paths instead of one perimeter loop; `gfx.fill()` on that pile flowed PixiJS's even-odd rule across all the disconnected sub-paths and produced cross-hatched "wrong polygon fillings" (reported on ThinkPad P14s Gen 2 NM-D352). `drawOutline` now pre-passes to find the largest sub-path; when the largest is under 20 points (no real perimeter), it fills the outline-points bbox once and strokes the fragmented segments on top. Well-formed outlines (HY568, NM-D355 with its 415-pt perimeter) hit the existing path-fill branch unchanged. (`1a40813`)

- **Self-update check no longer logs a red `Check failed: HTTP 502` every 6 hours when you're already on the latest release.** After a successful self-update the install's counter file is bumped to the applied manifest's counter. The next background check fetched the same manifest, `ValidateManifest` rejected it at the `m.Counter <= installedCounter` branch (replay defence), `Check()` returned an error, the handler answered 502, and the frontend dutifully logged red. `Check()` now distinguishes the "manifest is exactly what we already applied" case (`m.Counter == installedCtr && m.Version == Version`) from a real validation failure and reports it as no-update with HTTP 200. Replay / downgrade / counter-regression cases still bubble through to the user. (`e184b94`)

- **Welcome-screen footer link points at the public GitHub repo** (was pointing at the old `inwerp/Boardviewer` placeholder URL that 404s after the public flip). (`350f636`)

### Docs

- **Welcome-screen copy refresh** — dropped stale wording from before the public release. (`cfb5f19`)

### Release pipeline

- **`NASdeploy.sh` bakes `PUBKEY` into the deployed image.** The Dockerfile defaults `ARG PUBKEY=""`; `release.sh` always read `~/.config/boardripper/release.pub` and passed it via `--build-arg PUBKEY`, but `NASdeploy.sh` only passed `APP_VERSION`. Every NAS deploy since the secure-update pipeline landed in v0.19.0 had therefore shipped with an empty PubKey baked into the binary, and every update check short-circuited at `updater not configured: PubKey is empty`. Users on a NAS deployed by `NASdeploy.sh` would see no update banner even with a fresh manifest live on GHCR + ripperdoc.de. `NASdeploy.sh` now reads `release.pub` (overridable via `$PUBKEY_FILE`) and passes it through. (`11b0959`)

## v0.20.6 — 2026-05-12

### Fixed

- **Library sidebar's search bar and stats bar regressed to scrolling with the file list.** After the post-OSS-flip change that kept all three sidebar panels mounted at once (`3267185`), each panel got wrapped in a `<div style={{ flex: 1, minHeight: 0 }}>` that expected a flex parent — but `.sidebar-content` was a plain block container, so the wrapper fell back to content-sized height. `LibraryPanel { height: 100% }` then resolved against an auto-height parent and collapsed; the search row scrolled with the list instead of staying pinned at top, and the stats bar (with `margin-top: auto`) had no room to push to the bottom — it landed at the end of the file list. `.sidebar-content` is now `display: flex; flex-direction: column` so the active panel actually claims the sidebar's height, internal scrolling stays inside `.library-content`, and pinned top/bottom rows behave like they used to. SettingsPanel and DebugPanel had the same latent issue and benefit from the same fix.

- **Library filter no longer freezes the input on large libraries.** Per-keystroke filtering was re-running `HistoryView`, `FolderView`, `LiveBrowser`, and the `filterFile` callback synchronously on every character. On a small library that's invisible; on a multi-thousand-file library the main-thread work blocked the input event loop and typing felt laggy. The filter pipeline now debounces with a 200 ms trailing delay — the input itself binds to the raw value so typed text appears instantly, only the downstream filtering waits. Empty values short-circuit the delay so clearing via the "x" button stays immediate.

### Changed

- **Toolbar "Open" button is "Upload" with an upload icon in the web build; Electron keeps "Open."** In a browser the picker reads the file into memory client-side — closer to "upload from your device" in a user's mental model than "open a path on disk." New web users were expecting an OS-style file-open dialog reaching into their library folder and clicking the button on the live site mismatched that expectation. Electron's file picker really does reach into the local filesystem, so it stays labeled "Open." Same handler, same `data-testid="open-btn"` (Playwright tests still pass on both builds), tooltip mirrors the distinction.

- **Settings ▸ Library tab now houses the library folder picker, auto-scan toggle, database info, and library prefs (auto-load bound PDFs, history depth).** They previously lived under Settings ▸ System inside a section titled "Server / Library" — a historical name from before a dedicated Library tab existed. With the Library tab covering sync and OBD already, the folder/DB fundamentals belong on the same tab. New ordering on the Library tab: **Library Folder & Database** → **Library Sync** → **OpenBoardData** (fundamentals → sync → external data). Internal section id stays `server` so per-user expansion state in localStorage carries over unchanged.

## v0.20.5 — 2026-05-12

### Fixed

- **TVW (Teboview) parser now handles two previously-unobserved variants — three sample boards that produced an empty viewer now parse cleanly.**
  - **Header `h5/h6/h7` Pascal strings.** Three pstr fields between `date` and `size1` were being read as 3 raw bytes (`const3` in eagleview). In every previously-known sample those fields are empty (3 zero length-bytes), so the raw read worked by coincidence. `samples/BROKEN/NM-D355_r1.0_HT4BT.tvw` ships one of them as `"q798"`, which shifted every subsequent header field by 4 bytes; the parser then read `layerCount = 2` instead of 20 and bailed on the first layer with "unknown object type 20." Fix: parse the three fields as Pascal strings (byte-compatible with all prior samples).
  - **Per-pin opposite-side contact count.** The trailing `u32` after each pin's name pstr was assumed to be `Z2 == 0` (eagleview asserts this). It's actually a per-pin counter for opposite-side through-hole/edge contacts. When **any** pin in a part has it set, a mirrored-contact block follows the primary pin list: `(u32 cont_flag, u32 reserved)` then `Σ ext_contact_count` more pin records (no trailing counter of their own). The previous heuristic-based `looksLikePinExtension` detector was a weaker proxy for the same signal — it over-fired on NM-D355's H11 SWITCH (2 declared pins + 1 mirrored contact, read as 2 ext-pins instead of 1) and was inconsistent on Landrex connectors. Observed in three in-the-wild patterns:
    - LianBao SWITCH (NM-D355 H11): `pinCount=2`, sum=1 — mechanical switch with one mirrored mechanical contact
    - Landrex vertical connector (Gigabyte GV-N5080 CN1): `pinCount=82`, sum=82 — every pin mirrored on opposite copper layer
    - Landrex edge connector (Gigabyte GV-R79X MPCIE1): `pinCount=82`, sum=82 — PCIe slot dual-sided
  - **Verified across the 16-file TVW corpus:** `NM-D355` 0 → 3957 parts, `GV-N5080` 28 → 3161 parts, `GV-R79X` 0 → 4825 parts. Every other working sample unchanged. The format note is captured in `docs/formats/TVW_FORMAT.md` so upstream eagleview and future parsers don't make the same `Z2 == 0` assumption.

## v0.20.4 — 2026-05-10

### Fixed

- **Library files served from cloud-sync placeholders no longer reach the parser as truncated bytes.** When the user's library mount lives on a cloud-managed filesystem (Google Drive on macOS via File Provider, OneDrive on Windows via NTFS reparse points, iCloud, Dropbox Smart Sync), the OS lazily materializes content on read. `http.ServeFile` was happy to stream whatever the kernel returned — sometimes a partial file or zero bytes — and the frontend parser would fail with "empty/truncated file." The two cloud-exposed file-serve handlers (`files.Get`, `files.GetByPath`) now route through a new `serveFileEager` (`src/backend/handlers/serve.go`) that reads the file fully into memory and verifies byte count matches `stat().Size()` before responding. Truncated reads return 503 + `Retry-After: 5`; the 30s read deadline returns 503 + `Retry-After: 10`. Frontend `fetchWithCloudRetry` retries up to 6 attempts / 3 min, surfaces a "Downloading from cloud storage…" toast on retry, and surfaces an error toast on exhaustion. `databank.PreviewGet` deliberately keeps `http.ServeFile` — previews live in the always-local `<dataDir>/.previews/` and benefit from `ServeFile`'s ETag/304 caching there.

- **Docker-bound cloud placeholders surface a clear "materialize on host first" error** instead of a generic 500. When BoardRipper runs in a Docker container on macOS with a Google Drive folder bind-mounted as the library, the FUSE bridge can't drive host-side materialization and reads return `EDEADLK` (resource deadlock avoided). `serveFileEager` now detects this specific error and returns 503 with a body that tells the user how to fix it: "Cloud-storage placeholder: file not yet materialized on host. Open it on the host (Finder → right-click → 'Keep on this device' for Google Drive/iCloud, equivalent for OneDrive) or sync your library to a fully-local directory." Native macOS reads of the same placeholder block 1–2 seconds for materialization and succeed normally — `EDEADLK` only fires inside the container, so the friendly error is scoped to the case where it's actually useful.

### Trade-offs

- Range-request and `ETag`/`If-Modified-Since` caching are dropped on the two affected handlers. No current consumer relied on either (boardview parsers always read from byte 0; PDF.js doesn't issue range requests in the current implementation).
- 512 MiB cap on in-memory reads in `serveFileEager`. Boardview files are <10 MB, PDFs <100 MB; the cap is a safety net, not a hot path.

## v0.20.3 — 2026-05-10

### Fixed

- **OpenBoardData index now survives container updates.** OBD cache was rooted at `<libraryDir>/.boardripper/openboarddata/`. The library mount is `:ro` by default in Docker, so atomic writes silently failed and the index was effectively in-memory — gone on every container restart, including the restart triggered by self-update. Users had to re-sync (`POST /api/obd/index/sync`, ~2 min) after every release. Cache now lives at `<dataDir>/obd/`, which is the always-writable persistent volume by design. Existing caches at the legacy path are auto-migrated on first boot via `obd.MigrateLegacyCache`; cross-volume rename failures (typical when `/library` and `/data` are different mounts) fall back to a one-time re-sync. `obdStore` is no longer library-conditional — OBD works on fresh installs that haven't configured a library yet.

- **Library "Browse" tab respects the search filter in live-filesystem mode.** Typing into the filter input had no effect when the user was browsing live (`viewMode === 'folders' && browseMode === 'live'`). The filter wired to the database-backed `FolderView` was silently dropped on the `LiveBrowser` side. `LiveBrowser` now receives `searchFilter` from the same `localSearch` state every other view uses, applies a case-insensitive substring filter to both directories and files in the current directory. A directory whose name matches stays visible so the user can navigate toward something they remember the parent name of. No descent into subdirectories — that stays as future work.

## v0.20.2 — 2026-05-09

### New

- **Right-click context-menu selection header.** A muted, smaller-font line at the very top of the menu shows what Copy / Search will act on: `<component> · pin <pinId> · net <netName>` in board mode, or the cursor word in PDF mode. Hidden when the relevant fields are empty. Removes the "wait, what am I about to copy?" pause that the new icon-strip introduced in v0.20.1.

### Fixed

- **Right-click menu was blocking ~1 s on bound PDFs.** `pdfStore.countTextMatches` walked every line of every page synchronously, called 3× per PDF donor (default query, chip@pin variant, net variant), all before the menu rendered. With one bound PDF that's 3 sync scans gating the open. New `countTextMatchesAsync` yields every 8 pages via `setTimeout(0)`; ContextMenu dispatches the counts in a `useEffect` after first paint and replaces `(…)` placeholders as each promise resolves. AbortController cancels stale work when the menu closes or the selection changes. Board counts (`countInBoardTab`) stay sync — they walk in-memory parsed objects, not text.

### Docs

- **README has a Keyboard Shortcuts section** covering the new game-style shortcuts (WSAD, Q/E, Shift+W/S), the `~` library toggle (with the layout note about Backquote / IntlBackslash and the AZERTY caveat), and the configurable Settings ▸ Navigation knob.

## v0.20.1 — 2026-05-08

### New

- **Game-style keyboard shortcuts** (WSAD pan, Q/E rotate, Shift+W/S zoom, `~` toggles Library sidebar). Pan and zoom work on both board and PDF panels; rotate is board-only and silently no-ops on PDF. Library toggle binds to the physical key left of `1` via `KeyboardEvent.code` ('Backquote' on US, 'IntlBackslash' on German Mac), so `~` on US, `°` on German DE both fire the same toggle. Existing Cmd+arrow / Space / Cmd+F shortcuts unchanged. Auto-rendered in Settings ▸ Shortcuts and the home-screen Getting Started card under a new "WSAD Navigation" section. Pan and zoom step sizes configurable in Settings ▸ Navigation ▸ Keyboard pan / zoom (default: 10% of screen per pan, ×1.32 per zoom press; previous defaults were 15% / ×1.72).

- **Right-click context-menu icon strip.** A new top-of-menu icon row with up to 4 board buttons (Copy net, Copy part, Search net, Search part) or 2 PDF buttons (Copy, Search Web) for the cursor word. Copy uses `navigator.clipboard.writeText` with toast feedback; Search opens Google in a new tab with `noopener,noreferrer`. Strip hides entirely when no entity is selected. The existing donor-row search functionality is unchanged below.

- **Shortcut schema gained `code` (KeyboardEvent.code, single string or array for multi-layout binding), `displayLabel` (formatter override), and `ignoreShift` (matcher accepts shift-held events when set, used by the `~` library toggle so Shift+Backquote fires the same as bare Backquote).** Foundation for layout-aware keybinding (AZERTY remapping is queued for a future release).

### Fixed

- **The keyboard matcher was permissive about un-required modifiers.** `if (!requireShift && e.shiftKey) return false;` was missing — bare `W` would match `Shift+W` events, blocking the new zoom shortcut from registering distinctly. Added the symmetric guard. The `Shift+Cmd/Ctrl+F` "previous match" path (documented in the focusSearch shortcut description) re-enters with `{ ...focusSearch, shift: true }` so the routing block still receives both directions.

- **Pin labels were being painted under the highlight ring**, so the ring's stroke clipped the bottom of pin numerals on selected nets. Renderer now stacks labels above the ring graphics so the typography reads cleanly on top, and the ring stroke pops past the label outline rather than through it. (Reported by the user on a Quanta board where 0402 caps were unreadable on a selected ground net.)

## v0.19.9 — 2026-05-08

### Fixed

- **Self-update was silently broken on Synology DSM Container Manager.** v0.19.7 hardcoded the Engine API path to `/v1.44/` to fix Docker Engine 29.x rejecting `/v1.41/` as "too old"; the same hardcode now broke Synology DSM (Docker 20.10.3, max API 1.41) which rejects `/v1.44/` as `client version 1.44 is too new. Maximum supported API version is 1.41`. Every code path through `docker.sock` — pull, load, inspect, orchestrate — hit the same 400. Bundle-drop also affected (shares `dockerLoad`). User-reported on the maintainer's NAS, manual SSH swap was the only escape until this release. Fix: probe `GET /_ping` once on first use, parse the daemon's `Api-Version` header, and prefix every Engine API call with that. `sync.Once`-gated; falls back to `v1.41` if `/_ping` itself fails (in which case nothing else would work either, but no panic at first use). Replaces all 13 hardcoded `http://docker/v1.44/...` strings; the orchestrator shell script's `API=` line gets the same value via `Sprintf` so the alpine-curl payload speaks the same dialect. Forward-compatible to whatever Docker bumps the floor to next.

## v0.19.8 — 2026-05-08

### Fixed

- **Net highlights resolved to wrong parts on any file with ≥1 BOM-alternate cluster.** `buildRenderedBoard`'s filtered branch (BOM-alternate filter / hide-ghosts toggle) returned `nets: rev.nets` from before any parts were dropped. `Net.pinIndices` are positional `partIndex` refs into the array they were built against — after dropping a single part every index past that slot pointed one element off in the filtered array, scrambling every net on the board. Latent since `176cced` (2026-04-14, hide-ghosts toggle, default off — almost no one hit it). Default-on as of `48ce8ae` (2026-05-05): BOM-alternate cluster filtering with `showBomAlternates: false` default means any CAD/TVW file with ≥1 detected cluster drops one part on first render. ROG STRIX RTX 4090 sample (1 cluster, C1903/C1906) was the user-reported canary — clicking PC101 lit PC104 / PC258 / C415 instead of PC265, and 12V_F_R1's 36 refs landed on a completely different 27 parts than the file actually says. Fix: rebuild nets via `buildNets(filteredParts)` whenever any part is dropped. Regression spec asserts every `pinIndex` in every net resolves to a pin actually on that net after filtering.

## v0.19.7 — 2026-05-07

### Fixed

- **Self-update was silently broken on Docker Engine 29.x** (the floor for fresh Docker Desktop installs from January 2026). The in-binary updater hardcoded the Engine API path to `/v1.41/`; Engine 29 rejects that with HTTP 400 (`client version 1.41 is too old. Minimum supported API version is 1.44`). The first call (`findSelfContainer`) parsed the `{"message":...}` error body as a `[]struct` and failed with `cannot unmarshal object into ... []struct`; `tagPrevious` warned and continued, but every later docker.sock call also 400'd and the orchestrator was never created — Apply silently bailed out part-way. Bumped all Engine API URLs to `/v1.44/` (single `dockerAPIVersion` constant; keeps Docker 25+ compatibility — the floor on current Synology DSM Container Manager). `findSelfContainer` now also checks `resp.StatusCode` and surfaces the error body so the next floor bump shows up as `Docker API HTTP 400: ...` instead of an unmarshal error.
- **Apply errors were dropped on the floor by the HTTP handler.** `go h.upd.Apply()` discarded the return value, and several pre-orchestrate failure paths (manifest sha mismatch, `findSelfContainer` failure, etc.) returned without first logging a `status: error` progress entry. The frontend's SSE stream would just go silent and the UI hung on "Updating…" until the 2-minute health-poll timeout. New `Updater.PushError` helper funnels the return value into the SSE channel as a terminal error entry; `ApplyBundle` got the same treatment.
- **`waitForRestart` reloaded the page against the about-to-die backend.** `Apply()` returns the moment the orchestrator container is *launched*, but that orchestrator's first action is `apk add curl` (5–15 s) before it stops the running container. During that window `/api/health` on the OLD container returned 200 happily — the previous loop accepted that as "swap done" and reloaded the page right back into the dying backend. The user then saw a "rolled back" log line and sat on the unchanged UI until the next 30-minute background poll. Now waits for an authoritative `/api/update/status` to report the manifest's expected new version (cookie survives the swap because the per-install secret persists in `/data`); falls back to a downtime-then-up `/api/health` sequence if status auth races. Reload only fires when the swap is real.
- **Slow two-finger trackpad scroll on the PDF panel zoomed instead of paging.** Two related causes: (1) the `wheelDetection` burst-latch in `scroll-mode.ts` was defaulting every new burst to "wheel" — slow trackpad scrolls (gaps >35 ms — never reach the 6-fast-cadence demotion threshold) stayed latched and got reinterpreted as zoom. The first event of a new burst is now classified by signature (large integer `deltaY` with no `deltaX` → wheel; `ctrlKey`, `deltaX`, small magnitude, or fractional → trackpad), preserving the original Mac smooth-scroll mid-burst-flip fix while fixing slow trackpad scrolls. (2) The PDF panel's wheel handler no longer consults `looksLikeMouseWheel` at all — the safety net's purpose ("classic mouse wheel + pan mode = unusable") is board-only; on PDF, bare wheel scrolling is the natural way to walk through pages even with a real mouse wheel. Pinch (`ctrlKey`) still routes to zoom.

### Tooling

- **End-to-end self-update harness (`tools/update-test/`).** Builds OLD + NEW docker images pinned to a throwaway minisign key + a local Python http.server mirror at `host.docker.internal:18000`, signs a mock release manifest, starts the OLD container with `/var/run/docker.sock` mounted, and drives Playwright headless Chromium through the full apply→swap→reload, screenshotting every 2.5 s into `results/`. Asserts overlay visibility during restart, version flip via `/api/update/status`, and absence of JS crashes during the disconnect window. The harness reads `__brUpdateStore.{updating,restarting,progress.length}` directly via a deliberate `window` export so it can probe internal state without walking the React fiber. One command — `cd tools/update-test && ./run.sh` (add `BR_HARNESS_HEADED=1` to watch). Cached re-run completes in ~1 minute. **Run before any future updater change.**

## v0.19.6 — 2026-05-07

### Fixed

- **Small pins were unselectable in chain-adjacent / search-dim / spotlight modes.** PixiJS v8 Graphics inherit `eventMode` from their parent — the viewport is interactive (so pins receive clicks), so every Graphics added underneath was *also* interactive and any painted pixel under the cursor counted as a hit. The full-board dim layer drawn in those modes silently swallowed clicks before they reached the pin sprites; tiny 0402 caps and dense BGA pins were the worst affected. Decoration layers now explicitly set `eventMode='none'` at construction *and* at every `renderSelection` (the latter is an HMR safety-net — Vite replaces the module without re-instantiating the PixiJS Application, so layers in a hot-reloaded session would otherwise stay stale on `'auto'`). User-reported as "extreme regression."
- **XZZ multi-board packs were sometimes globally folded into one mirrored slab.** iPhone14 Pro/ProMax combined boardview was the canary — its tall portrait boards produce a strong mid-Y centroid gap (the empty CPU centerlines stacked on top of each other) that beat the X-direction inter-board gaps and slipped past the balance checks in `findFoldAxis()`. Now early-returns when the outline decomposes into ≥4 connected components that all pair off by `(width, height, segCount)`; per-board X-fold axes from `boardGroups` are the only thing the UI applies, with manual per-board folding still available from the sidebar. PARSER_VERSION bumped to invalidate cached entries.
- **Board rotation now pivots around the viewport's current focus**, not the board's geometric centre. Rotating while looking at a non-centred region used to slide that region off-screen. Implementation captures the viewport's world-centre before `applyFlips`, then pans so the same world point lands at screen-centre again after the rotation completes. Net-line geometry is now also recomputed and redrawn immediately on rotation (previously stayed at pre-rotation world positions until the next selection/pan/pulse-tick).
- **Flip-axis toggle now stays screen-stable across rotation.** Rotating to 90°/270° silently inverted the meaning of the flip-axis button — the stored hinge is a board-axis, but the user picks a *screen* direction. `rotateFlipAxis()` now flips the stored `'x'|'y'` whenever rotation crosses an axes-swap boundary so the screen direction the user selected is preserved. Toolbar icon and tooltip ('⇅ Vertical' vs '⇄ Horizontal') reflect the actual screen-axis result.

### New

- **180° rotation button** between the CCW/CW arrows. Repair work is dominated by boards photographed from the wrong end; one click is faster than two.
- **Rotation disabled in butterfly mode** with an explanatory tooltip — rotating a side-by-side spread tilted the joint off-screen, and the auto-separation axis logic didn't track manual rotation.
- **Public landing page** at <https://www.ripperdoc.de/boardripper/>. Plain HTML5, no JS, deployed via the RipperDocWeb rsync. Lives in `landing/`, excluded from the Docker image (the Dockerfile only `COPY`s `src/frontend/`, `src/backend/`, and `Board Database/boards.db`). See `landing/README.md` for the update workflow.

### Performance — renderer hot-path

Four findings from the 2026-05-07 review report; all sub-millisecond individually, compounding under sustained interaction. The bundle was reverted once when its `eventMode` interaction with the dim-layer bug surfaced as a click-blocking regression, then re-introduced piece by piece after that bug was traced to a separate root cause and fixed independently.

- **R-1** — restored G-3's zero-allocation property for the net-line render path. Per-pulse-frame `Map<color, Segment[]>` and `{start,end}` wrapper allocations (added in `a9d99b4` for chain-adjacent) are now built once in `recomputeNetLineSegments` (already dirty-tracked) as `netLineSegmentsByColor`. ~30 allocs/frame → 0 (single net) or ~150 → 0 (chain-adjacent on a 60-net rail).
- **R-2** — replaced `[...adjacentNets].sort().join(',')` sentinel with `.size` compare in `lastRenderedSel`. Content changes always co-occur with a change in `(partIndex, pinIndex, highlightedNet, board)` — the BFS inputs — so size is a sufficient sentinel. Saves ~0.05–0.3 ms per store notify on a 60-adjacent rail; biggest win during search iteration / PDF-binding refresh.
- **R-3** — pulled the OBD tooltip lookup off the per-`pointermove` path. `formatObdForNet` was running 6 regex tests + O(matches × |nets|) per move (~4 500 string compares on a 3-variant × 1 500-net board). Now: `obdNetIndex(boardNumber)` exposes a snapshot-keyed `Map<netName, ObdNet[]>` cached on a `WeakMap` keyed by the obd-store snapshot, and `BoardRenderer` memoises `extractBoardNumberFromFilename` against `boardStore.fileName`. Per-move cost: 1 string compare + 1 `Map.get`.
- **R-4** — promoted `crossSideGhostParts` from `number[]` to `Set<number>`. Two `.includes()` calls in the per-pin chain-mode net-line builder were O(g) linear scans called for every pin reference of every active net (~30 000 array scans → ~600 hash lookups on a busy 5 V rail with 60 nets, 10 pins, 50 ghosts).

### Updater hardening

Closes the two Important findings from `docs/analysis/2026-05-07-updater-security.md`. The crypto primitives were already well-covered; these tighten the surrounding I/O envelope.

- **Enforce `released_at` freshness window in `ValidateManifest`.** The existing check rejected expired manifests (90-day `not_after`) but ignored `released_at`, so a compromised mirror could re-serve any signed-but-stale manifest from anywhere in the 90-day window — defeating the counter check on first install (where `installedCounter == 0` skips), and freezing installed clients on outdated releases. Now requires `released_at ∈ [now − 30 d, now + 24 h]`. The 30 d past bound is wide enough not to bite the maintainer's normal cadence (5 releases in 9 days during the v0.19 cycle); the 24 h future slack tolerates clock-skew between signing host and client. Manifests without `released_at` are rejected outright.
- **Cap, time-out, and stream-verify the tarball download.** `downloadAsset()` previously did a plain `http.Get()` with no timeout, no size cap, and no streaming integrity check; `applyTarball` then re-read the whole tarball off disk to compute SHA-256, doubling peak RAM. New `downloadAssetVerified()` does it in one streaming pass: 10 min `http.Client.Timeout`, body cap = manifest's signed `SizeBytes` (or 1 GiB legacy fallback) by reading one byte past the cap so over-long streams are observed not silently truncated, incremental SHA-256 via `io.MultiWriter(file, sha256.New())` so peak memory stays at io.Copy's 32 KiB buffer. Rejects on size mismatch, SHA mismatch, or non-200.
- **Test coverage for orchestration helpers.** v0.19.2 (image-ref form), v0.19.3 (ghost-pulse), and v0.19.4 (healthcheck-by-name) all regressed in the orchestration layer despite well-tested crypto primitives. `parseDockerImageRef` and `selectNewImageRef` extracted as pure functions and covered with 25 tests across `parseDockerImageRef` (6 forms incl. embedded-colon-in-digest), `selectNewImageRef` (4 paths incl. the v0.19.2 fallback case), `extractBundle` (path-traversal guard, bsdtar/gnu `./` parity, ignored-extras), `bindsFromMounts`, and `shortID`.

### Release pipeline

- **Multi-arch INDEX digest is now captured for both the BoardRipper image and the orchestrator alpine.** Two same-class fixes: (a) `release.sh` was reading `--raw | jq '.manifests[0].digest'` for the BoardRipper image, which grabs the *first* platform manifest (amd64) from the multi-arch index, then signing that amd64-only digest into `manifest.json`. amd64 hosts pulled fine; an arm64 install would error. Now uses the non-raw `imagetools inspect`'s top-level `Digest:` line, hard-failing if the parse returns empty. (b) Same bug class on `alpine:3.19` for the orchestrator: `docker pull --platform linux/amd64` then `RepoDigests[0]` gave the per-platform manifest digest, not the index digest. Now pulls without `--platform` and reads via `buildx imagetools`. v0.19.5's NAS deploy was unaffected because the maintainer's NAS is amd64-only.

## v0.19.5 — 2026-05-06

### New: update-in-progress modal

When the user clicks **Update Now**, BoardRipper now shows a centered modal: *"Update in progress — the page will reload automatically in 30–60 seconds."* The modal stays up across the SSE-disconnect window (the orchestrator deliberately stops the running container, killing the progress stream — that is the **expected** success path, not a failure). Once the new container's `/api/health` responds, the page reloads automatically; the modal vanishes.

A `boardripper-update-in-flight` flag in localStorage persists across page refreshes mid-update — refreshing the tab while the update is in flight no longer presents a fresh dashboard with an "Update" button that could be clicked again. The flag is cleared on completion or after 5 minutes (whichever comes first). Backend health-poll runs every 2 seconds for up to 120 seconds while waiting for the new container.

### New: drop-to-update fallback

When the in-app update button can't reach GHCR or ripperdoc.de — or when a future broken-orchestrator bug strands an install — users can now download a single bundle file and drag it onto the BoardRipper window to apply the update. Each release publishes `boardripper-update-vX.Y.Z.tar` (and a stable `latest-update.tar` alias) at <https://www.ripperdoc.de/boardripper/releases/>. The bundle contains the signed manifest, its signature, and the OCI image tarball; the running container verifies the signature against its compiled-in public key, validates counter/expiry/min-version, checks the tarball sha256, then runs the same orchestrator restart as the network path. Same trust envelope: only the manifest signature grants trust; the file itself is untrusted bytes until verification passes. Recovery escape-hatch for any future broken-self-update situation, but only available once the running container is on v0.19.5+.

### Internal

- `update-store.ts` gains `restarting` / `restartingFromVersion` getters and an internal `streamProgress()` + `waitForRestart()` flow shared between `apply()` and `applyBundle()`.
- New `UpdateProgressOverlay` React component, mounted at the App root, gated on `updateStore.restarting`.
- New backend endpoint `POST /api/update/apply-bundle` (multipart upload, same auth-cookie middleware as the other `/api/update/*` routes).
- New helper `updater.ApplyBundle([]byte)` reuses every existing piece (`VerifyManifest`, `ValidateManifest`, `VerifyTarballSHA256`, `dockerLoad`, `orchestrateRestart`).
- `release.sh` now produces `out/boardripper-update-$VERSION.tar` alongside the regular tarball and uploads it to FTP atomically.
- `scripts/release/site-artifacts.sh` no longer requires `pandoc` — built-in renderer (perl + sed + awk) handles the BoardRipper CHANGELOG.md format. Without this, missing pandoc on the maintainer's machine silently uploaded a 141-byte stub instead of the rendered changelog.

## v0.19.4 — 2026-05-06

### Fixed

- **Auto-update silently rolled back on default Docker bridge.** The orchestrator polled `http://<container-name>:8080/api/health`, but Docker's default bridge network does not provide DNS-by-name for containers (only user-defined networks do). The poll never resolved, the 60-second healthcheck timed out, and the orchestrator restored the previous container — looking from outside as if "the update silently undid itself." Fix: query the new container's IP via `containers/{id}/json` and poll that IP. Falls back to name lookup if IP can't be parsed (preserves user-defined-network behavior).
- **Status bar showed wrong version after update** (e.g. `0.19.0` while backend was on `0.19.2`). The frontend bundle injects `__APP_VERSION__` from `src/frontend/package.json` at build time, which was being bumped by hand. The backend version comes from `release.sh`'s `--build-arg APP_VERSION`. The two drift apart whenever release.sh runs without a prior `package.json` edit. Fix: `release.sh` now writes `$VERSION` (sans `v` prefix) into `package.json` before the build, then commits the change as part of the release commit. Single source of truth from this release on.

### Migration note

Existing v0.19.0–v0.19.3 installs cannot auto-update to v0.19.4 (their bundled orchestrator still has the healthcheck-by-name bug). One manual `docker pull ghcr.io/alexeyinwerp/boardripper:v0.19.4 && recreate-container` is required. After landing on v0.19.4 once, future auto-updates work normally.

## v0.19.3 — 2026-05-06

### Fixed

- **Cross-side ghost outlines no longer flash and tank framerate during pan/zoom.** The ghost-pulse animation was rebuilding the entire `crossSideGhostGfx` Graphics object every tick (clearing, recomputing each part's polygon/bounds, drawing fill+stroke+pins), running at 60 fps regardless of whether the user was interacting. On boards with many hidden-side parts on a selected net, this competed with viewport updates and produced visible stutter. On top of that, `onZoomFrame()` was clearing the ghost geometry on every zoom frame, so during continuous wheel scrolling the ghosts vanished and reappeared on each 32 ms settle, producing the visible "flash".
  - Net-line + ghost pulse now freezes for a 100 ms window after every viewport `'moved'` event; pan and zoom no longer pay the per-frame Graphics rebuild. Phase doesn't advance during the pause, so the breathing resumes jump-free once the viewport settles.
  - The ghost gfx is no longer cleared in `onZoomFrame()` — ghost stroke widths are world-space and stay visually correct at any zoom, so the ghost stays drawn (frozen at last alpha) during zoom instead of vanishing/reappearing.

## v0.19.2 — 2026-05-06

### Fixed

- **Self-update would leave the host with no running container** when updating from v0.19.0 or v0.19.1. The orchestrator built the new container's image reference as `boardripper:<version>` (a leftover from the legacy tarball-load deploy convention), but the GHCR pull stores the image as `<registry>@<digest>` with no local named tag. The Docker daemon returned 404 on `containers/create`, the orchestrator's `set -e` killed the script before the rollback path could run, and the old container was left renamed to `-old` and stopped.
  - Now uses the canonical `<registry>@<digest>` reference, falling back to `<registry>:<tag>` if the digest is absent. Both pull-by-digest and tarball-load paths resolve correctly.
  - **Existing v0.19.0 / v0.19.1 installs cannot auto-update to v0.19.2** because their bundled orchestrator still has the bug. One manual `docker pull ghcr.io/alexeyinwerp/boardripper:v0.19.2 && recreate-container` is required. After landing on v0.19.2 once, future auto-updates work.
  - Recovery procedure for anyone hit by this on v0.19.0/v0.19.1: `docker rename boardripper-old boardripper && docker start boardripper` puts the host back on the old version.

## v0.19.1 — 2026-05-06

First release through the new pipeline end-to-end (no GitHub Actions). Pure cosmetic fixes; **the update flow itself is what's being validated.**

### Fixed

- **Quick settings labels on the home dashboard** now read identically to the Settings panel. Previously the dashboard showed glyphs (⇧ ⌃ ⌘ ⊞) and a half-translated `Cmd+Scroll / Win+Scroll` form for the PDF meta slot, while the Settings panel said `Shift + Scroll / Ctrl + Scroll (fast)` and `⌘ + Scroll / Ctrl + Scroll`. Both surfaces now use the same wording.
  - Slot labels: `Left-drag`, `Shift + Left-drag`, `Scroll`, `Shift + Scroll / Ctrl + Scroll (fast)`, `⌘ + Scroll` (Mac) / `Ctrl + Scroll` (Windows/Linux).
  - Row labels tidied: `Board: CLICK+DRAG` → `Board: Drag`; `Board: 2Finger/Scroll` → `Board: Scroll`; `PDF: Scroll` consistent.
  - Hint tooltips also match: "Drag pills between slots to reassign scroll actions."
- **Settings page subsection** "Mouse drag behavior" renamed to "Trackpad/Mouse drag behavior" — matches the QuickSettings hint already in place.

### Internal

- `scripts/release.sh` no longer uses the unsupported `lftp mv -f` syntax — atomic rename now does explicit `rm -f && mv`. (Already fixed in `84308b3`; this is the first release that benefits.)

## v0.19.0 — 2026-05-05

### New: secure update pipeline (replaces GitHub-token flow)

Updates no longer require `GITHUB_TOKEN`. Each release is now signed offline by
the maintainer (Ed25519 / minisign), and the running container verifies that
signature against a public key compiled into its own binary before applying any
update.

**For end users:** you can remove `GITHUB_TOKEN` from your `docker-compose.yml`
after this update. The toolbar update button keeps working with no token. If you
prefer to update manually, both sources are public and free:

```bash
docker pull ghcr.io/alexeyinwerp/boardripper:latest
docker compose up -d
```

…or the signed-tarball mirror (no Docker registry required, useful behind
firewalls):

```bash
curl -O https://www.ripperdoc.de/boardripper/releases/latest.tar.gz
docker load < latest.tar.gz
docker compose up -d
```

**What changed under the hood:**

- **Two delivery sources.** `ghcr.io/alexeyinwerp/boardripper` (public registry,
  fast layer dedup) and `https://www.ripperdoc.de/boardripper/` (signed tarball
  mirror). Updater walks them in order and accepts the first source whose
  manifest signature verifies. A hijacked mirror cannot deliver a forged update.
- **Manifest schema.** `manifest.json` carries `version`, `counter`,
  `released_at`, `not_after`, `important` flag, image digest, and tarball
  sha256. Replay/freeze attacks closed by a monotonic counter; dropped manifests
  closed by a 90-day expiry.
- **Notify-only UX, no auto-apply.** Updates appear as a banner; nothing
  installs without you clicking. Releases marked `important` (security fixes)
  show with a red banner instead of the normal blue.
- **Healthcheck-based rollback.** If the new container fails its healthcheck
  within 60 s of starting, the orchestrator auto-reverts to the previous image.
- **Per-install auth on `/api/update/*`.** A 32-byte secret is generated on
  first boot (`/data/.update-secret`, mode 0600). LAN drive-by requests to
  `/api/update/apply` now return 401. The web UI bootstraps an `HttpOnly +
  SameSite=Strict` cookie on first load.

Maintainer release runbook: `docs/RELEASE_RUNBOOK.md`.

### Fixed

- Polyfilled `Promise.withResolvers` for older browser engines (R3dfox / Mypal
  on Win7 etc.). pdfjs-dist@5 calls it directly and would throw before any PDF
  byte was read.

### Misc

- Landing page footer credits "Alexey Lavrov / RipperDoc Munich".
- `CLAUDE.md` documents the `landing/` folder workflow.

### Bridge release note (one-time)

This release is the last one published to the private GitHub Releases page —
it's the bridge release that moves existing token-using clients onto the new
system. From v0.19.1 onward, releases will only appear at GHCR + ripperdoc.de.

---

## v0.18.1 — 2026-05-05

### Fixed

- **FZ load failures on real-world ASUS / MSI / ASRock boardviews.** The dominant variant in our 116-file NAS corpus (84%) carries an undocumented 4-byte forward-pointer that strict zlib decoders reject as trailing junk. We now detect and trim it before decompression, and we replaced the browser-native `DecompressionStream` with `pako.inflate` for tighter error reporting. Combined fix: ~80% of previously-broken FZ files now load.

## v0.18.0 — 2026-05-05

### New: themes — accent / background / chrome split

Themes are now two independent surfaces. The `THEMES` registry covers **board-side** concerns only (pin colours, part fills, background-of-board) and the board adopts whichever entry matches its file family. **UI chrome** obeys three independent knobs the user can set from the QuickSettings home dashboard or from Settings ▸ Themes:

- `accent` — buttons, focus rings, primary chrome (with auto-flipped text colour against perceived brightness)
- `background` — app shell background
- `chrome` — toolbar / status bar / sidebar chrome

Five accent presets ship: BoardRipper default (recoloured away from generic AI-cliché blue), and four ATARI homages (Pantone Bright Red C plus the Atari 2600 silver-label rainbow stripes). Each knob persists separately.

### New: Mentor Boardstation Neutral parser

11th supported format. Mentor Graphics Boardstation/Expedition exports a plain-text "neutral file" with the `.cad` extension shipped with some Samsung / Quanta / Compal / Acer notebook board packages — **not** GenCAD despite the shared extension. Detection cue: `# file : ...` first comment + `BOARD ... OFFSET ... ORIENTATION` record + `###Section` banners. Outline is synthesized from drill-hole geometry. See `docs/formats/MENTOR_NEUTRAL_FORMAT.md` for the full spec; AGPL provenance recorded in the spec footer.

### New: board-overlay search dropdowns + customizer

The floating in-canvas overlay (top/bottom toggle, flip-axis, parts/nets filters, dim-mode tri-state, selection-name label) is now slot-driven and user-customizable. Drag-and-drop in Settings ▸ Board overlay reorders or hides slots; "Add separator" inserts a divider; layout is persisted. Parts and Nets dropdowns use a shared popover scaffold with a memoized natural-sort index (refdes-aware) and a No-Connect partition for nets.

The dim-mode button cycles three states (off / search-dim / spotlight) — spotlight is a smooth dark gradient with a clear core sized to the selected component; selected pins draw above the spotlight so the component stays fully bright.

### New: home dashboard — bindings matrix + behaviour toggles

The HomeBackdrop dashboard now carries a Bindings matrix (board↔PDF associations from the library) and Behaviour toggles (auto-open PDF on board load, theme switch). The QuickSettings strip got a compact accent picker.

### Fixed

- **Allegro pad rotation on diagonally-placed footprints.** 45° QFNs and similar non-axis-aligned packages now render with correctly rotated pads.
- **`useThemeOverrides` `useSyncExternalStore` infinite loop.** Snapshot now caches a stable reference; the same fix shape applied to HomeBackdrop earlier in the cycle (`01eda1c`).
- **Settings panel crash guards** for the new overlay/themes subtree (`?? DEFAULTS` + try/catch defensive paths in fresh code).
- Browser-native page-zoom (Ctrl+/Ctrl-/Ctrl+wheel-on-page-chrome) no longer fires inside the BoardRipper window — would previously double-count with the in-canvas zoom.

### Internal

- `theme-store.ts` consolidated; the parallel registry shipped as a stop-gap was dropped.
- `boardOverlay` slot registry under `components/BoardOverlay/` with per-slot toggle components and a Separator slot.
- `panToPart` / `panToNetIfOffscreen` helpers added in renderer; focus-zoom capped at 3× fit-to-board scale.

## v0.17.1 — 2026-05-04

### New

- **PixiJS `CullerPlugin` enabled.** Off-viewport pin labels and parts no longer pay GPU per frame; expect 5–20× p95 improvement at deep zoom on dense boards. Closes a long-deferred research item.
- **Opt-in WebGPU backend** (PixiJS will fall back to WebGL if unavailable). Off by default.
- **Tidier QuickSettings home dashboard** — Library stats and Cache actions hoisted above the keyboard-shortcut instructions.

### Fixed

- Part-hull polygon now generates a tighter axis-aligned chip-layout guard, fixing selection misses on small chip caps near component-clusters.

## v0.17.0 — 2026-05-03

### New: Cadence Allegro v15.x BRD support

A second Allegro parser family. v15.x (magic `0x0012XXXX`) is a different binary from the v16/v17 family already supported (`0x0013XXXX`) — different header, different block table — but many block payloads are shared. Reverse-engineered blind from a 15.5.7 / 15.5.2 corpus over the previous week:

- Component definitions (LL_0x06), footprints (LL_0x2B), placements (BLK_0x2D), refdes strings (BLK_0x07), nets (LL_0x1B), pad geometry (BLK_0x48), pin-net assignment (Route 5: BLK_0xC8 back-link + multi-layer variants).
- **99.4%** perfect net coverage on the 15.5.7 corpus, ~92.7% on 15.5.2 (variant-split documented).
- A per-component oracle correctness gate runs in CI to prevent regressions.

Spec: `docs/formats/ALLEGRO_V15_FORMAT.md`. Future-work items captured inline.

### Fixed

- **BDV `BRDOUT: 0 0 0` (zero outline) regression.** v0.17.0-development restored the max-part-Y mirror axis fallback for files that ship a zeroed BRDOUT (e.g. creator 1457685 / DAG3BEMBCD0 — HP 17-an100 Quanta G3BE). Canary regression test pins it.

## v0.16.15 — 2026-05-03

### Fixed

- **Library sync no longer re-downloads zero-byte files forever.** A long-tail of intentionally-empty files (placeholder schematics, `.gitkeep`-shaped markers) was bypassing the local-cache "skip if same size" check because zero-size compared as falsy in the diff path; we now treat 0 as a real size.

## v0.16.14 — 2026-05-03

### Fixed

- **Library sync errors are now surfaced in the UI** instead of silently logging. The Settings ▸ Library section shows the most recent sync's status (success/fail/in-progress) and the failing path; a "Retry" button re-runs the failed step.

## v0.16.13 — 2026-05-03

### Fixed

- **Library sync manifest parser preserves spaces in paths.** WebDAV PROPFIND responses with `<D:href>/Library/Apple iPhone 14/...</D:href>` were splitting on the space; sync skipped any board folder whose name contained a space. Fix: parse `<D:href>` as a single token, URL-decode after extraction.

## v0.16.12 — 2026-05-03

### Fixed

- **Library sync diff phase no longer blocks for hours.** The diff was doing a per-file HEAD on every remote candidate, which on a 60k-file mirror added minutes-to-hours before any actual transfer started. We now use the manifest's enclosed PROPFIND size+mtime as authoritative and reserve HEAD for tiebreakers.

## v0.16.11 — 2026-05-02

### New: library sync (WebDAV pull)

A scheduled background sync pulls a remote WebDAV-served library mirror into the local `/library/` mount. Settings ▸ Library exposes the endpoint, schedule, and a "Sync now" button. Diff-then-fetch semantics; per-file resume; never deletes remotely-missing files (Phase 1: pull-only). Useful for repair shops who keep an authoritative library on a NAS or office server and want every workstation to mirror it without manual copy.

### Performance

- **Net-line pulse skips when the page is hidden or the window is unfocused.** Browsers had been paying the 60 fps Graphics rebuild cost on background tabs; cutting it slashes the renderer's idle CPU.

## v0.16.10 — 2026-05-02

### New

- **Per-tab sidebar isolation.** Each BoardViewer panel tab now keeps its own sidebar selection, scroll position, and overlay-toolbar state. Switching tabs no longer wipes the Component Info pane in the other tab.
- **InfoTab OBData notes.** OBD readings (Diagnosis, Notes, Photos) now appear in the BoardSidebar InfoTab the same way they appear in the LibraryPanel's ObdSection.
- **TVW BOM-variant + ghost detection.** TVW boards now light up the Revisions tab — bbox-overlap clustering catches stacked-cap "alternate parts" that share refdes but differ in value. The per-pair swap button (added in v0.16.9 for Revisions) now applies to TVW too.

### Fixed

- **TVW empty Through layer** (Landrex variant on Gigabyte boards) no longer fails to load.
- **TVW pin-extension block** now fires on `partType=0x11` too — fixes broken pin geometry on the Gigabyte/Landrex variant.
- **Net search** can now expand a selected net into its component spoiler.

## v0.16.9 — 2026-05-01

### New

- **OBD structured DIAGNOSIS.** OpenBoardData diagnosis text is now parsed into collapsible sections with clickable refs (component refdes, net names) that select on the canvas. Multi-variant tables with comments displayed inline.

## v0.16.8 — 2026-05-01

### Fixed

- **PDF↔board lookup** — net-line drawing across the schematic, board-search mirror behaviour. Focus-zoom capped at 600% so opening a tiny test pad doesn't fly the viewport into pixel territory.

## v0.16.7 — 2026-05-01

### New: OpenBoardData (OBD) integration

BoardRipper now reads the public [OpenBoardData](https://openboarddata.org) corpus — community-maintained per-board diagnostics, pin readings, schematics, and notes — and surfaces it inline.

- **Backend:** `OBDATA_V002` parser, filesystem cache with atomic writes + `bpath` sandboxing, scraper with drop-guard, four HTTP handlers under `/api/obd/*` with single-flight, integration tests.
- **Frontend:** `obdStore`, `useObdForBoard` hook, Settings ▸ Library tab with disclaimer + "Sync OBD" button, `ObdSection` in LibraryPanel detail with a multi-variant table and visible comments. Canvas tooltip + Info pane surface readings on hover.
- **Disclosure:** OBD content is third-party; the disclaimer in the sync UI sets expectations clearly. Cache is bounded; sync is opt-in.

The aligned-with-real-format scraper fix in this release brought OBD live.

## v0.16.6 — 2026-04-30

### New

- **Local-LLM NAS classifier.** A second-pass classifier runs against the maintainer's NAS dump using a local LLM, filling Brand/Family/Board placeholders for the boards the heuristic + Tavily passes left in `Unsorted`. Round 1 imported **1024** new boards.
- **Family-hierarchy normalization** across all brands (so Apple `MacBook Pro` is one family, not three near-duplicates separated by capitalization).

## v0.16.5 — 2026-04-29

### New / Cleanup

- Tightened the file-extension whitelist used by the librarian's filename scanner — drops dead `.cae` and `.xzz` (the parser handles `.xzz`; the scanner doesn't).
- **Tavily classifier residue cleared.** From 1091 Unsorted → **170** Unsorted left.

## v0.16.4 — 2026-04-29

### New

- **Tavily search backend** wired into the offline classifier (`--search-backend tavily`). LLM classifier is now searchable in three modes: offline (heuristic only), DuckDuckGo, Tavily.
- boards.db curated from the v0.16.3 raw import down to **1091 Unsorted** (was ~2,800 after the filename-scan import).

## v0.16.3 — 2026-04-29

### New

- **`apple-boards.ts` retired** — the hardcoded Apple-board lookup is gone; `boards.db` is now the single source of truth.
- **Rescan re-resolves metadata.** Renaming a board in the DB no longer requires re-importing files.

## v0.16.2 — 2026-04-29

### Fixed

- **Auto-bind log spam** on `FOREIGN KEY constraint failed` (787) now bounded — previously one full line per failed pair hammered stdout and the writer mutex on a busy rescan after Reset All.

### Internal

- Release pipeline trimmed to Docker-only (legacy CI tarball path removed).

## v0.16.1 — 2026-04-29

### New

- **`boards.db` is now bundled inside the Docker image** at `/build/boards.db`. Fresh installs no longer need a side-channel DB download.
- Desktop builds (Electron Mac/Windows) paused for this release window.

## v0.16.0 — 2026-04-29

### New: boards.db 20× expansion (145 → 2,914 boards)

The board reference database expanded from 145 hand-curated entries to **2,914** via three import slices, all converging on the v2 schema:

1. **Wikidata Macs import (Slice 1).** SPARQL fetch of all Apple Mac models → staging file → apply with INSERT OR IGNORE under v2 placeholders. Family resolver auto-assigns `MacBook` / `iMac` / `Mac mini` / `Mac Pro` / `Mac Studio`.
2. **XZZ Apple-laptop skeleton import.** Replaces the Wikidata path with a filesystem walk of the maintainer's XZZ corpus — recovers boards Wikidata doesn't carry (Quanta / Compal / Foxconn ODM codes).
3. **Filename-scan importer (Slice 1).** A pattern battery walks `/library/`, cross-references existing boards, tokenizes unmatched substrings, and emits a Markdown observation report + JSON sidecar. The JSON sidecar feeds an importer that creates placeholder Brand/Family/Board entries with `INSERT OR IGNORE`. **2.8K new boards** added in one pass.

A snapshot of the 2026-04-29 observation report is archived under `docs/scan/archive/`.

### Internal

- All three importers landed via per-slice spec → plan → implementation, merged into main as separate feature branches (`feat/wikidata-macs-import`, `feat/filename-scan-observation`).

## v0.15.0 — 2026-04-28

### New: boards.db v2 schema redesign + Database Editor

The flat `boards` table is replaced by an **entity hierarchy**: Brand → Family → Board, with a color cascade and an explicit `family` field on each Board. The v2 resolver walks the hierarchy and returns the most specific colour/identity available; UUIDs are always freshly generated in the migration so old `BoardColorHex` values don't pin to retired entries.

- v2 migration script with full test coverage; step tracking + orphan-row defense; case-insensitive brand match; `FAMILY_PATTERNS` extended.
- `boards.db` rewritten on the v2 schema; `create_mockup_db.sql` rewritten; `build_full_db.sql` archived.
- **Database Editor panel** (Library tab) — read-only first slice. Lists Brands, Families, Boards in a tree view; clicking a Board surfaces its full row.

### Fixed

- **HomeBackdrop hides** when any Dockview panel is opened — previously it leaked through float-window seams.

---

## v0.14.0 and earlier

For releases prior to v0.15.0, see the git tags directly:
[`git log --oneline --tags`](https://github.com/AlexeyInwerp/BoardRipper/releases)
(maintainer-only access until the repo is open-sourced).
