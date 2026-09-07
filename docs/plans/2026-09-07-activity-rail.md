# Activity Rail Implementation Plan

> **Status 2026-09-07:** Tasks 1–8 done on `feat/activity-rail`. **Revised after first hands-on review on :1234:** (1) the toolbar `≡` is back as an *area* toggle — hides panel and rail together ("nothing but the board"), with the edge arrow returning only in that state; a bottom hide chevron on the rail was tried and removed the same day (it doubled the click-active-icon gesture) — instead the status bar got its own small foot-of-rail toggle and `≡` hides it along with panel + rail; (2) Library and Settings tab strips unified on one `icon-tab` cell (icon pinned, caption under the open tab only). Deviations from the plan as written: the debug-badge watermark lives in `hooks/useRailBadges.ts` rather than `Sidebar.utils.ts` (it is badge-private state, not sidebar state); the E2E scroll assertion discovers the scroller empirically via `scrollIntoView` because neither Settings nor the Debug log exposes an `overflow:auto` element that the finder could match at the test viewport; the lite-build check is covered by the existing `web-lite.spec.ts` under `playwright.lite.config.ts` rather than a new case. Four failures in the migrated specs (`library-persistent-state:105`, `overlay-customizer:27`, `themes-smoke:78`, `themes-smoke:101`) are pre-existing on `main` without a backend running, verified by stashing this branch's changes.

**Goal:** Replace the sidebar's horizontal text tab strip with a 46px always-visible icon rail, delete the three redundant collapse affordances it makes obsolete, and give hidden destinations badges — without adding any new sidebar state.

**Architecture:** A new `ActivityRail` component that reads the existing module state in `Sidebar.utils.ts` (`activeTab`, `collapsed`, `side`, `width`) through the exports that already exist. The sidebar keeps mounting all panels at all times, so hiding and showing costs nothing and loses nothing. A single persisted preference (`rail`, default on) switches between the rail and the legacy strip so both can be compared on real boards before the strip is deleted.

**Tech Stack:** React 19, TypeScript strict, `@tabler/icons-react` 3.40, Playwright (E2E).

**Spec:** `docs/specs/2026-09-02-activity-rail-design.md`. Verified mockup: `docs/specs/2026-09-02-activity-rail-mockup.html`. Read both before starting.

## Global Constraints

- **No new sidebar state.** The rail is a second view over `Sidebar.utils.ts`. Anything that needs to know "which tab / is it open / which side" reads those exports; nothing duplicates them.
- **`showSidebarTab`, `toggleSidebar`, `toggleLibrarySidebar`, `flipSidebarSide` keep their signatures and semantics.** Toolbar, keyboard shortcuts, the update badge, Library deep links and `settings-focus-section` all call them today and must not notice the change.
- **Panels stay mounted.** `Sidebar.tsx` already keeps Library / Tools / Settings / Debug mounted with `display:none` toggling so React state survives tab switches. Hiding the sidebar must not unmount anything either.
- **`BoardSidebar` is out of scope.** Do not touch `components/BoardSidebar*.ts*`.
- **Lite build:** there is no Library. `TABS` in `Sidebar.utils.ts` already filters it out; the rail derives from `TABS`, never from its own list.
- **Logging:** scoped loggers only (`log.ui.*`). None in render paths.
- **Icons:** Tabler, from the package already installed. No new icon assets.
- **Tests locate tabs by `data-sidebar-tab`**, never by class or visible text, so the same specs pass against the rail and the legacy strip.

---

## Show / hide model

This is the part that had to be settled before writing code. The sidebar has exactly two states, **open** and **hidden**. The rail is always visible. `activeTab` is always defined, even while hidden — it is the destination you return to.

### Transitions

| Trigger | From | Result |
|---|---|---|
| Click a rail item that is not active | either | open, `activeTab` = that item |
| Click the active rail item | open | hidden |
| Click the active rail item | hidden | open, same panel |
| `showSidebarTab(t)` — toolbar update badge → Debug, Library deep links, OBD, `settings-focus-section` | either | open, `activeTab` = `t` (unchanged behaviour) |
| Keyboard `toggleLibrary` | either | unchanged: hidden → open Library; open on another tab → switch to Library; open on Library → hidden |
| Rail context menu ▸ Hide sidebar | open | hidden |
| `toggleSidebar()` (kept for callers) | either | flips |
| Drag the width below `MIN_WIDTH` | open | clamped at 200px, **not** a hide. Dragging to hide is easy to do by accident; hiding stays a click |

