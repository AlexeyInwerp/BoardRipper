# Boardviewer — Project Configuration

## Project Overview
PCB Board Viewer — web-based application for viewing and inspecting PCB boardview files. Hosted via Docker on NAS.

## Tech Stack
- **Rendering:** PixiJS v8 (WebGL) + pixi-viewport (pan/zoom/culling)
- **Frontend:** React + TypeScript + Vite
- **Panels:** Dockview (dockable, detachable, floating panels)
- **Backend:** Go (net/http stdlib) — serves SPA + handles file uploads
- **Container:** Docker (multi-stage build, scratch-based, ~15MB)

## Supported Formats
- BVR1 (`BVRAW_FORMAT_1`) — tab-delimited, absolute coords ×1000
- BVR3 (`BVRAW_FORMAT_3`) — keyword-value, relative pin coords
- Format spec: `docs/formats/BVR_FORMAT.md`

## Project Structure
```
Boardviewer/
├── CLAUDE.md              # This file
├── docs/
│   ├── formats/           # File format specifications
│   │   └── BVR_FORMAT.md
│   └── PLANNING.md        # Architecture & implementation plan
├── src/
│   ├── frontend/          # React + PixiJS app
│   └── backend/           # Go server
├── docker/                # Dockerfile + compose
└── .claude/               # Claude Code settings
```

## Key Architectural Decisions
- PixiJS v8 chosen over Canvas2D/Konva for GPU-accelerated rendering of 10,000+ components at 60fps
- Dockview chosen for IDE-like panel system with floating/popout window support
- Go backend chosen for minimal Docker footprint and single-binary deployment
- All BVR parsing happens client-side in TypeScript (no server dependency for rendering)

## Conventions
- TypeScript strict mode
- All coordinates internally in mils (thousandths of an inch)
- Component naming: PascalCase for React components, camelCase for functions/variables
- File format parsers are pure functions: `(text: string) => BoardData`

## Reference
- OpenBoardView source: https://github.com/OpenBoardView/OpenBoardView
- PixiJS v8 docs: https://pixijs.com/8.x/guides
- Dockview docs: https://dockview.dev/
