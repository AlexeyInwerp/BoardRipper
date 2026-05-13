# BoardRipper

Web-based PCB boardview viewer for board-level repair. Eleven boardview formats and the matching PDF schematic, side by side, in a browser. GPU-accelerated rendering, dockable panels, self-hosted via Docker. Free, AGPL-3.0.

![Boardview and PDF schematic side by side — instant cross-reference](docs/screenshots/01-board-pdf-lookup.png)

A polished overview with screenshots lives at <https://www.ripperdoc.de/boardripper/>. This README is the developer- and operator-facing companion: stack details, Docker setup, build instructions, license notes.

> **Bring your own files.** BoardRipper is the viewer only — it does not ship with any boardview files, schematics, or PDFs. The bundled board database is reference metadata (board numbers and device models), no copyrighted content.

## Features

- **GPU-accelerated rendering** — PixiJS v8 / WebGL, 10,000+ components at 60 fps on a modern GPU. Bench-tested down to Intel HD 4000-era integrated graphics (10–30 fps).
- **Eleven board formats** — see table below. Both `.cad` and `.brd` are shared extensions; BoardRipper sniffs file content to pick the right parser.
- **PDF schematic, in sync** — pan, zoom, text search, bookmarks, night mode. Right-click a net on the board to search it in the schematic.
- **Multi-board tabs** — open several boards at once, switch between them.
- **Multi-layer support** — show/hide top, bottom, and inner layers independently. Butterfly mode shows top and bottom side by side.
- **Net highlight** — click a pin and the whole net lights up across the board. Chain-adjacent mode walks through neighbouring nets too.
- **Touch input** — pinch-zoom, drag-pan, tap to select. Usable on a tablet at the bench.
- **Customizable colors** — per-net rules by name pattern (e.g. `GND`, `VCC`, `PP*`), per-component-type fills (R / C / L / U / Q / D / J), per-layer colors, label / pin / outline tuning. Live preview before applying.
- **Multi-line search** — each line is an extra AND-filter, useful when a component carries value and voltage on separate label lines (`20uF` ⨯ `10V` ⨯ `C12*`).
- **Drag-and-drop import** — drop a board file or a folder onto the window and it loads. To persist drops across container restarts, mount a writable folder at `/library/incoming` (see Docker setup).
- **Board library** — scan folders, browse by board number or model. Filenames are auto-sorted; board numbers, manufacturers, and revisions are parsed automatically.
- **Board database with heuristics** — a bundled reference DB maps board numbers to manufacturer / ODM / laptop or phone model and groups boards by device.
- **PDF auto-link** — boards and their schematics get matched up automatically when both are present in the same library.
- **IndexedDB cache** — re-open without re-parsing.
- **Self-update** — one-click signed update from the toolbar. No GitHub token required; updates are signed with an offline Ed25519 key and verified by the running container before install.

![Multi-layer Allegro BRD with layer sidebar — toggle signal, power, and ground planes independently](docs/screenshots/03-multi-layer.png)

- **Panel system** — Dockview: dockable, floating, and popout-to-new-window panels.
  - Component Info (pins list, metadata)
  - Net List (searchable, click to highlight)
  - Search Results
  - PDF Viewer
  - Settings (live preview mockup, per-net color rules, label/pin/outline tuning)
  - Debug Panel (scoped log viewer, frame-time)
- **Electron desktop wrapper** — standalone macOS (universal + legacy) and Windows builds.

![Multiple boards of different formats open simultaneously in tabs — BVR, BRD, FZ, TVW, XZZ](docs/screenshots/02-format-support.png)

## Supported file formats