### What "hidden" means for the content

The `.sidebar` container gets `display:none`, exactly as today when collapsed. Every panel inside stays mounted. So on return you get precisely what you left: the same tab, the Library's expanded folders and search text, the Tools drill-down you were in, Settings' active sub-tab, the Debug filter. Scroll offsets survive too — Chromium, Firefox and WebKit keep an element's scroll offset across a `display:none` round-trip — but the E2E test asserts it rather than assuming it. If a browser ever loses it, the fallback is `width:0; overflow:hidden; visibility:hidden`, which keeps the layout box.

A hidden destination that gains a badge does **not** open itself. Nothing may take canvas width away from the user; the badge waits on the rail.

### Persistence

Today only `side` and `width` survive a reload; `collapsed` resets to open and `activeTab` to Library. With a rail this is wrong — VS Code persists both, and a user who hid the sidebar to get canvas width should not get it back on every reload. So:

| Key | Persisted today | After |
|---|---|---|
| `boardripper-sidebar-side` | yes | yes |
| `boardripper-sidebar-width` | yes | yes |
| `boardripper-sidebar-collapsed` | no | **yes** |
| `boardripper-sidebar-tab` | no | **yes** (lite build maps `library` → `settings`) |
| `boardripper-sidebar-rail` | — | **yes**, default `true` |

Absent keys produce today's behaviour (open, Library), so nobody's first load changes.

### Canvas cost

Opening or hiding changes the dockview width, which resizes the WebGL canvas and re-culls once. That is fine as a discrete event. It is why there is **no slide animation**: animating the width would resize the renderer every frame for the length of the transition.

### Discoverability of "hide"

With the strip gone, hiding has three routes: click the active rail item, the rail's right-click menu, the keyboard shortcut. The hover label carries the hint in both directions — the open item reads "Library · click to hide", and while hidden the muted active item reads "Library · click to show".

### Phase 2, deliberately not in this branch: peek

Hover a rail item while the sidebar is hidden and, after ~250ms, the panel slides out as an **overlay** over the canvas; it retracts when the pointer leaves, and a pin button in its header converts it to open. This is what JetBrains calls a floating tool window. It has a real advantage here beyond convenience: an overlay does not change the dockview width, so there is no WebGL resize at all. Decide after living with phase 1 for a while; it needs a hover-intent timer and an outside-click rule that the plain model doesn't.

---

### Task 1: Persist collapsed + tab, add the `rail` preference

**Files:** modify `src/frontend/src/components/Sidebar.utils.ts`

- [ ] Add `SIDEBAR_COLLAPSED_KEY`, `SIDEBAR_TAB_KEY`, `SIDEBAR_RAIL_KEY` with `load*/save*` helpers in the same try/catch style as `loadSide`.
- [ ] Initialise `state.collapsed` and `state.activeTab` from storage; `activeTab` goes through the existing lite-build mapping. Add `state.rail` (default `true`).
- [ ] Persist in `toggleSidebar`, `showSidebarTab`, `setActiveTabRaw` callers (route through one `setActiveTab` that saves), and a new `setSidebarRail(v)`.
- [ ] Export `getSidebarRail()`, `setSidebarRail()`, `SIDEBAR_GROUPS: { top: SidebarTab[]; bottom: SidebarTab[] }` = `{ top: ['library','tools'], bottom: ['debug','settings'] }` filtered through `TABS`.
- [ ] Extend the DEV `window.__sidebar` hook with `show(tab)`, `hide()`, `rail()`, `setRail(v)`.

### Task 2: Make the existing tests layout-agnostic (before the rail exists)

**Files:** modify `components/Sidebar.tsx`; modify tests `mcp-pairing`, `overlay-customizer`, `library-persistent-state`, `themes-smoke`, `web-lite`, `library-browse-filter`

- [ ] Add `data-sidebar-tab={tab.id}` to the legacy strip buttons.
- [ ] Replace every `page.locator('.sidebar-tab', { hasText: 'X' })` with `page.locator('[data-sidebar-tab="x"]')` (nine sites). `web-lite.spec.ts:71` becomes `[data-sidebar-tab="library"]` count 0.
- [ ] Run those six specs. They must be green with the rail still absent.

### Task 3: `ActivityRail` component + CSS

**Files:** create `src/frontend/src/components/ActivityRail.tsx`; modify `src/frontend/src/index.css` (new block directly after the `.sidebar-toggle-right` rule)

