# Activity rail for the sidebar — VS Code-style icon rail

**Date:** 2026-09-02 · **Status:** shipped in **v0.38.0** (2026-09-07). Plan: `docs/plans/2026-09-07-activity-rail.md`; E2E `src/frontend/tests/activity-rail.spec.ts` (22 passing). Rail is default on; the legacy strip stays one setting away. Phase 2 (hover-peek, BoardSidebar rail) not started.
**Problem owner:** anyone switching between Library / Tools / Settings / Debug during a repair session, and anyone who has lost the collapsed sidebar.

## Problem

The interface has four separate "which thing am I looking at" mechanisms stacked on top of each other:

| Level | Where | Destinations |
|---|---|---|
| Dockview tabs | centre | board / PDF / Database Editor / Worklist |
| App sidebar strip | `components/Sidebar.tsx` (the `.sidebar-tabs` row) | Library · Tools · Settings · Debug |
| Board sidebar strip | `components/BoardSidebar.tsx` | layers · info · search · revisions · worklist |
| Panel-internal strips | `LibraryPanel` `library-tabs`, `SettingsPanel` icon tabs, `ToolsPanel` drill-down | folders / model / PDF, theme / board / input …, calculators |

On a normal session the user is three tab strips deep before reaching content. That layering, not the absence of an icon rail, is the actual defect. An activity rail is a good vehicle for removing one level; copied without removing a level it would just be a fifth strip.

Specific symptoms in the current sidebar:

- **Collapse state is invisible and has three triggers.** The toolbar `≡` (`Toolbar.tsx`), the 16px floating arrow that exists only *while* collapsed (`App.tsx`), and the `◀`/`▶` buttons inside the strip. None shows what is behind it.
- **No badges.** State the app already tracks (update available in `updateStore`, librarysync errors, the log store's error count, OBD fetch state) reaches the user only if they are already looking in the right place.
- **The in-panel strips fight the sidebar strip for the same 32px band**, so Library's own `library-tabs` row is level three.
- **Destination taxonomy is inconsistent.** Worklist and Database Editor are centre panels reached by drilling into a *sidebar* tab (`ToolsPanel.tsx`, Workbench group).
- **`BoardSidebar` is a second, complete sidebar system** (own tab strip, own resize handle, own width persistence, ~1160 lines) overlaying the board's right edge.

The sidebar lives outside Dockview, so unlike every other panel it cannot be dragged, floated, or popped out. VS Code has the identical limitation; it is defensible, but a rail makes the sidebar look more like a first-class panel container and may raise that expectation.

## Proposal

Replace the sidebar's horizontal text tab strip with a **46px vertical activity rail** that is always visible, and delete the three collapse affordances it makes redundant.

**Rail contents and grouping**

- **Top group — where you work:** Library, Tools.
- **Bottom group — where you check and configure:** Debug, Settings.
- The empty run between the groups is deliberate. It is where `BoardSidebar`'s tabs would land if a later step folds them in.

**Gesture.** Click a destination to switch; click the *active* destination to collapse. That single rule replaces the toolbar `≡`, the floating arrow, and the in-strip `◀`/`▶`. While collapsed the rail stays put; the active item's indicator bar goes grey and its hover label reads "Library · click to show".

**Badges** anchored to the icon (bottom-right, VS Code convention, ringed in the rail colour so they read as sitting on the icon rather than behind it):

| Destination | Badge | Source (already exists) |
|---|---|---|
| Library | red dot | librarysync error surfaced in the UI |
| Debug | amber count | log store error count |
| Settings | blue dot | `updateStore` update-available |

The toolbar version chip **stays**. It names the build, which is not a destination. Only the update-available *signal* moves to the rail.

**Captions.** Each icon carries an 8px caption (Library / Tools / Debug / Settings). Icon-only is 4px shorter per item and looks tighter; captions are the discoverability net for intermittent users. Recommendation: keep captions until the rail is muscle memory. A 350ms-delayed hover label shows the name in either mode.

**Side flip.** Already implemented (`getSideRaw`, `flipSidebarSide` in `Sidebar.utils.ts`). Rail and sidebar both read `side`; the active-indicator bar swaps edges with them. The flip control, which was a nameless icon on the strip the rail deletes, moves to a **right-click context menu on the rail** alongside Show captions / Show badges / Hide sidebar.

**Keyboard.** Roving tabindex along the rail (`↑` `↓` `Home` `End`), `role="tablist"` / `role="tab"`, visible focus ring.

**Resize.** Unchanged: the sidebar's inner edge drags, clamped to `MIN_WIDTH` 200px … 50% of the window. A width readout appears on the handle only while dragging. Dragging below the minimum clamps; it never hides.

## Show / hide model

The sidebar has two states, **open** and **hidden**; the rail is always visible; `activeTab` is always defined and is the destination you return to.

- **Show:** click any rail item (switches and opens), or any existing `showSidebarTab()` caller (toolbar update badge → Debug, Library deep links, `settings-focus-section`), or the `toggleLibrary` keyboard shortcut.
- **Hide (panel):** click the active rail item, the rail's right-click menu, or the keyboard shortcut. Dragging the width down clamps at 200px rather than hiding — hiding is easy to do by accident with a drag, so it stays a click.
- **Status bar:** its **own toggle at the very foot of the rail, in the status bar's own row** — the rail spans the bar's height and the cell is exactly the bar's height and border, so the control sits where the thing is (window-with-bottom-bar glyph, lit while the bar shows), persisted separately. The status bar is diagnostics more than workspace. That preference is honoured only in the rail layout — the legacy strip has nothing to un-hide it with, so it always shows the bar. There is deliberately **no separate "hide panel" button** on the rail: it would double the click-the-active-icon gesture (a bottom Hide chevron was tried on 2026-09-07 and removed the same day for exactly that reason).
- **The toolbar sidebar button cycles** open → icons only → completely hidden → open (revised 2026-09-07, fourth pass; it was a two-state ≡ before). Its glyph is the sidebar-collapse icon, flipping to "expand" when the next click brings things back. The last stage is "nothing but the board": panel, rail *and* status bar, the status bar folded in without touching the foot toggle's own preference. The floating edge arrow returns only in that stage and jumps straight back to open (same cycle function), as does any deep link (`showSidebarTab`). Persisted separately (`boardripper-sidebar-rail-hidden`).
- **Auto-hide** (rail right-click menu, off by default): the panel opens as an **overlay** over the board instead of pushing it, and any click into the board area hides it again. Overlay is what makes auto-hide bearable — a pushing panel would resize the WebGL canvas on every open and close. Clicks on the toolbar, dialogs, toasts and the rail's own menu do not hide it. Always boots hidden. This is the click-to-open half of the phase-2 "peek" idea; hover-to-peek remains deferred.
- **Panel-internal strips are one design.** Library and Settings tab strips share the `icon-tab` cell: fixed-width cells with the icon pinned, and only the open tab's name drawn centred underneath so icons never move when you switch (revised 2026-09-07; before, Settings showed the open tab's label beside its icon and pushed the others along).
- **Content while hidden:** the container gets `display:none` as today; every panel stays mounted. On return you get exactly what you left — same tab, Library's expanded folders and search text, the Tools drill-down, Settings' sub-tab, and the scroll offsets. The E2E test asserts the scroll offsets rather than trusting the browser.
- **Badges never open the sidebar.** Nothing takes canvas width away from the user; a badge waits on the rail.
- **Persistence:** `collapsed` and `activeTab` become persisted alongside the existing `side` and `width` (they reset on reload today, which is wrong once hiding is a first-class state). Absent keys produce today's behaviour, so nobody's first load changes.
- **No slide animation.** Opening or hiding changes the dockview width, which resizes the WebGL canvas and re-culls once; animating the width would do that every frame.
- **Phase 2, deferred:** *peek* — hover a rail item while hidden and the panel overlays the canvas after ~250ms, retracting on pointer-leave, with a pin button to convert to open. An overlay causes no WebGL resize at all, which is a real advantage here. Decide after living with the plain model.

## What the proposal does not touch

- **`BoardSidebar`.** A secondary rail for its five board-local tabs is the obvious sequel and is deliberately not part of this step.
- **2-window mode.** It is a layout control sitting in the toolbar's Files group next to Upload. If the rail becomes the layout surface, that button has a better home, but moving it is a separate decision.
- **Dockview** and the centre panels.
- **`board-store.ts`, `render-settings.ts`, any parser or renderer code.**

## Implementation sketch

The rail needs **no new state**. It reads the same module state in `Sidebar.utils.ts` (`activeTab`, `collapsed`, `side`) through exports that already exist: `showSidebarTab`, `toggleSidebar`, `flipSidebarSide`, `getSideRaw`, `onSidebarChange`.

Files that would change:

- `components/ActivityRail.tsx` — new. Reads `Sidebar.utils.ts`, renders four `role="tab"` buttons with Tabler icons (`IconBooks`, `IconCalculator`, `IconBug`, `IconSettings`), badges bound to `updateStore` / librarysync / log store.
- `components/Sidebar.tsx` — drop the `.sidebar-tabs` row when the rail is enabled; keep the panel mounting and resize handle as they are.
- `App.tsx` — mount the rail as a sibling of `<Sidebar />` inside `.dockview-wrapper`, ordered by `side`; remove the collapsed floating arrow when the rail is enabled.
- `components/Toolbar.tsx` — hide the `≡` button when the rail is enabled.
- `index.css` — new `.activity-rail` block next to the existing sidebar rules (`index.css:800–909`).
- `store/render-settings.ts` (or `themeStore`) — one boolean `activityRail`, default **off** for the first release, so the two layouts can be A/B'd on real boards before the tab strip is deleted.

Suggested order, each step shippable on its own:

1. Collapse the three toggle affordances into one and make the current strip icon+label so the active destination is legible. Contained to `Sidebar.tsx`, `Sidebar.utils.ts`, ~40 lines of CSS. Worth doing regardless of the rail.
2. The rail proper behind the setting, with badges.
3. Fix the destination taxonomy: Worklist and Database Editor stop being reached through a sidebar tab. Rail = views, centre = documents.
4. Only then, revisit `BoardSidebar` as a secondary rail.

Related: `docs/specs/2026-07-22-tools-tab-design.md` (Tools is a rail destination).

## Mockup

`docs/specs/2026-09-02-activity-rail-mockup.html` — a self-contained interactive prototype, no build step, opens in any browser. It is drawn in the app's own chrome tokens copied from `src/frontend/src/index.css` (`--bg-primary #08080c`, `--bg-secondary #0f0f18`, `--bg-tertiary #0c1424`, accent `#4a9eff`, `--border #1a1a28`, 40px toolbar, 24px statusbar, `library-tab` strip styling), so it is a faithful preview rather than an approximation. The board canvas inside it is a placeholder.

Controls: Current ↔ With rail, Left / Right, Captions on / icons only, Badges on / off. Interactions: click a rail icon to switch, click the active one to collapse, right-click the rail for its menu, drag the sidebar's inner edge, `↑` `↓` along the rail. Hovering a row in the "What changes" list switches the mockup into the relevant state and pulses the element being described; clicking pins it.

Architecture note for whoever edits it: every layout variant is a `data-*` attribute on `#app` (`mode`, `side`, `collapsed`, `captions`, `badges`). CSS reads them, JS only writes them. The first draft mixed inline `style.display` with the attributes and drifted out of sync; do not reintroduce that.

A published copy also exists as a private artifact at <https://claude.ai/code/artifact/2f7f2a9a-506f-413b-8e89-767cd3569112> (owner: Alexey's claude.ai account). The file in this repo is the source of truth.

### Verification log

The mockup went through three review passes. Findings are recorded so the same defects are not re-introduced when the real component is built.

Pass 1 (code review of the first draft):

- `!important` inside `@keyframes` is ignored per spec, so the locate-pulse never animated.
- The hover preview switched layout on `mouseenter` and never restored it on `mouseleave`.
- Inline `style.display` juggling alongside `data-mode` produced two sources of truth.
- Current-layout mode did not mirror its action buttons to the far edge the way the real `Sidebar.tsx` does, and the `◀`/`▶` glyphs did not flip.
- Rail mode had no side-flip control at all after the strip was removed.
- The context menu was positioned against `#app` but lived inside `.body-row`, so it landed 40px low.

Pass 2 (Playwright screenshots at 2×, every state):

- The Debug count badge sat on top of the bug glyph. Cause: the badge was anchored to the 46px cell, not the icon. Fixed by wrapping the icon in a positioned box.
- The statusbar showed "sidebar 292px" — mockup instrumentation leaking into the app chrome, where it read as a shipped feature. Moved to a drag-time readout on the handle.
- Debug sat in the top group beside the two workspaces. Moved to the bottom group; this is the "work vs check-and-configure" split above.
- Diff-list tags floated mid-gutter; notes column ran ~80 characters per line.

Screenshots were produced with the project's own Playwright from `src/frontend/node_modules`; the harness is a ~30-line script that wraps the file in an HTML skeleton, clicks through the segmented controls, and captures `.stage`. Re-run it before changing the mockup's layout.

## Open questions

- Icons-only vs captions after the field-debug window. The mockup lets you compare; the recommendation is captions.
- Whether `BoardSidebar`'s five tabs become a secondary rail on the opposite edge, or stay board-local. Deliberately unanswered here.
- Where 2-window mode lives once the rail exists.
- A steady 46px of width on laptops where the canvas is the product. Defensible only because the rail deletes the `≡`, the floating arrow, and the 32px strip.

## Decision

Parked on 2026-09-02 after the mockup was reviewed and accepted as the right direction. Not scheduled. Pick up from step 1 of the implementation sketch.