| Format | Extension(s) | Description | Spec |
|---|---|---|---|
| **BVR1** | `.bvr` / `.bv` | Tab-delimited boardview, coordinates ×1000 → mils | [BVR_FORMAT.md](docs/formats/BVR_FORMAT.md) |
| **BVR3** | `.bvr` / `.bv` | Keyword-value boardview, relative pin coordinates | [BVR_FORMAT.md](docs/formats/BVR_FORMAT.md) |
| **BRD** | `.brd` | Apple / Mac repair, bit-rotation obfuscated binary | [BRD_FORMAT.md](docs/formats/BRD_FORMAT.md) |
| **BDV** | `.brd` / `.bdv` | Plain-text boardview (BRDOUT / NETS / PARTS / PINS / NAILS) | [BDV_FORMAT.md](docs/formats/BDV_FORMAT.md) |
| **BDV ASC** | `.bdv` | Honhan / Tebo-ICT obfuscated multi-section ASC (line-key cipher) | [BDV_ASC_FORMAT.md](docs/formats/BDV_ASC_FORMAT.md) |
| **FZ** | `.fz` | ASUS, RC6-encrypted, zlib-compressed | [FZ_FORMAT.md](docs/formats/FZ_FORMAT.md) |
| **GenCAD** | `.cad` | GenCAD 1.4 PCB interchange (text) | [CAD_FORMAT.md](docs/formats/CAD_FORMAT.md) |
| **Mentor Neutral** | `.cad` | Mentor Boardstation neutral file (Samsung / Quanta / Compal exports) | [MENTOR_NEUTRAL_FORMAT.md](docs/formats/MENTOR_NEUTRAL_FORMAT.md) |
| **XZZ** | `.pcb` | XZZ PCB, DES-encrypted boardview | [XZZ_FORMAT.md](docs/formats/XZZ_FORMAT.md) |
| **TVW** | `.tvw` | Teboview binary, multi-layer + traces + drill data | [TVW_FORMAT.md](docs/formats/TVW_FORMAT.md) |
| **Cadence Allegro BRD** | `.brd` | Cadence Allegro PCB binary, v16.x / v17.x / v18.x | [ALLEGRO_BRD_FORMAT.md](docs/formats/ALLEGRO_BRD_FORMAT.md) |
| ↳ Allegro v15.x | `.brd` | Same parser family, partial coverage, still in beta | [ALLEGRO_V15_FORMAT.md](docs/formats/ALLEGRO_V15_FORMAT.md) |

![Obscure CAD file with multiple boards stacked into one document — all outlines and components rendered correctly alongside the matching PDF](docs/screenshots/04-stacked-boards.png)

## Keyboard shortcuts

The full, always-current list lives in **Settings ▸ Shortcuts** (and on the home-screen Getting Started card). The headline shortcuts:

| | |
|---|---|
| **Open board / PDF** | `⌘O` / `⌘P` (Mac) · `Ctrl+O` / `Ctrl+P` (Win/Linux) |
| **Find** (selection-aware) | `⌘F` / `Ctrl+F` — prefills PDF search with the selected component or net |
| **Pan board / PDF** | `W A S D` or `Alt+arrows` |
| **Rotate board** | `Q` / `E` (CCW / CW) or `⌘←` / `⌘→` |
| **Mirror board** | `⌘↑` / `Ctrl+↑` |
| **Flip layer** (top ↔ bottom) | `Space` |
| **Zoom in / out** | `Shift+W` / `Shift+S` (centred on canvas) |
| **Toggle Library sidebar** | `~` — the physical key left of `1` (`Backquote` / `IntlBackslash`); works on US, German, and most other layouts |
| **Jump board ↔ PDF** | `Tab` |
| **PDF page nav** | `PgUp` / `PgDn` (or `⌘↑` / `⌘↓` on Mac) |

The keyboard pan and zoom step sizes are configurable in **Settings ▸ Navigation ▸ Keyboard pan / zoom**. The right-click context menu adds a top-row icon strip with **Copy net / Copy part / Search net / Search part** (board) and **Copy / Search Web** (PDF text) — search opens Google in a new tab.

> **Layout note.** WSAD/QE/Shift+WS bind to the printed letter on your keyboard, so on AZERTY layouts the keys are physically Z/Q/S/D rather than the W/A/S/D positions — a layout-aware remapping is on the roadmap. The `~` library toggle is layout-independent.

## Stack

| Layer | Technology |
|---|---|
| Rendering | PixiJS v8 + pixi-viewport v6 (WebGL) |
| Frontend | React 19 + TypeScript + Vite 7 |
| Panels | Dockview v5 |
| Backend | Go (`net/http` stdlib) |
| Container | Docker multi-stage, scratch-based, ~25 MB image / ~13 MB compressed |
| Desktop | Electron (macOS universal + Windows) |
| Tests | Playwright (Chromium headless) |

## Quick start

BoardRipper is primarily a **server** you run on a NAS or host machine and access from any browser on your network. Standalone binaries and desktop Electron wrappers are available as alternatives.

