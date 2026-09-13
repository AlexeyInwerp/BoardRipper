# Fresh install & first index — review

**Date:** 2026-09-12 · **Version reviewed:** v0.40.0 (`ghcr.io/alexeyinwerp/boardripper:latest`)

Everything below was measured on this machine against a real container, not read
off the source. Test rig: a throwaway `docker compose` stack built from the
README's own compose block, a fresh `/data`, and a synthetic library of **60,379
files** (52,803 boards + 7,576 PDFs, seven brand folders, Apple-style
`820-NNNNN` filenames) plus the repo's `samples/`.

Reference numbers from that rig:

| | |
|---|---|
| Cold boot to first `200` on `/api/health` | **9–10 s** |
| Full first scan, 60,379 files | **293 s** (~207 files/s) |
| No-op rescan | 8 s |
| Write latency (`POST /api/databank/bindings`) *during* the scan | **3–33 ms** (one 103 ms outlier) |
| Read latency during the scan (`/stats`, `/tree`, `/files/stream` 10 MB) | 10–60 ms / 0.15 s / 0.58 s |
| OBD index size | **109 boards** |
| OBD single-board fetch | 0.4–1.2 s |

---

## 1. Folder data should appear as soon as possible

### What happens today

Three separate things make a fresh install look empty for a long time.

**(a) Nothing is scanned at all until the user asks.** `auto_scan` has no
default (`main.go:179`), so a first boot logs *"Auto-scan disabled"* and the
Library shows `Library is empty — no files indexed yet`. The CTA
(`LibraryPanel.tsx:1301`) lands correctly on Settings ▸ Library ▸ **Scan now**,
but nothing on the start page or in `instructions.md` tells a new user that
step exists.

**(b) The rows are in the DB long before the UI shows them.** Measured: 60 s
into the scan the database already held ~25,000 rows and `/api/databank/files`
served them in 15 ms. The frontend does not ask. `_startScanPolling`
(`databank-store.ts:1551`) fetches `/scan/status` every 500 ms and only calls
`fetchFiles()` **after** `running` flips to false:

```ts
if (!status.running && !this._filesFetchedAfterScan) { … await this.fetchFiles(); }
```

So a page that was open before the scan started shows **0 files for the whole
293 s**; a page loaded mid-scan shows whatever existed at load time and freezes
there. Confirmed in the browser: the panel read `Apple 414` while the status
line read `Indexing 46378/60379`.

**(c) 10 s of the boot is `pdfium`.** `pdfindex.NewEngine(poolMax)`
(`main.go:337`) compiles the pdfium wasm module with `MinIdle: 1` *before*
`ListenAndServe`. Logs show a 10 s gap between "update auth: per-install secret
loaded" and "BoardRipper server starting"; during it the browser gets connection
refused. The self-update healthcheck has a 60 s budget so this never bit a
release, but it is 10 s of dead first impression on every restart.

### Fix

1. **Refresh the list during the scan.** In the poll tick, when `status.added`
   has grown by more than N since the last refresh (or every ~5 s), re-run
   `fetchFiles()` / `fetchTree()`. The transport is already progressive and
   cheap — a 60 k-row stream is 0.58 s and the store appends in place.
   Alternatively add `?since=<id>` to `/api/databank/files` and append only new
   rows.
2. **Make the empty state do the work.** Put a **Scan now** button *in* the
   empty state instead of a link to Settings, and next to it "Browse folders
   live" — `/api/databank/browse` already works with zero indexing and returned
   the whole mount tree instantly on a fresh container.
3. **Move `NewEngine` off the boot path** into the same background goroutine
   that already runs the migrations, and register the PDF-index routes behind a
   readiness flag. Saves 10 s on every start.
4. Consider defaulting `auto_scan` to true on a **first** boot only (no
   `last_file_scan_at` and an empty `files` table) — the case where it cannot
   cost anyone anything.

