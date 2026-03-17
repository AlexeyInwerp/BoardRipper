# BoardRipper — Frontend

React + TypeScript + Vite SPA for viewing PCB boardview files.

## Stack

- **React 19** + TypeScript (strict mode)
- **PixiJS v8** (WebGL) + **pixi-viewport v6** — GPU-accelerated PCB rendering
- **Dockview v5** — dockable/floating/popout panel system
- **pdfjs-dist** — PDF viewer panel
- **Playwright** — E2E tests

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production build → dist/
npm run lint
```

## Tests

```bash
npx playwright install chromium  # first time only
npx playwright test
```

> Note: Headless Chromium has no WebGL adapters — PixiJS "No available adapters" warning is expected in tests.

## Supported Formats

- **BVR1** (`BVRAW_FORMAT_1`) — tab-delimited, absolute coords ×1000
- **BVR3** (`BVRAW_FORMAT_3`) — keyword-value, relative pin coords

Parsers are pure functions: `(text: string) => BoardData`. See `src/parsers/`.

## Caching

Parsed `BoardData` is stored in IndexedDB (`boardripper-cache`) keyed by `fileName:fileSize:lastModified` for fast re-open without re-parsing.
