# Home Backdrop (Welcome Screen) — Design

**Date:** 2026-04-19
**Scope:** Add a welcome/dashboard surface shown at app startup when no board or PDF is open. Hides automatically when the user opens a file.

## Goals

- Replace the blank Dockview area at app start with a useful landing screen.
- Surface: latest release notes, quick settings (drag bindings, auto-switch), keyboard-shortcut reference.
- Must not block any interaction with toolbar, sidebar, drag-drop, or future panels.
- Must vanish when any file is open and reappear when all files are closed.

## Architecture

New React component `HomeBackdrop` rendered as a sibling of `<DockviewReact>` inside `.dockview-container`.

- Absolutely positioned (`inset: 0`).
- `z-index` below Dockview's panel layer (Dockview panels take precedence whenever they exist).
- Visible when `boardStore.tabs.length === 0 && <no pdf docs open>`.
- Hidden via `display: none` after a short opacity fade when a file opens.
- Scrollable as a single surface (no internal scroll containers).
- Drop events bubble to the outer app drop handler (no `stopPropagation`).

No Dockview panel registration. The backdrop is decorative — not a docking target, has no tab, cannot be closed by the user.

## Content layout (top → bottom, single column, max-width ~900px, centered)

1. **Banner** — centered monospace bold, ~2rem: `***WELCOME YOU TO BOARDRIPPER***`. No spaces between text and asterisks.
2. **Rant subtitle** — centered, muted (`var(--text-secondary)`), smaller (~0.9rem). Random pick from `welcomeRants` pool, stable per session (module-level random pick on first import).
3. **Instructions card** — user-editable content loaded from `components/home/instructions.md` via Vite `?raw` import, rendered by the tiny in-house `markdown.tsx` (headings, bullets, bold, italic, inline code, links). Swap for `marked` if it outgrows the minimal subset.
4. **Latest update card** — `release_info.tag_name`, publish date (relative), `release_info.body` as pre-wrapped text. "Update available" badge when `has_update === true`. Empty state: "No release info — check your connection." Sourced from existing `updateStore`.
4. **Quick settings** — auto-fit grid (min 260px cols, responsive).
   - **Mouse drag bindings** — bare vs shift pill-swap, toggles `dragToZoom`.
   - **Scroll-wheel bindings** — bare vs shift/ctrl pill-swap, toggles `twoFingerPan`.
   - **Auto-switch linked board ↔ PDF** — single toggle wired to `isAutoSwitchLinked()` / `setAutoSwitchLinked()`.
   - **Open full Settings →** link at the bottom of the settings block (opens the Sidebar Settings tab via `showSidebarTab('settings')`).

   Both pill-swap editors share a single generic `PillSwap` component (two slots, pan/zoom pills) to avoid duplication.
5. **Keyboard shortcuts** — grouped by category (File, View, Navigation, PDF), 2–3 column grid. Each row: formatted shortcut pill + description. Sourced from `shortcuts[]` in `store/keyboard-shortcuts.ts` via existing `formatShortcut()`. Display-only.
6. **Footer** — `BoardRipper v{current_version} · AGPL-3.0` with link to GitHub.

## Initial rant pool (`src/frontend/src/components/home/rants.ts`)

Two entries to start. Adding more is a one-line addition.

**Rant G (tight):**
> This is a board-in screen, not a Microsoft Edge onboarding funnel. No sign-in, no default-browser ceremony, no Copilot upsell, no "are you sure you want to close this tab" modal that reopens when you dismiss it. Open a file — this screen leaves without making a scene.

**Rant H (mid-length):**
> This is a board-in screen. Unlike Edge, it will not: demand a Microsoft account, beg to be your default, push Bing, suggest Copilot, or hold the close button hostage until you have agreed to three things. Just open a file. It gets out of the way. Ignore it entirely if you prefer — that is also a fully supported workflow.

## File layout

```
src/frontend/src/components/home/
├── HomeBackdrop.tsx     # top-level + all section components
├── rants.ts             # welcomeRants pool + session-stable random pick
├── instructions.md      # editable dashboard content (rendered by markdown.tsx)
└── markdown.tsx         # ~60-line MD → React renderer (headings, bullets, bold, italic, code, links)
```

Styles are appended to the project's single `src/frontend/src/index.css` (project convention — no per-component CSS files).

Mounted in `App.tsx` inside `.dockview-container` next to `<DockviewReact>`. `.dockview-container` gets `position: relative` so the backdrop's `position: absolute; inset: 0` anchors to it.

## Styling

- Reuse CSS variables from `index.css` (`--bg-primary`, `--bg-secondary`, `--border-color`, `--text-primary`, `--text-secondary`, `--accent-color`).
- No new colors. Theme-swap safe once dark/light toggle is added later.
- Banner uses monospace to preserve the LANDREX asterisk aesthetic.

## Out of scope

- Theme toggle (future work).
- Editable keyboard shortcuts (display-only for now).
- Release history scroll (only latest release).
- Internationalization.

## Testing

- Manual in dev server: load app with no files → backdrop visible; open board → backdrop hides; close all boards → backdrop returns; open PDF only → backdrop hides.
- No Playwright test required for this iteration — visual-only surface, existing test suite covers file-open flows.