Minor, same area: the scan logs one line per added file
(`scanner.go:525`) — 60,000 `Scanner: + …` lines on a first index. Log the
batch, not the file.

---

## 2. UI hangs while indexing when you try to bind

### It is not the database

This was the hypothesis and it is wrong, measured end to end. Throughout the
293 s scan — including the dedup phase, which is the worst case (4 workers, one
autocommit `UPDATE` per file through `db.mu`) — a `POST /api/databank/bindings`
completed in **3–33 ms**, worst single sample 103 ms. Reads stayed in the tens
of milliseconds. WAL, the split reader/writer pools and the 1000-row batched
`WriteTx` are doing their job.

### It is `BindPicker`

`LibraryPanel.tsx:2055`. Clicking **+** on a board's detail pane:

1. `bindCandidates` (`:1748`) = **every** PDF in the library that isn't already
   bound. No cap.
2. `scored` (`:2072`) runs `nameMatchScore` + `metadataMatchScore` against each
   one and sorts. Both allocate (tokenise → `Set` → loop).
3. `filtered.map(...)` (`:2116`) renders **every** candidate as a DOM row.
   No virtualisation, no cap.

Measured on the rig, with **7,576** PDFs:

```
BIND PICKER OPEN  => longest blocked frame 251 ms, 7576 rows rendered
FILTER TYPING     => "8" 98 ms · "82" 86 ms · "820" 66 ms   (all 7576 rows)
                     "820-4" 66 ms (835 rows) · "820-45" 33 ms (72 rows)
```

~13 µs per row, linear. A real schematic library with 30–50 k PDFs therefore
pays **0.4–0.65 s of blocked main thread per keystroke** and over a second to
open the picker. That is the hang.

The scan makes it worse rather than causing it. Two mechanisms, both measured:

- While a scan runs the store calls `notify()` **unconditionally every 500 ms**
  (`databank-store.ts:1560`, deliberate — the comment explains why), and
  `createStoreHook` rebuilds a fresh snapshot object on every notify, so every
  `useDatabank()` consumer re-renders. With the picker open that reconciles
  7,576 rows twice a second. At this size it still fits in a frame (p95 stayed
  18 ms); at 5× it will not.
- Scan completion re-streams the whole list and recomputes `bindCandidates` +
  `scored`: one **94 ms** hitch at 7.5 k candidates / 60 k files, again linear.

### Fix

- **Cap and virtualise.** Render the top ~200 scored candidates and let the
  filter box reach the rest; or drop in a windowed list. This alone removes the
  freeze.
- **Debounce the filter** (~150 ms) so a keystroke doesn't re-render the list
  synchronously.
- **Score lazily** — only the visible window needs a score; the sort can run on
  a cheap key first.
- Optional: gate the 500 ms `notify()` during a scan to a coarser interval, or
  split the scan-status subscription out of `useDatabank` so a progress tick
  doesn't re-render list panels.

---

## 3. Onboarding should explain the library and the index order

### What exists

- `WelcomeSetup.tsx` — the first-run modal. It is **only** a pan/zoom gesture
  wizard. It says nothing about the library.
- `components/home/instructions.md` — a genuinely good "Getting started" card
  on the start page, with a Docker section and a Library section.
- `HomeBackdrop.tsx` ▸ Quick settings ▸ Library — a stats line.

### What is wrong or missing

1. **`instructions.md` states something that is false by default:**
   *"New files in the library are picked up automatically."* There is no
   periodic scan anywhere in the backend (the only ticker near this is
   `librarysync/scheduler.go`, which mirrors a WebDAV share and is off by
   default). `auto_scan` only runs at **boot**, and it is off. A user who mounts
   a folder and waits will wait forever.
2. **Nothing explains the two indexes.** They are different things with
   different costs and a required order — the file index is fast and is the
   prerequisite for everything; the PDF text index is slow, optional, and runs
   in the background. The code already sequences this correctly
   (`SetScanCompleteHook` kicks the indexer once the scan adds rows, and
   auto-resume continues it across restarts) — it just is never said.