### Docker (typical deployment)

```bash
docker compose up -d
# → http://localhost:8081
```

Or pull directly:

```bash
docker pull ghcr.io/alexeyinwerp/boardripper:latest
```

Mount your board-file folders under `/library` to expose them in the Library panel — see Docker Setup below.

### Build from source

```bash
git clone https://github.com/AlexeyInwerp/BoardRipper.git
cd BoardRipper

# Build the frontend bundle:
cd src/frontend && npm install && npm run build && cd ../..

# Run the Go server pointing at the built bundle:
STATIC_DIR=./src/frontend/dist DATA_DIR=./data go run ./src/backend
# → http://localhost:8080
```

The released artifact is the Docker image (above) — no per-platform standalone binaries are published. If you need a portable binary, build the Go server with `CGO_ENABLED=0 go build -o boardripper ./src/backend` and ship it next to the `dist/` directory and a `STATIC_DIR=` env var. Self-update only works in Docker (it needs the host's Docker socket).

### Development

```bash
# Frontend (hot reload)
cd src/frontend && npm install && npm run dev    # http://localhost:5173

# Backend (separate terminal)
cd src/backend && go run .                       # http://localhost:8080
```

## Docker setup

### docker-compose.yml

```yaml
services:
  boardripper:
    image: ghcr.io/alexeyinwerp/boardripper:latest    # or build: .
    # The image ships USER 65532:65532 (distroless `nonroot`) so a hypothetical
    # RCE doesn't own your bind-mounted /data. The default `docker compose up`
    # flow creates ./data as root on Linux hosts (Docker daemon runs as root),
    # which UID 65532 can't then write — the container exits at databank.Open
    # with "unable to open database file". Override to root for the compose
    # path, matching what NASdeploy.sh already does. Alternatively, remove this
    # line and either (a) `chown -R 65532:65532 ./data` before `up -d`, or
    # (b) switch ./data to a named volume — Docker initializes named volumes
    # from /data inside the image (pre-chowned to 65532 in the Dockerfile).
    user: "0:0"
    ports:
      - "8081:8080"              # access at http://your-host:8081
    volumes:
      - ./data:/data             # uploaded board files + cache persist here
      # Your library: mount EVERYTHING read-only (:ro) by default.
      - /path/to/MacBooks:/library/MacBooks:ro
      - /path/to/iPhones:/library/iPhones:ro
      - /path/to/Schematics:/library/Schematics:ro
      # The ONLY writable mount the container should ever see:
      - /path/to/incoming:/library/incoming:rw
      # Docker socket (required for self-update — see Self-Update below):
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      - PORT=8080
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 512M
```

### Volume mounting

The Library panel browses the `/library` directory inside the container. Mount your board-file folders as **subdirectories** of `/library`:

```
-v /nas/boards/MacBooks:/library/MacBooks:ro
-v /nas/boards/iPhones:/library/iPhones:ro
-v /nas/schematics:/library/Schematics:ro
-v /nas/incoming:/library/incoming:rw
```

These appear as top-level folders in the Library panel. Use `:ro` for read-only by default. `/library/incoming` is the only path BoardRipper needs to be able to write to — that's where drag-dropped files land. The container does not need write access to your existing board folders, your schematics, or anything else.

### Synology NAS (DSM 7.2+)

1. Download `boardripper-<version>.tar.gz` (or `latest.tar.gz`) from <https://www.ripperdoc.de/boardripper/releases/>
2. SSH into your NAS and load the image:
   ```bash
   docker load < boardripper-docker-<version>.tar.gz
   ```
3. Create the container:
   ```bash
   docker run -d \
     --name boardripper \
     -p 8090:8080 \
     -v /volume1/docker/boardripper/data:/data \
     -v /volume1/your-boards/MacBooks:/library/MacBooks:ro \
     -v /volume1/your-boards/iPhones:/library/iPhones:ro \
     -v /var/run/docker.sock:/var/run/docker.sock \
     -e PORT=8080 \
     --restart unless-stopped \
     ghcr.io/alexeyinwerp/boardripper:latest
   ```
4. Open `http://your-nas-ip:8090`

## Self-update

BoardRipper can update itself when running in Docker:

1. Click the **version badge** in the toolbar to check for updates.
2. If an update is available, click **Update & Restart**.
3. The container pulls the new image and restarts automatically.

Requires:
- Docker socket mounted (`-v /var/run/docker.sock:/var/run/docker.sock`).

The signed release manifest is fetched from <https://www.ripperdoc.de/boardripper/manifest.json> and verified against an Ed25519 public key **compiled into the running binary** before any I/O on the body — a hijacked mirror cannot deliver a forged update. Once the manifest verifies, the image itself is pulled by content-addressed digest from `ghcr.io/alexeyinwerp/boardripper@sha256:…`; the [signed tarball mirror](https://www.ripperdoc.de/boardripper/releases/) is the fallback if GHCR is unreachable. The pipeline also enforces a monotonic counter (replay defence), a 30-day freshness window, a 90-day expiry, and a `min_supported_version` downgrade defence. See [docs/RELEASE_RUNBOOK.md](docs/RELEASE_RUNBOOK.md) for the maintainer-side release procedure.

### Drop-to-update fallback

For installs that can't reach the registry or the mirror (firewalled networks, air-gapped shops, recovery from a broken self-update):

1. Download `latest-update.tar` from <https://www.ripperdoc.de/boardripper/releases/latest-update.tar> (signed bundle: manifest + signature + image, ~13 MB).
2. Drag the file anywhere on the BoardRipper UI.
3. Confirm the prompt; the running container verifies the signature, applies the update, and restarts.
4. The browser reloads after ~30 s.

Same trust envelope as the in-app updater — the manifest signature is what grants trust, the file itself is treated as untrusted bytes until verification passes.

### Manual update

```bash
docker pull ghcr.io/alexeyinwerp/boardripper:latest
docker compose down && docker compose up -d
```

Or with a downloaded tarball:

```bash
docker load < boardripper-docker-<new-version>.tar.gz
docker compose down && docker compose up -d
```

### Older versions

Historical releases live at **<https://www.ripperdoc.de/boardripper/archive.html>** — Docker tarballs and signed drop-bundles for v0.19.0 onward, with per-version source links for everything older. The GitHub Releases page intentionally lists only the current release; the archive is the canonical "give me an older version" landing page.

A handful of versions are also kept on GHCR (`v0.19.0`, `v0.19.5`, `v0.20.5`, `v0.20.8`) for direct `docker pull` — see the archive table for which ones are still pull-able vs. tarball/source-only.

## Electron desktop wrapper (optional)

Prebuilt Electron wrappers are published with every release (`BoardRipper-macOS-universal-<version>.zip`, `BoardRipper-Windows-x64-<version>.zip`). They run the same Go backend + React frontend inside an Electron shell. The Docker / server path is the primary way to deploy BoardRipper; the desktop wrapper is here for single-machine use.

The wrappers are **unsigned**, so macOS Gatekeeper and Windows SmartScreen will warn on first launch:

- **macOS** — after unzipping, run `xattr -cr /Applications/BoardRipper.app` (or wherever you extracted it), then double-click. On macOS < 15 you can also right-click → Open → Open once, or use System Settings → Privacy & Security → Open Anyway after the first failed launch.
- **Windows** — SmartScreen shows "Windows protected your PC". Click **More info → Run anyway**.

### Building the wrappers locally

```bash
cd desktop
npm install
node build-all.mjs           # builds macOS universal + legacy + Windows
node build-all.mjs --mac     # macOS only
node build-all.mjs --win     # Windows only
```

Output in `desktop/out/` (macOS), `desktop/out-legacy/` (macOS legacy), `desktop/out-win/` (Windows).

## License

BoardRipper is released under the **GNU Affero General Public License v3.0** (AGPL-3.0). See [LICENSE](LICENSE) for the full text.

This project incorporates code derived from KiCad (GPL-3.0) — specifically the Cadence Allegro BRD reader in [`src/frontend/src/parsers/allegro/`](src/frontend/src/parsers/allegro/), transliterated from KiCad's `pcbnew/pcb_io/allegro/` C++ source — which is why AGPL-3.0 was chosen: it is compatible with GPL-3.0 and additionally closes the "SaaS loophole" by requiring source availability to users who interact with a hosted instance over a network.

For a complete list of third-party sources, libraries, and attributions, see [THIRD_PARTY.md](THIRD_PARTY.md).

## Credits & references

BoardRipper exists because of the reverse-engineering work already done by the boardview community. Each entry below was consulted during development; full attribution and license details are in [THIRD_PARTY.md](THIRD_PARTY.md).

**Parser references**

- [KiCad](https://gitlab.com/kicad/code/kicad) *(GPL-3.0)* — Cadence Allegro BRD reader, transliterated to TypeScript. The reason BoardRipper as a whole is AGPL-3.0.
- [OpenBoardView](https://github.com/OpenBoardView/OpenBoardView) *(MIT)* — reference implementations for BVR1/BVR3, BRD (Apple), BDV (plain-text), BDV ASC (Honhan / Tebo-ICT), FZ (ASUS), GenCAD, XZZ.
- [eagleview](https://github.com/nitrocaster/eagleview) by Pavel Kovalenko *(MIT)* — TVW / Teboview parser source.
- [brd_parser](https://github.com/bernayigit/brd_parser) by Jeff Wheeler *(MIT)* — cross-validation reference for Allegro block layout.
- [piernov's Honhan BDV gist](https://gist.github.com/piernov/37849a3b92375e18515160b8a1efde18) & [OpenBoardView issue #2](https://github.com/OpenBoardView/OpenBoardView/issues/2) — identified the BDV ASC signature and line-key cipher.
- Mentor Boardstation Neutral — original reverse engineering, no third-party code or text incorporated.
- **Cryptographic standards** — [RC6](https://people.csail.mit.edu/rivest/pubs/RRSY98.pdf) by Rivest/Robshaw/Sidney/Yin (FZ), [DES / FIPS PUB 46-3](https://csrc.nist.gov/pubs/fips/46-3/final) (XZZ). GenCAD 1.4 has no canonical online specification — see [docs/formats/CAD_FORMAT.md](docs/formats/CAD_FORMAT.md) for the BoardRipper interpretation.

**Rendering & runtime**

- [PixiJS](https://pixijs.com/) *(MIT)* — WebGL renderer
- [pixi-viewport](https://github.com/davidfig/pixi-viewport) *(MIT)* — pan/zoom/culling
- [React](https://react.dev/) *(MIT)* — UI framework
- [Vite](https://vitejs.dev/) *(MIT)* — build pipeline
- [Dockview](https://dockview.dev/) *(MIT)* — dockable / floating / popout panel system
- [pdf.js](https://mozilla.github.io/pdf.js/) *(Apache-2.0)* — PDF rendering and text extraction
- [pdf-lib](https://pdf-lib.js.org/) *(MIT)* — PDF manipulation
- [opentype.js](https://opentype.js.org/) *(MIT)* — font glyph extraction
- [Tabler Icons](https://tabler.io/icons) *(MIT)* — icon set

**Backend**

- [Go standard library](https://pkg.go.dev/std) *(BSD-3-Clause)*
- [modernc.org/sqlite](https://gitlab.com/cznic/sqlite) *(BSD-3-Clause)* — pure-Go SQLite driver
- [rsc.io/pdf](https://pkg.go.dev/rsc.io/pdf) *(BSD-3-Clause)* — PDF text extraction

**Desktop**

- [Electron](https://www.electronjs.org/) *(MIT)*, [@electron/packager](https://github.com/electron/packager) *(MIT)*, [@electron/universal](https://github.com/electron/universal) *(MIT)*

Corrections and missing attributions are welcome — open an issue, or email <mail@ripperdoc.de>.

## About this software

BoardRipper is not hand-written. The codebase — parsers, renderer, panels, backend — was generated with [Claude Code](https://www.anthropic.com/claude-code), working from format specs and reference implementations from the boardview community. I review, test, and direct it; the lines of code came out of an LLM.

Treat that as you would any AI-assisted software: it works on the boards I've tested, it has bugs I haven't found yet, and the right level of trust is "a useful viewer, not a forensic tool." Bug reports welcome.

## Feedback

- Discord: **@inwerp** on the [All Things Repair](https://discord.gg/BYEkKTMNNY) server.
- Email: <mail@ripperdoc.de>.
- Bugs and feature requests: file an issue on GitHub, or reach out via Discord / email.

If BoardRipper saves you time, [buy me a coffee](https://buymeacoffee.com/inwerp).
