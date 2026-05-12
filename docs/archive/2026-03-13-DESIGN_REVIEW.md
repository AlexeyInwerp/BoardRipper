# BoardRipper — Design Review Suggestions

> Generated 2026-03-13. Not prioritised — items are observations and opportunities, not bugs.

---

## Architecture

**1. BoardRenderer.ts is very large and does too many things**
Handles PixiJS lifecycle, viewport management, scene building, selection rendering, net lines, hover state, context menus, butterfly mode, rotation/mirror, and multi-tab management in one file. Consider splitting into focused helpers (e.g. SelectionManager, NetLineRenderer).

**2. Full scene rebuild on every settings change**
`buildBoardScene()` recreates all Graphics objects even when only a color or alpha changes. For large boards (3000+ parts) this causes noticeable CPU spikes while dragging sliders. Incremental updates (e.g. just recolor pins, just update alpha) would be more efficient.

**3. boardStore conflates data state and view state**
A single `BoardTab` object holds both board content (immutable once loaded) and view state (selection, rotation, layer visibility, search query). These change at very different rates. Separating them would simplify state reasoning.

**4. Two-pin part special-casing is duplicated**
The "rectangular pad" rendering logic for 2-pin parts is implemented independently in `board-scene.ts` and in `SettingsMockup.tsx` `hitTestSection()`. If pad rendering changes, both must be updated.

**5. `cleanupShadowFonts()` is never called**
`board-scene.ts` exports this function and BitmapFont atlases accumulate across settings changes / board switches. GPU memory is never reclaimed.

**6. Net color resolution has two paths**
`resolvePinColor()` exists as both a standalone pure function (in `render-settings.ts`) and as a method on `renderSettingsStore`. Only one path is needed.

**7. Settings store mixes rendering and interaction values in one flat object**
38+ fields in `RenderSettings` with no logical grouping. Fields like `clickThreshold` and `fitPadding` are interaction, not rendering. Group fields conceptually (e.g. `outline`, `pins`, `labels`, `interaction`).

**8. No validation on settings values**
`applySettings()` accepts any value. Constraints like `pinMinRadius <= pinMaxRadius` or valid `LabelSize` enum values are unenforced. Corrupt localStorage could cause silent rendering errors.

---

## UX / Interaction

**9. Net color rules can't be validated in the mockup**
The SettingsMockup uses hardcoded net names (VCC3V3, GND, SDA, etc.). If a user adds a custom net color rule for a net not in the mockup, they cannot see the result without applying to the full board.

**10. Preview/Apply/Cancel flow has ambiguous states**
Once "Preview" is active, dragging a slider still updates the board live. The distinction between "preview mode" and "normal editing" is unclear. Consider making the modes visually explicit.

**11. No minimap for large board navigation**
When zoomed in deeply, users lose positional context. A small corner overview showing the full board outline + current viewport position would help navigation on large boards.

**12. No progress indicator during file parsing / scene build**
Parsing a 3MB BVR3 file with 11k pins is not instant. Users see a blank canvas with no feedback until rendering completes.

**13. Search results don't navigate to the board**
Searching finds components, but there is no click-to-select/zoom-to-part in SearchResultsPanel. Users must visually locate the part after searching.

**14. Settings mockup doesn't show realistic density**
3 parts vs. 3000 on a real board. Label overlap, visual noise, and performance characteristics are not representative. A medium-complexity generated mockup (50–100 parts) would be more useful for tuning.

**15. Settings are not exportable or shareable**
Users can't save custom settings to a file or transfer them to another machine. A simple JSON export/import would address this.

**16. No keyboard shortcuts for common actions**
Flip, zoom to fit, layer toggles, search focus — none have keyboard bindings. Power users must click for everything.

---

## Visual Design

**17. Some text contrast is below WCAG AA**
`--text-secondary: #a0a0b0` on `--bg-primary: #0f0f1a` is approximately 2:1 contrast ratio. WCAG AA requires 4.5:1 for normal text. Affects badges, hints, and secondary labels.

**18. Magic numbers in rendering logic are undocumented**
Values like `eb.pw * 0.4` (pad depth ratio), `diameter * 0.7` (pin label sizing), `r * 0.7` (pin-1 triangle) have no comments explaining their purpose or how to tune them.

**19. BOARD_COLORS palette is not user-configurable**
The 10 hardcoded colors in `board-scene.ts` can't be customised. Colorblind users and high-contrast preferences have no recourse.

---

## Missing / Incomplete Features

**20. `netLinePulse` setting has no implementation**
`RenderSettings.netLinePulse` exists, a toggle appears in SettingsPanel, but no animation or visual effect is implemented in BoardRenderer. The toggle does nothing.

**21. Rotation and mirror fields may not be reflected in rendering**
`BoardTab` stores `rotation`, `mirrorX`, `mirrorY`, but it is unclear from BoardRenderer's structure whether these transforms are applied to the viewport. Needs verification.

**22. PDF ↔ component binding is unimplemented**
The PDF viewer is functional but clicking a component reference in the schematic doesn't jump to the board, and vice versa. The feature is partially plumbed (PDF store, panel) but not connected.

**23. No undo/redo for view or settings changes**
Settings Cancel only works during active editing and only reverts to the last Apply. View changes (pan, zoom, selection) have no history at all.

**24. Panel layout is not persisted**
Dockview layout resets to default on every page load. Users who rearrange panels lose their layout on refresh.

**25. No accessibility attributes**
Interactive elements in panels (pin rows, net list items, search results) lack `aria-*` attributes. Keyboard navigation through panel content is not supported.

---

## Backend

**26. File upload accepts any content with `.bvr` extension**
No content-type or magic-byte validation. A malformed file is accepted and causes a silent parse failure in the frontend.

**27. Same-name uploads silently overwrite previous files**
No collision handling, versioning, or user confirmation. Data loss risk in shared deployments.

**28. Files accumulate indefinitely**
No TTL, storage quota, or cleanup endpoint. Disk usage is unbounded on long-running deployments.

**29. SPA fallback may intercept missing static assets**
`main.go` falls back to `index.html` for all 404s. Requests for missing `.js`/`.css` files will silently receive HTML, causing confusing errors.

---

## Testing

**30. Test fixtures don't cover edge cases**
Only a single small BVR1 file is used in Playwright tests. No coverage of: BVR3 files, boards with no outline, single-pin parts, very large boards, invalid files, or multi-tab scenarios.

**31. No unit tests for parsers or rendering helpers**
`bvr1-parser.ts`, `bvr3-parser.ts`, and `render-settings.ts` helpers are pure functions and straightforward to unit-test, but no tests exist.