3. **The fresh-install stats read `0 boards · 0 PDFs · 0 bindings · 0 PDF pages
   indexed` with no call to action.** `LibraryStats` (`HomeBackdrop.tsx:1083`)
   has a "Library not scanned yet" message, but it is behind `if (!stats)` and
   `stats` is non-null on a fresh install (the endpoint returns all zeros). So
   the only helpful copy in that card is unreachable in the exact case it was
   written for.
4. OpenBoardData is never introduced (see §4).

### Fix

Add a **Library** step to the first-run flow — either a second page of
`WelcomeSetup` or a dismissible band at the top of the start page while
`stats.boards === 0`:

> **Your library**
> BoardRipper reads the folders you mounted at `/library`. Nothing is imported
> or copied.
> 1. **Index files** — walks the folders and builds the board/PDF list. Fast
>    (≈200 files/s), required before anything shows up. **[Index now]**
> 2. **Index PDF text** — extracts the text of every schematic so full-text
>    search works. Slow, runs in the background, safe to leave. Starts by
>    itself when step 1 finishes.
> 3. *(optional)* **OpenBoardData** — community diode/voltage readings.
>    **[Download all (109 boards, ~1 min)]**
> ☐ Re-index on every start

Then fix `instructions.md`: replace "picked up automatically" with the truth
(re-index on start if you enable Auto-scan; otherwise the Scan button), and add
the two-index explanation to the Library section. Fix the `!stats` branch to
`!stats || stats.boards + stats.pdfs === 0`.

---

## 4. OpenBoardData: fetch everything up front

### It is far cheaper than it looks

The whole catalogue is **109 boards** and a single board fetches in 0.4–1.2 s.
A "download everything" pass is **~1–2 minutes** and a few MB on disk. This is
well worth doing once at setup.

### It already auto-binds — through the filename only

`obdStore.loadMatches()` auto-loads any already-cached payload
(`obd-store.ts:137`), so once the cache is warm every matching board lights up
with no user action. Verified by reading the path end to end; the match is
`strings.Contains(normalizeForMatch(leaf), boardNumber)` on the server.

The gap is **where `boardNumber` comes from**. Every consumer inside the viewer
— `BoardViewerPanel:145`, `BoardRenderer:6109`, `BoardSidebar:277,668`,
`DiodeValuesButton:16` — derives it with `extractBoardNumberFromFilename()`,
which is six regexes (`820-…`, `LA-…`, `DA0…`, `NM-…`, `60…`, `iP…`). Only the
Library detail pane's `ObdSection` uses the databank's **resolved**
`board_number`, which the scanner already computed against `boards.db`.

So a file named `MacBookPro14,1 logic board.brd` shows OBD data in the Library
detail pane and **nothing** in the board viewer, even though the backend knows
its board number. That is the "doesn't auto-bind on other boards" symptom.

### Fix

1. **Backend `POST /api/obd/fetch-all`** — iterate `index.json`, skip already
   cached (`IsFetched`), throttle to ~1 request/s, expose progress like the
   dedup runner (`{running,total,done,current}`) plus a stop. The single-flight
   map in `ObdHandler` is already per-bpath, so reuse `FetchBoard` + `WriteBoard`
   unchanged. `obd.Scraper` has no rate limit today — add one here, not in the
   per-board path.
2. **Settings ▸ Library ▸ OpenBoardData**: a `Download all boards` button next
   to `Sync OBD index`, with `n of 109 cached` and a progress bar.
3. **Onboarding**: the optional third step above, one click, runs the same
   endpoint in the background.
4. **Widen the board-number source.** Where the viewer has a databank file id
   (the normal Library-open path), prefer the resolved `board_number` and fall
   back to the filename regex. One helper used by all five call sites.
5. Re-run `loadMatches` after a fetch-all finishes so open tabs pick up the new
   cache without a reload.

