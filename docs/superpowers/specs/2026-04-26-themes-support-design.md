# Themes Support (v1)

**Status:** design approved, ready for implementation plan
**Date:** 2026-04-26
**Scope:** UI chrome + canvas/board theming, two presets, metadata-color integration, Settings panel tabs refactor
**Out of scope:** custom theme authoring (color pickers per slot), per-board theme overrides, adaptive theme-by-brand, backend-writable `colors.hex`, PDF night-mode coupling. All listed in "Future work" below.

---

## Goal

Introduce a theme system with two named presets shipping in v1:

1. **BoardRipper Default** — exact current colors. Existing users see zero visual change after this lands.
2. **Landrex Classic** — black canvas/UI, white parts/labels, yellow selection (mimics the legacy Landrex boardview viewer's classic aesthetic).

A theme bundles every color currently hardcoded somewhere in the app — UI chrome (toolbar/sidebar/panels), canvas background, board fill, selection ring, label text. One picker switches all of them in lockstep.

A separate global toggle ("Use board metadata color") makes the per-board fill follow the resolver's `colors.hex` value when available, falling back to the theme default. This composes cleanly with the existing `boardFillAlpha` slider.

The Settings panel is restructured to use a tab strip (matching the LibraryPanel pattern) so the new Theme settings get their own clean home and the existing 1543-line scrollable wall is broken into four manageable surfaces.

## Non-goals (this iteration)

- Custom theme authoring — color pickers per theme slot. Data model supports it; UI doesn't exist.
- Per-board theme overrides — themes are global only.
- Adaptive theme-by-brand (Apple→black theme, Dell→blue, etc.) — listed as future work in the boards.db UUID+color spec.
- PDF viewer night-mode coupling — PDF night mode stays a decoupled toggle.
- Backend writing to `colors.hex` from the UI — `colors.hex` is populated via SQL seed data only.
- New themes beyond the two presets — but the architecture must make adding more a one-record change.

---

## Theme data model

A flat record listing every themeable color, lives in a new file `src/frontend/src/store/themes.ts`:

```ts
export interface Theme {
  id: string;                  // 'default' | 'landrex'
  label: string;               // 'BoardRipper Default' | 'Landrex Classic'

  /** UI chrome — drives CSS custom properties on document.documentElement. */
  ui: {
    bgPrimary: string;         // app/panel background       (currently --bg-primary  #0f0f1a)
    bgSecondary: string;       // toolbar buttons, inputs    (currently --bg-secondary #1a1a2e)
    bgTertiary: string;        // toolbar bar background     (currently --bg-tertiary  #16213e)
    textPrimary: string;       // currently --text-primary  #e0e0e0
    textSecondary: string;     // currently --text-secondary #a0a0b0
    accent: string;            // currently --accent        #4a9eff
    border: string;            // currently --border        #2a2a40
  };

  /** Board canvas — drives PixiJS scene constants. */
  board: {
    canvasBackground: string;  // viewport background      (currently 0x1a1a2e in COLORS.background)
    boardFill: string;         // default fill inside outline (currently hardcoded 0xffffff)
    selection: string;         // selection ring + net highlight (currently 0xffff44 in COLORS.netHighlight)
    butterflySelection: string;// flip-side selection      (currently hardcoded 0x44aaff)
    labelText: string;         // BitmapText fill on labels (currently 0xffffff)
  };
}

export const THEMES: Record<string, Theme> = {
  default: {
    id: 'default',
    label: 'BoardRipper Default',
    ui: {
      bgPrimary:     '#0f0f1a',
      bgSecondary:   '#1a1a2e',
      bgTertiary:    '#16213e',
      textPrimary:   '#e0e0e0',
      textSecondary: '#a0a0b0',
      accent:        '#4a9eff',
      border:        '#2a2a40',
    },
    board: {
      canvasBackground:    '#1a1a2e',
      boardFill:           '#ffffff',
      selection:           '#ffff44',
      butterflySelection:  '#44aaff',
      labelText:           '#ffffff',
    },
  },
  landrex: {
    id: 'landrex',
    label: 'Landrex Classic',
    ui: {
      bgPrimary:     '#000000',
      bgSecondary:   '#0a0a0a',
      bgTertiary:    '#141414',
      textPrimary:   '#ffffff',
      textSecondary: '#b0b0b0',
      accent:        '#ffff44',  // accent matches selection — single yellow signal color
      border:        '#262626',
    },
    board: {
      canvasBackground:    '#000000',
      boardFill:           '#ffffff',
      selection:           '#ffff44',
      butterflySelection:  '#44aaff',
      labelText:           '#ffffff',
    },
  },
};
```

**Selection color** is a theme variable in both presets even though both presets ship the same yellow — future presets can change it (e.g. a "high contrast" theme might want pure red). No code path should reference yellow as a hardcoded constant after this lands.

**Adding a third theme** = one entry in `THEMES`. No other file touched.

---

## CSS theming pipeline (UI chrome)

The 7 `ui.*` colors map 1:1 to the existing CSS variables defined in `src/frontend/src/index.css:1-16`. Mechanism:

A new `themeStore` (small `Emitter`-based singleton, mirrors `renderSettingsStore`) holds `activeId`. On every change:

```ts
function applyThemeToDOM(theme: Theme) {
  const root = document.documentElement;
  root.style.setProperty('--bg-primary',     theme.ui.bgPrimary);
  root.style.setProperty('--bg-secondary',   theme.ui.bgSecondary);
  root.style.setProperty('--bg-tertiary',    theme.ui.bgTertiary);
  root.style.setProperty('--text-primary',   theme.ui.textPrimary);
  root.style.setProperty('--text-secondary', theme.ui.textSecondary);
  root.style.setProperty('--accent',         theme.ui.accent);
  root.style.setProperty('--border',         theme.ui.border);
  root.style.setProperty('--canvas-bg',      theme.board.canvasBackground);
}
```

**Why imperative `setProperty` and not a `[data-theme="landrex"]` attribute selector:**
- Adding a future theme would require editing both `themes.ts` AND `index.css` — splits one concept across two files and invites drift.
- The hex values already live in `themes.ts`, so duplicating them in CSS is asking for divergence.

The existing `:root { ... }` block in `index.css` stays as the **fallback** (= Default theme values). Default's CSS values match the Default theme exactly, so there's no flash-of-unthemed-content if JS hasn't run yet.

A new CSS variable `--canvas-bg` is added. The `<body>` and `#root` background-color rules switch from `var(--bg-primary)` to `var(--canvas-bg)` so that when the canvas is briefly torn down or rebuilt (tab switches, scene rebuilds), there's no contrast flash between page background and canvas.

No other CSS file changes — every component that already uses `var(--bg-primary)` etc. (toolbar, sidebar, panels, modals, scrollbars) is themed automatically.

---

## PixiJS canvas theming pipeline

The `board.*` colors map to constants currently scattered across the renderer:

| Theme key | Today | Where |
|---|---|---|
| `canvasBackground` | `0x1a1a2e` | `COLORS.background` in `board-scene.ts:40`, passed to `Application` init at `BoardRenderer.ts:667,776` |
| `boardFill` | `0xffffff` literal | `board-scene.ts:313` `gfx.fill({ color: 0xffffff, alpha: s.boardFillAlpha })` |
| `selection` | `0xffff44` | `COLORS.netHighlight` in `board-scene.ts:45` |
| `butterflySelection` | `0x44aaff` literal | `BoardRenderer.ts:2484, 2489` |
| `labelText` | `0xffffff` literals | `board-scene.ts:198, 250`; `BoardRenderer.ts:716, 840, 2353` |

**Mechanism:** the COLORS object becomes a getter that reads from the active theme:

```ts
// board-scene.ts (rewritten)
import { themeStore } from '../store/themes';
function activeBoard() { return themeStore.activeTheme().board; }

export const COLORS = {
  get background()   { return hexToInt(activeBoard().canvasBackground); },
  get netHighlight() { return hexToInt(activeBoard().selection); },
  get labelPin()     { return hexToInt(activeBoard().labelText); },
  // ...
};
```

Hardcoded literals in `BoardRenderer.ts` (butterfly selection, label fills) are replaced with `COLORS.butterflySelection` / `COLORS.labelText` references.

`BoardRenderer.subscribe(themeStore, () => this.rebuildScene())` triggers a full scene rebuild on theme change — same code path that `renderSettingsStore` already uses for setting changes. PixiJS `Application.renderer.background.color` is set live (no `app.destroy()` — see CLAUDE.md safety rule).

`boardFill` is the **theme default**. The metadata-color switch (next section) overrides it per-board at draw time. The renderer reads the effective fill color through a single helper rather than reading `theme.board.boardFill` directly.

---

## Metadata color integration

**Storage** — one new boolean in `RenderSettings`:

```ts
useMetadataBoardColor: boolean;  // default: false
```

Lives in the same `boardripper-render-settings` localStorage payload. Migration is automatic — `loadFromStorage()` already merges parsed values over `DEFAULTS`, so an absent key resolves to `false`.

**Resolution at draw time** — single helper in the renderer:

```ts
export function resolveBoardFillColor(
  match: BoardMatch | null,
  theme: Theme,
  useMetadata: boolean,
): number {
  if (useMetadata && match?.color_hex) {
    return parseInt(match.color_hex.slice(1), 16);
  }
  return parseInt(theme.board.boardFill.slice(1), 16);
}
```

**Resolver API extension** — the boards.db UUID+color spec already adds `Color string` to `BoardMatch` (canonical lowercase name). Themes work adds one more field:

```go
type BoardMatch struct {
    // ... existing fields ...
    Color    string `json:"color,omitempty"`      // already in boards.db spec — canonical name
    ColorHex string `json:"color_hex,omitempty"`  // NEW — hex from colors.hex column
}
```

The resolver SQL changes from `SELECT colors.name AS color` to `SELECT colors.name AS color, colors.hex AS color_hex` on the existing `LEFT JOIN colors`. One extra column, zero new endpoints, ~10 bytes per match. Frontend gets hex inline with every board match — no separate fetch or cache lifecycle.

**`boardFillAlpha` interaction** — the existing slider stays as-is and modulates the alpha for both theme-default and metadata-color cases. A green Lenovo board at the default 0.08 alpha is a faint green wash; cranking the slider up makes it more vibrant. Composes cleanly.

**Seed data caveat** — the boards.db v1 spec ships `colors.hex` as `NULL` for all 12 entries. Themes work populates them as part of the SQL change in `Board Database/build_full_db.sql`:

| name | hex (proposed) | rationale |
|---|---|---|
| black | `#1a1a1a` | Apple-style premium PCB |
| red | `#8a1a1a` | distinctive but muted |
| green | `#1a4a2a` | classic FR-4 |
| blue | `#1a3a8a` | Dell / Lenovo Legion |
| white | `#e0e0e0` | premium matte |
| yellow | `#a89030` | rare |
| purple | `#5a2a8a` | rare |
| orange | `#c06030` | rare |
| pink | `#c060a0` | rare |
| brown | `#6a4a2a` | rare |
| silver | `#a8a8b0` | industrial |
| gold | `#a89050` | premium |

Hex values are deliberately desaturated — at the default `boardFillAlpha=0.08` a saturated green would be invisible; at full saturation cranked up via the slider it would fight the labels. These are the substrate-color tints the board fill should appear as, not pure brand colors.

**Metadata editor display** — the `MetadataEditModal` in `src/frontend/src/panels/LibraryPanel.tsx:1264-1333` gains one read-only row above the input fields:

```
PCB Color: ● blue (hex set)         ← match exists, colors.hex populated
PCB Color: ○ blue (no hex yet)      ← match exists, colors.hex still NULL
PCB Color: — (no resolver match)    ← board has no metadata at all
```

The colored dot uses the hex when available, neutral gray (`#666`) when `colors.hex` is NULL or no match. Read-only — purely an indicator so the user knows whether toggling "Use metadata color" will do anything for this board. No editing of the canonical color from the UI.

---

## Settings panel restructuring (tabs)

The 1543-line `src/frontend/src/panels/SettingsPanel.tsx` gains a tab strip at the top, mirroring the `library-tab` pattern from `LibraryPanel.tsx` (CSS classes, ARIA roles, keyboard nav).

### Tab structure (4 tabs)

| Tab | Sections (in order) |
|---|---|
| **Theme** | Theme picker (radio list: Default / Landrex Classic) · "Use board metadata color" toggle |
| **Board** | Board Outline · Parts/Components · Pins/Pads · Part Types · Pin Colors by Net · Selection & Highlight · Net Lines |
| **Input** | Zoom Level of Detail · Navigation · Keyboard Shortcuts |
| **System** | Performance & Debug · PDF Viewer · Server/Library |

Each tab content area is vertically scrollable. The existing `CollapsibleSection` machinery is preserved **inside each tab** — sections within a tab still expand/collapse independently.

### Active tab persistence

Stored under `boardripper-settings-active-tab` (single-string localStorage key, owned by `SettingsPanel` itself — not part of `themeStore`, since this is transient UI state, not theme state). On reload, returns to the last viewed tab. First-run default = `'board'` — board rendering is the most-edited area today, and putting users on Board (not the new Theme tab) means themes are opt-in discovery rather than a surprise on first open.

### `focusedSection` deep links

Today, callers like the toolbar's "Open Settings → Part Types" button call `focusSection('partTypeOverrides')` to scroll to that section. The replacement: `focusSection(id)` first switches to the tab that owns `id`, then scrolls.

A `SECTION_TO_TAB: Record<SectionId, TabId>` map (12 entries — one per existing `SectionId`) routes the call. Existing call sites stay unchanged.

### `INITIALLY_OPEN` semantics

Currently a flat array of section IDs that start expanded. After tabs, persistence becomes per-tab — each tab remembers which of its collapsibles are open. New keys: `boardripper-settings-open-sections-${tabId}`.

### File layout

`SettingsPanel.tsx` stays one file (~1543 lines plus ~80 for the tab strip + router). Each "section" is already a self-contained `function XxxSection(...)` component; only the orchestrator changes. Splitting per-tab means a new file per tab + a coordinating wrapper, which buys nothing for readability and adds import noise.

---

## Persistence & storage

| Key | Owner | Contents | Migration |
|---|---|---|---|
| `boardripper-render-settings` | `renderSettingsStore` | unchanged shape; gains `useMetadataBoardColor: false` | automatic — absent key merges to `false` |
| `boardripper-theme` | `themeStore` (new) | `{ activeId: 'default' \| 'landrex' }` (object, not bare string, for forward compat) | absent → `'default'` |
| `boardripper-settings-active-tab` | `SettingsPanel` local | last-viewed Settings tab id (`'theme' \| 'board' \| 'input' \| 'system'`) | absent → `'board'` |
| `boardripper-settings-open-sections-${tabId}` | `SettingsPanel` local | `string[]` of expanded section ids in that tab | absent → `[]` (none open) |

Themes are **global, not per-board** — no entry in the `boardripper-board-overrides` map. Aesthetic preferences shouldn't change when switching files.

---

## Theme switch flow

`themeStore.setTheme(id: string)`:
1. Validate `id` exists in `THEMES`. Unknown id → log via `log.ui.warn`, fall back to `'default'`.
2. Update `_active`, persist `{ activeId }` to localStorage.
3. Call `applyThemeToDOM(theme)` — 8 `setProperty` writes (7 UI vars + `--canvas-bg`).
4. Notify subscribers — each `BoardRenderer` instance:
   a. swaps `app.renderer.background.color` to the new canvas background.
   b. triggers a scene rebuild (same path as a render-settings change).
   c. re-runs label/selection draws.

Total cost: ≤8 DOM writes + 1 PixiJS scene rebuild. Sub-frame for both. No app re-init, no `app.destroy()` (see CLAUDE.md safety rule on PixiJS v8 batchPool corruption).

---

## Edge cases

- **Unknown theme id in localStorage** (forward-compat / corruption): fall back to `'default'`, log via `log.ui.warn`. Do NOT clear the corrupt value — keep it for diagnostics; on next valid `setTheme()` call it's overwritten.
- **Theme switch mid-render** (during heavy zoom/scroll): notification batched into the next animation frame; PixiJS scene rebuild is already debounced via the existing render-settings change path, themes piggyback.
- **Multiple BoardRenderer instances** (Dockview floating windows, popout boards): each subscribes independently to `themeStore`, so all canvases re-theme in lockstep on a single `setTheme()`.
- **Server-rendered metadata-color hex stale** relative to a freshly-built `colors` table: backend rebuild is the canonical path; no runtime invalidation needed beyond what already exists for the resolver. Frontend re-fetches on next board open.
- **Use-metadata-color toggled while board is open**: `BoardRenderer` subscribes to `renderSettingsStore` already; flipping the new `useMetadataBoardColor` flag triggers the existing rebuild path. No special handling.
- **Board has no resolver match at all** (rare, e.g. an unrecognized file): `match` is null, `resolveBoardFillColor` falls back to theme default regardless of the toggle's state. No error.
- **`colors.hex` is NULL for a matched color** (transitional state during themes rollout): `match.color_hex` is absent in the JSON; `resolveBoardFillColor` falls back to theme default. Metadata editor shows the "no hex yet" state.

---

## Migration

Two surfaces affected: the SQL seed data and the frontend.

**Backend:**
1. Edit `Board Database/build_full_db.sql` — populate `hex` in the 12 `INSERT INTO colors` rows per the table in "Metadata color integration" above.
2. Edit `src/backend/boarddb/boarddb.go` — add `ColorHex string \`json:"color_hex,omitempty"\`` to `BoardMatch`.
3. Edit the resolver query in `src/backend/boarddb/resolve.go` and `Board Database/resolve_board.sql` — extend the `LEFT JOIN colors` SELECT list to include `colors.hex AS color_hex`. (Both files are touched by the boards.db UUID+color spec; this is an additive column on the same JOIN.)
4. Rebuild `boards.db` (same flow as the boards.db UUID+color spec — `rm boards.db && sqlite3 boards.db < create_mockup_db.sql && sqlite3 boards.db < build_full_db.sql`).

**Frontend:**
5. Create `src/frontend/src/store/themes.ts` — `Theme` interface, `THEMES` registry, `themeStore` singleton, `applyThemeToDOM` helper.
6. Edit `src/frontend/src/store/render-settings.ts` — add `useMetadataBoardColor: false` to `DEFAULTS` and `RenderSettings`.
7. Edit `src/frontend/src/index.css` — add `--canvas-bg: #1a1a2e` to `:root`, switch `body`/`#root` `background:` to `var(--canvas-bg)`.
8. Edit `src/frontend/src/renderer/board-scene.ts` — convert `COLORS` from const to getter object reading from `themeStore.activeTheme().board`. Replace inline `0xffffff` board-fill literal with `resolveBoardFillColor(...)` call.
9. Edit `src/frontend/src/renderer/BoardRenderer.ts` — replace remaining hardcoded `0xffffff` / `0x44aaff` with `COLORS.labelText` / `COLORS.butterflySelection`. Add `themeStore` subscription that triggers `rebuildScene()` and updates `app.renderer.background.color`.
10. Edit `src/frontend/src/panels/SettingsPanel.tsx` — add tab strip, `SECTION_TO_TAB` map, per-tab `INITIALLY_OPEN` persistence keys; add new `ThemeSection` component for the Theme tab; update `focusSection` to switch tabs first.
11. Edit `src/frontend/src/panels/LibraryPanel.tsx` — add the read-only PCB Color row to `MetadataEditModal`.
12. Edit `src/frontend/src/App.tsx` — call `themeStore.init()` once at the top of `App` (or in a top-level `useEffect` before the first `BoardRenderer` mounts) so the saved theme is applied before first paint. Implementation plan picks the exact insertion point based on current App structure.

**Verification:**
- Open a fresh install (clear localStorage). UI looks identical to current. Open Settings → Theme tab is visible but defaults to Board tab.
- Switch to Landrex Classic. Toolbar/sidebar/panels turn black, canvas turns black, board fill stays white, selection stays yellow.
- Switch back to Default. All colors restore. Reload — still Default (persistence works).
- Open a known Apple board (color_id=1 → black, color_hex=`#1a1a1a`). Toggle "Use board metadata color" on. Board fill becomes faint dark gray (at default alpha). Crank `boardFillAlpha` slider — gray gets more visible.
- Open a board with no resolver match. Toggle on. Board fill stays white (theme default). No error.
- Open the metadata editor for a board with color but NULL hex. See "no hex yet" indicator.
- Switch tabs in Settings. Each tab remembers its open sections across switches and reloads. Click a toolbar button that deep-links to Part Types — Settings opens directly on the Board tab with Part Types expanded and scrolled into view.
- Open two boards in separate Dockview floating windows. Switch theme. Both canvases re-theme.

---

## Future work (documented now, deferred)

These slot cleanly into the architecture above without retrofit pain:

### Custom theme authoring

Color pickers per theme slot, save user themes alongside the built-in `THEMES`. The `themeStore` already keys by id; `THEMES` extension to `THEMES: Record<string, Theme>` already supports user entries. UI-only addition.

### Per-theme tweaks (mixed mode)

A theme picks the preset; user overrides individual slots (e.g. "Landrex but with blue selection"). Add a `themeOverrides: Partial<Theme['board'] & Theme['ui']>` to `themeStore`, layer at apply time. No data-model break.

### Adaptive theme-by-brand

When the resolver returns Apple → auto-pick the Landrex variant; Dell → auto-pick a blue-tinted theme. Lives as a `brand_theme_defaults(brand_pattern, theme_id)` table or as code in the frontend. Listed as future work in the boards.db UUID+color spec.

### PDF night-mode coupling

Currently PDF night mode is a decoupled toggle. Could be auto-driven by theme (Landrex = night on, Default = night off) with a per-theme `pdf.nightMode: boolean` slot. Trivial extension once the user asks for it.

### Backend writable `colors.hex`

Writing canonical color hex from the UI back to `boards.db`. Requires the DB to become runtime-writable, which the boards.db UUID+color spec deliberately avoids. Separate brainstorm.

---

## Open questions for implementation plan

(none — design is locked; implementation plan handles ordering, file-by-file diffs, and any cleanup spotted during the SettingsPanel refactor)