- [ ] Render `SIDEBAR_GROUPS.top`, a spacer, `SIDEBAR_GROUPS.bottom`. Each item: `role="tab"`, `data-sidebar-tab`, `aria-selected`, icon (`IconBooks`, `IconCalculator`, `IconBug`, `IconSettings`, size 20, stroke 1.75) inside a positioned `.rail-ico` box, 8px caption.
- [ ] Click: active + open → `toggleSidebar()`; otherwise `showSidebarTab(id)`.
- [ ] Indicator: 2px accent bar on the inner edge (`left` for side=left, `right` for side=right); grey at 50% while hidden.
- [ ] Hover label after 350ms via `::after` + `data-title`; text variants for open-active / hidden-active per the model above. Flip to the other side of the rail when `side === 'right'`.
- [ ] Roving tabindex: `↑ ↓ Home End` on the `role="tablist"`.
- [ ] Right-click menu — a small local popover (not `contextMenuStore`, which is board/PDF-specific): Move rail to left/right, Show captions, Hide sidebar. Escape and outside-pointerdown close it. Captions preference: `boardripper-sidebar-captions`, default on, lives in `Sidebar.utils.ts`.
- [ ] Subscribe with `onSidebarChange` + `forceUpdate`, the way `Sidebar.tsx` does.
- [ ] CSS uses only existing tokens. Rail bg `--bg-tertiary`, border `--border`, active `--accent`, badge ring `--bg-tertiary`.

### Task 4: Badges

**Files:** create `src/frontend/src/hooks/useRailBadges.ts`

- [ ] `settings`: `updateStore` `has_update` → blue dot; `important` → red dot. Use the same hook the toolbar `UpdateBadge` uses.
- [ ] `debug`: count of `error`-level entries in `logStore.getSnapshot()` with `id` greater than the last id seen while the Debug tab was open. Store `lastSeenErrorId` in `Sidebar.utils.ts`; update it whenever `activeTab === 'debug' && !collapsed`. Amber count, capped at "9+".
- [ ] `library`: `useLibrarySync().status` — `phase === 'error'` or `errors > 0` → red dot. Nothing when sync is not configured.
- [ ] Badges never call `showSidebarTab`.

### Task 5: Integrate, gated on the preference

**Files:** modify `App.tsx`, `components/Sidebar.tsx`, `components/Toolbar.tsx`

- [ ] `App.tsx`: mount `<ActivityRail />` inside `.dockview-wrapper` when `getSidebarRail()`; flex `order` −1 (left) / 3 (right) so the existing sidebar/dockview orders stay untouched. Do not render the collapsed floating arrow when the rail is on.
- [ ] `Sidebar.tsx`: skip the `.sidebar-tabs` row when the rail is on. Everything else unchanged.
- [ ] `Toolbar.tsx`: hide the `≡` button when the rail is on. `toggleSidebar` import stays for the legacy mode.

### Task 6: Settings switch

**Files:** modify `panels/SettingsPanel.tsx` (Theme tab, next to "Interface scale")

- [ ] A row "Sidebar navigation" with a two-way segmented control: **Icon rail** / **Text tabs**, bound to `getSidebarRail` / `setSidebarRail`. Include it in the settings search index under the existing section id used by Interface scale.

### Task 7: E2E

**Files:** create `src/frontend/tests/activity-rail.spec.ts`

- [ ] Rail renders four items in the default build; Library absent under the lite config.
- [ ] Clicking Tools opens Tools; clicking Tools again hides the sidebar and the rail remains; clicking Tools once more reopens Tools.
- [ ] State survives hide/show: open Library ▸ Folders, expand a folder, scroll the list, hide, show — same folder open, same `scrollTop`.
- [ ] Hidden + tab persist across `page.reload()`.
- [ ] Right-click ▸ Move rail to right puts the rail after the dockview container.
- [ ] `log.ui.error(...)` from `page.evaluate` produces a Debug badge of 1; opening Debug clears it.
- [ ] Switching the setting to Text tabs restores the strip, the `≡`, and the floating arrow; the six migrated specs still pass in both modes (run them once with `localStorage['boardripper-sidebar-rail']='false'` via `addInitScript`).

### Task 8: Docs

- [ ] `CLAUDE.md` ▸ Key Architectural Decisions: one bullet for the rail — the no-new-state rule, the persistence keys, the `data-sidebar-tab` test contract, phase 2 peek deferred.
- [ ] Spec status → implemented on branch; link this plan.
