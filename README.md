# BoardRipper

Web-based PCB boardview file viewer. Renders `.bvr` files with GPU-accelerated WebGL, hosted via Docker on a NAS.

## Features

- **GPU-accelerated rendering** — PixiJS v8 (WebGL), handles 10,000+ components at 60fps
- **Pan & zoom** — pixi-viewport with mouse wheel, drag, pinch-zoom, deceleration
- **BVR1 & BVR3 support** — both OpenBoardView formats parsed client-side
- **Multi-board tabs** — open multiple boards simultaneously, switch between them
- **Layer toggle** — show/hide top and bottom layers independently
- **Butterfly mode** — side-by-side mirrored view of both board sides
- **Selection & highlight** — click component or pin to highlight entire net across the board
- **Net lines** — show connection lines between components sharing a net
- **Search** — find components and nets by name
- **Context menu** — right-click to copy name, highlight net, open info panel
- **Panel system** — Dockview: dockable, floating, and popout-to-new-window panels
  - Component Info (pins list, metadata)
  - Net List (searchable, click to highlight)
  - Search Results
  - PDF Viewer (pan/zoom, text search, bookmarks)
  - Settings (live preview mockup, per-net color rules, label/pin/outline tuning)
- **IndexedDB cache** — instant re-open without re-parsing
- **Docker deploy** — ~15MB scratch-based image for NAS

## Stack

| Layer | Technology |
|---|---|
| Rendering | PixiJS v8 + pixi-viewport v6 |
| Frontend | React 19 + TypeScript + Vite 7 |
| Panels | Dockview v5 |
| Backend | Go (net/http stdlib) |
| Container | Docker multi-stage, scratch-based |
| Tests | Playwright (Chromium headless) |

## Quick Start

### Docker (production)

```bash
docker compose up --build
# → http://localhost:8080
```

### Development

```bash
# Frontend
cd src/frontend
npm install
npm run dev       # http://localhost:5173

# Backend (separate terminal)
cd src/backend
go run .          # http://localhost:8080
```

## Deployment (NAS / Docker)

```yaml
# docker-compose.yml
services:
  boardripper:
    build: .
    ports:
      - "8080:8080"
    volumes:
      - ./data:/data
    restart: unless-stopped
```

## Supported File Formats

- **BVR1** (`BVRAW_FORMAT_1`) — tab-delimited, absolute coordinates ×1000
- **BVR3** (`BVRAW_FORMAT_3`) — keyword-value, relative pin coordinates

See [`docs/formats/BVR_FORMAT.md`](docs/formats/BVR_FORMAT.md) for the full format specification.

## Project Status

| Phase | Status |
|---|---|
| Phase 1: Core Foundation (parsers, backend, Docker) | Done |
| Phase 2: Board Rendering (PixiJS, viewport, layers) | Done |
| Phase 3: Interaction & Selection (hover, click, search) | Done |
| Phase 4: Panel System (Dockview, PDF viewer, cache) | Done |
| Phase 4+: Multi-board tabs, butterfly mode, net lines, render settings | Done |
| Phase 5: Polish (drag-drop, themes, recent files) | In Progress |

See [`docs/PLANNING.md`](docs/PLANNING.md) for the full architecture and implementation plan.
