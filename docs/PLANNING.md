# BoardRipper — Architecture & Implementation Plan

## Stack Overview

```
┌──────────────────────────────────────────────────┐
│  Docker Container (~15MB)                        │
│  ┌────────────────────────────────────────────┐  │
│  │  Go binary (net/http)                      │  │
│  │  • Serves SPA static files                 │  │
│  │  • POST /api/upload — file upload          │  │
│  │  • GET /api/files — list saved boardviews  │  │
│  └────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────┐  │
│  │  Frontend (React + TypeScript + Vite)      │  │
│  │  • PixiJS v8 — WebGL PCB rendering         │  │
│  │  • pixi-viewport — pan/zoom/culling        │  │
│  │  • Dockview — panels/tabs/floating         │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

## Why These Choices

### PixiJS v8 (Rendering)
- GPU-accelerated WebGL — handles 10,000+ sprites at 60fps
- **Render Groups** — hardware-accelerated container transforms = smooth pan/zoom camera
- **Culling** — `cullable = true` skips off-screen components
- **pixi-viewport** — drag, pinch-zoom, wheel zoom, deceleration out of the box
- Sprite batching for repeated footprints (resistors, caps) = 3-4x perf boost

### Dockview (Panels)
- Floating panels with positioning API
- Popout to separate browser windows (multi-monitor)
- Zero dependencies
- Drag-and-drop tabs, groups, grids, splitviews

### Go (Backend)
- Single static binary → `FROM scratch` Docker image (~5-10MB)
- ~150K req/sec static file serving (vs Node.js ~25K)
- Perfect for NAS with limited resources

---

## Implementation Phases

### Phase 1: Core Foundation ✅ DONE
- [x] Initialize React + TypeScript + Vite project
- [x] Set up Go backend with file upload endpoint
- [x] Create Dockerfile (multi-stage build)
- [x] Implement BVR1 parser (TypeScript)
- [x] Implement BVR3 parser (TypeScript)
- [x] Playwright tests for parser/rendering smoke tests

### Phase 2: Board Rendering ✅ DONE
- [x] Set up PixiJS v8 canvas with pixi-viewport
- [x] Render board outline polygon
- [x] Render pins as circles (color-coded by side: top/bottom)
- [x] Render part boundaries (bounding box from pin positions)
- [x] Implement layer toggle (top/bottom visibility)
- [x] Performance optimization: culling, render textures

### Phase 3: Interaction & Selection ✅ DONE
- [x] Component hover highlight
- [x] Component click selection
- [x] Net highlight (click pin → highlight all pins on same net)
- [x] Search by component name or net name
- [x] Keyboard shortcuts (flip board, zoom to fit, reset view)
- [x] Context menu on right-click

### Phase 4: Panel System ✅ DONE
- [x] Integrate Dockview layout (v5)
- [x] Component Info panel (pins list, metadata)
- [x] Net List panel
- [x] Search Results panel
- [x] PDF Viewer panel (pdfjs-dist)
- [x] Settings panel
- [x] Make panels detachable/floating
- [x] IndexedDB cache for fast re-open

### Phase 4+: Extended Features ✅ DONE
- [x] Multi-board tabs (open multiple .bvr files, switch between them)
- [x] Butterfly mode (side-by-side mirrored view of both board sides)
- [x] Net lines (visual connections between components sharing a net)
- [x] Settings panel with live PixiJS mockup preview
- [x] Per-net color rules (pattern-based, first-match wins)
- [x] Context menu (right-click: copy name, highlight net, open panel)

### Phase 5: Polish (IN PROGRESS)
- [x] File drag-and-drop upload
- [x] Recent files list
- [ ] Dark/light theme toggle
- [ ] Production optimizations (gzip, caching headers)

### PDF Viewer (DONE)
- [x] Multi-document PDF viewer with per-document state
- [x] PDF text search (multi-term, spatial, @page syntax)
- [x] PDF ↔ component binding (click component → jump to PDF location)
- [x] Bookmarks, night mode, page scrubber
- [x] PDF content search from library panel

---

## Rendering Architecture

Scene graph is built by the shared pure function `buildBoardScene(board, settings)` in
`renderer/board-scene.ts`, used by both `BoardRenderer` and `SettingsMockup`.

```
PixiJS Application
└── Viewport (pixi-viewport)
    ├── sceneRoot (Container) — built by buildBoardScene()
    │   ├── outlineGfx (Graphics)          // Board outline polygon
    │   ├── bottomLayer (Container, cullable)
    │   │   └── partContainer[n] (cullable)
    │   │       ├── pinGfx (Graphics, batched per color)
    │   │       └── borderGfx (Graphics)
    │   └── topLayer (Container, cullable)
    │       └── partContainer[n] (same structure)
    ├── butterflyRoot (Container | null)   // Mirrored bottom-side for butterfly mode
    ├── netLinesGfx (Graphics)            // Net connection lines between components
    ├── selectionGfx (Graphics)           // Selection rect + net highlight circles
    └── labelsRoot (Container)            // Part name BitmapText labels (above selection)

HTML/React overlay
    ├── Toolbar
    ├── TabBar
    └── StatusBar
```

Part labels use **BitmapText** with shared glyph atlases (one atlas per quantized font size),
keeping GPU draw calls to a minimum. Labels are rendered in a separate top-level container
so they always appear above the selection/highlight overlay.

### Performance Strategy
1. **Static elements** (outline, non-selected pins) → render to texture, redraw only on zoom level change
2. **Repeated shapes** (pins) → shared Sprite textures, GPU-batched
3. **Culling** → `cullable = true` on all containers, skip off-screen draws
4. **Event optimization** → `eventMode = 'none'` on non-interactive elements; use spatial index (grid) for hit testing instead of per-sprite events
5. **Level of detail** → at low zoom, render parts as simple rectangles; at high zoom, show pin details

---

## Data Flow

```
.bvr file → Upload/Drag-drop
         → Client-side parser (pure TS function)
         → BoardData model
         → PixiJS scene graph construction
         → Spatial index construction (for search/selection)
         → UI panels populated