---

## 5. Docker installation instructions — errors found

Checked against `docker-compose.yml`, `Dockerfile`, `scripts/release.sh` and a
real container run. Ordered by how badly they bite.

**a. `go run ./src/backend` cannot work.** README "Build from source":

```bash
STATIC_DIR=./src/frontend/dist DATA_DIR=./data go run ./src/backend
```

There is no `go.mod` at the repo root. Verified:

```
go: cannot find main module, but found .git/config in /Users/inwerp/Projects/BoardRipper
```

Same defect in the paragraph below it (`go build -o boardripper ./src/backend`).
Both must `cd src/backend` first. The stated port (8080) is right.

**b. The documented dev setup is cross-wired.** README "Development" says
`cd src/backend && go run .` → `http://localhost:8080`, but the Vite dev proxy
targets **1336** (`vite.config.ts:11`, and CLAUDE.md agrees). Following the
README, every `/api` call from `localhost:5173` hits a dead port. It should read
`PORT=1336 go run .`.

**c. Wrong tarball name.** README Synology step 2:
`docker load < boardripper-docker-<version>.tar.gz`. The release artifact is
`boardripper-$VERSION.tar.gz` (`release.sh:430`, `:538`), plus `latest.tar.gz`.
Step 1 of the same list already spells it correctly — the two lines contradict
each other.

**d. The Synology `docker run` will fail on a fresh Linux/DSM host.** It omits
the `--user 0:0` that both `docker-compose.yml` and the README's own compose
block explain is required, because `/volume1/docker/boardripper/data` is created
root-owned and the image runs as UID 65532 — `databank.Open` then `log.Fatal`s
with *"unable to open database file"*. It also omits `/library/incoming:rw`, so
drag-drop imports silently don't persist, which the Volume-mounting section
directly above says they need. (Not reproducible on this machine: Docker
Desktop's virtiofs flattens bind-mount ownership. The failure mode is documented
in the project's own compose comments.)

**e. README compose ≠ repo compose.** The README block uses
`deploy.resources.limits.memory: 1024M`; the checked-in `docker-compose.yml`
uses `mem_limit: 2g` with a comment asserting `deploy.resources` is *"SILENTLY
IGNORED by docker compose up"*. **Measured: it is not ignored** — with only the
README's key set, `docker inspect` reported `HostConfig.Memory = 1073741824`
under Compose 5.5.0. (It was true for older Compose v2.) So the README isn't
broken, but the compose comment is now wrong and the two files disagree on both
key and value. Pick one; if 2 GB is the real recommendation, the README's 1024 M
is the wrong advice.

**f. Quick start is inverted.** `docker compose up -d` in a clone uses the
checked-in file, which is `build: .` — so the "one command" quick start
**builds** the image (multi-stage, npm + Go) rather than pulling. The README's
sample block shows `image: ghcr.io/…  # or build: .`, the opposite of the file
it describes. Either ship the compose file with `image:` and `# build: .`
commented, or say so in the quick start.

**g. `./library` is created empty.** The repo compose mounts `./library:/library`,
so the documented quick start yields a working container with nothing in it.
Worth one line pointing at the per-folder `:ro` mounts.

Not errors, verified working: port mapping 8081→8080, `docker load` accepting
the gzipped `docker save` stream, the `user: "0:0"` note, `PDFINDEX_POOL_MAX`,
and the absence of a container healthcheck (the Dockerfile defines none, so the
README's omission of `test: ["NONE"]` is harmless).

---

## Suggested order of work

1. §2 cap/virtualise `BindPicker` — smallest change, removes a real freeze.
2. §5 a–d — four documentation lines, two of which make the documented commands
   fail outright.
3. §1 refresh the list during the scan + move `NewEngine` off the boot path.
4. §4 `fetch-all` endpoint + Settings button + the resolved-board-number helper.
5. §3 onboarding copy, once §1 and §4 give it something true to say.