```

### BoardData Model (TypeScript)

See `parsers/types.ts` for the canonical definitions. Summary:

```typescript
interface BoardData {
  format: string;       // e.g. 'BVR1', 'BVR3', 'BRD', 'BDV', 'FZ', 'CAD', 'XZZ', 'TVW', 'ALLEGRO_BRD'
  outline: Point[];
  parts: Part[];
  nails: Nail[];
  nets: Map<string, Net>;  // derived: net_name → { name, pins[] }
  bounds: BBox;            // computed global bounds of all points
  traces?: Trace[];        // PCB traces (TVW, Allegro)
  vias?: Via[];            // vias (TVW, Allegro)
  layerNames?: string[];   // multi-layer board layer names
  butterflyFoldAxis?: 'x' | 'y';  // axis for butterfly mode fold
  flipY?: boolean;         // parser hint: Y-axis is inverted
}

interface Part {
  name: string;
  side: 'top' | 'bottom' | 'both';
  type: 'smd' | 'throughhole';
  origin: Point;
  pins: Pin[];
  bounds: BBox;
  layer?: number;          // layer index for multi-layer boards
}

interface Pin {
  name: string;
  number: string;
  position: Point;     // always absolute (resolved)
  radius: number;
  side: 'top' | 'bottom';
  net: string;
}

interface Nail {
  position: Point;
  side: 'top' | 'bottom';
  net: string;
}

interface Point { x: number; y: number; }
interface BBox { minX: number; minY: number; maxX: number; maxY: number; }
```

---

## Panel Layout (Dockview)

```
┌──────────────────────────────────────────────────────────┐
│  Toolbar: [Open] [Flip] [Top/Bottom] [Zoom Fit] [Search]│
├──────────────────────────────────────┬───────────────────┤
│                                      │  Component Info   │
│                                      │  ┌─────────────┐  │
│        PixiJS Board Canvas           │  │ Name: U1900  │  │
│        (pan/zoom viewport)           │  │ Side: Top    │  │
│                                      │  │ Type: SMD    │  │
│                                      │  │ Pins: 256    │  │
│                                      │  ├─────────────┤  │
│                                      │  │ Pin  Net     │  │
│                                      │  │ A1   VCC3V3  │  │
│                                      │  │ A2   GND     │  │
│                                      │  │ ...          │  │
│                                      │  └─────────────┘  │
├──────────────────────────────────────┴───────────────────┤
│  Status: Components: 1,247 | Nets: 892 | Zoom: 150%     │
└──────────────────────────────────────────────────────────┘
```

Panels can be:
- **Docked** (right sidebar, bottom bar)
- **Floating** (dragged out, overlays the canvas)
- **Popped out** (separate browser window)

---

## File Structure

```
src/
├── frontend/src/
│   ├── main.tsx                    # React entry point
│   ├── App.tsx                     # Dockview layout root, panel wiring, drag-drop
│   ├── index.css                   # Global styles (dark theme)
│   ├── parsers/                    # 9 format parsers — see registry.ts for full list
│   │   ├── types.ts               # BoardData, Part, Pin, Net, Trace, Via, BBox interfaces
│   │   ├── registry.ts            # FormatDescriptor registry + content-based detection
│   │   ├── index.ts               # Barrel re-export
│   │   ├── *-parser.ts / *-format.ts  # One parser + one descriptor per format
│   │   └── allegro/               # Allegro BRD sub-modules (6 files)
│   ├── renderer/
│   │   ├── BoardRenderer.ts       # PixiJS orchestrator (viewport, selection, net lines, LoD)
│   │   ├── board-scene.ts         # Shared scene builder — used by renderer + settings mockup
│   │   └── mockup-data.ts         # Static fake board for SettingsMockup
│   ├── components/                # Toolbar, StatusBar, TabBar, ContextMenu, BoardSidebar, etc.
│   ├── panels/                    # Dockview panels: BoardViewer, PDF, Settings, NetList, etc.
│   ├── hooks/                     # createStoreHook factory, useBoardStore, usePdfStore, useDatabank
│   └── store/                     # board-store, pdf-store, render-settings, board-cache, etc.
│       └── tests/                  # Playwright E2E specs (12 files)
├── backend/
│   ├── main.go                    # HTTP server (env config, routes, SPA fallback)
│   └── handlers/files.go         # Upload, list, get, delete handlers
```

---

## Docker Setup

```dockerfile
# Stage 1: Build frontend
FROM node:20-alpine AS frontend
WORKDIR /app/frontend
COPY src/frontend/package*.json ./
RUN npm ci
COPY src/frontend/ ./
RUN npm run build

# Stage 2: Build backend
FROM golang:1.22-alpine AS backend
WORKDIR /app/backend
COPY src/backend/go.* ./
RUN go mod download
COPY src/backend/ ./
RUN CGO_ENABLED=0 go build -o server .

# Stage 3: Final image
FROM scratch
COPY --from=backend /app/backend/server /server
COPY --from=frontend /app/frontend/dist /static
EXPOSE 8080
ENTRYPOINT ["/server"]
```

```yaml
# docker-compose.yml
services:
  boardripper:
    build: .
    ports:
      - "8080:8080"
    volumes:
      - ./data:/data    # persistent boardview storage
    restart: unless-stopped
```
