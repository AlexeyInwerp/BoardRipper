# View & renderer settings — review

**Date:** 2026-09-15 · **Scope:** the board-view and renderer keys of
`RenderSettings` (`store/render-settings.ts`), the Settings tabs that expose
them (`panels/SettingsPanel.tsx`), Interactive mode (`store/resize-mode-store.ts`)
and how changed defaults reach existing installs. Input, PDF, library and
integration settings are out of scope.

Method: every key in the interface was traced to (a) the code that reads it
outside the settings UI, (b) its Settings control, (c) its Interactive-mode
control. 103 keys in the interface; 74 are view/renderer.

## Headline numbers

| | |
|---|---|
| View/renderer keys | 74 |
| Read by nothing, or by a deprecated path only | 4 |
| Read by the classic (BitmapText) text path only — no effect with Text fast mode on, which has been the default since July | 7 |
| Have no Settings control at all | 8 |
| Have a Settings control but no Interactive control, where Interactive would be the natural place | 14 |
| Have an Interactive control but no Settings control | 5 |
| Concepts served by two or more knobs | 5 |
| Sections on the wrong tab | 1 (Zoom Level of Detail is on the **Input** tab) |
| Sections without a mockup | 4 of 9 |

Changed defaults reach an existing install only through hand-written marker
keys (three so far: wheel detection, fast-mode graduation, pin-label floor).
There is no version, so a user who skips releases gets exactly the migrations
whose markers happen to be checked on that boot — today all three are, but
each new bump adds another `localStorage` key and another `if`.

## Findings

### 1. Dead or deprecated

| Key | State | Do |
|---|---|---|
| `netColorRules` | `@deprecated`, migrated to `pinGroups`; read only by the migration | Drop from the interface; keep the one-time `migrateToPinGroups` on load |
| `ncNetPatterns` | `@deprecated` in the doc, **still read** by `BoardSidebar` and `FilterDropdown` for the NC filter | Either finish the fold into the outline-only pin group and delete, or un-deprecate. Today the doc lies. |
| `twoPinLabelGapFactor` | one read, no control, default 0.6 never changed | Constant in `board-scene.ts` |
| `showSelectionHalo` | no control; nothing sets it false (the Landrex theme it was made for sets four other keys, not this one) | Delete, or give it the toggle it was written for |

### 2. Classic-text-path only — silent no-ops for almost everyone

Text fast mode (Canvas2D overlay) is default-on since 2026-07-19, yet its
toggle still says *(experimental)* and seven controls that only the BitmapText
path reads stay in the main sections, where changing them does nothing:

`labelAtlasResolution` (Performance), `partLabelShadow` and `pinLabelShadow`
(Parts — the overlay draws no shadows), `hideTextDuringZoom` (Performance —
toggles Pixi label layers the overlay does not use), `showElevatedPartLabel`
and `showElevatedPinLabel` (Selection — the classic floating clones),
`labelMinSize` partly (it floors the BitmapText size; the overlay honours the
record but part labels are fit to the body, so it "barely moves them", as its
own doc says).

Do: graduate the toggle — *Text rendering: Overlay / Classic* — and move these
seven into a **Classic text** block that only renders while Classic is chosen.
If the classic path is retired, they go with it.

### 3. Hidden — no Settings control

`showSelectionOverlay` (the big selection banner; default on, no way off),
`searchAutoDim`, `showSelectionHalo`, `twoPinLabelGapFactor`,
`overlayPartsOnSelect` / `overlayNetsOnSelect` (set from the ribbon dropdown
menus — fine), `overlayLayout`/`overlayPosition`/… (the overlay editor — fine),
`selectedLabelLodRelax` (Interactive only), `pinSizeScale`, `pinNumberScale`,
`netLabelScale`, `diodeValueScale`, `partLabelScale` (Interactive only).

The five Interactive-only multipliers are the ones a user will look for in
Settings after changing them by click and not finding a slider to put them
back — the *Reset to Defaults* button is the only way. Do: mirror them in Pins
/ Components. `showSelectionOverlay` and `searchAutoDim` get a toggle under
Selection or become constants; there is no third option.

### 4. Duplicates — one concept, several knobs

- **Pin size, four knobs:** `pinMinRadius`, `pinMaxRadius` (clamps, mils),
  `pinScaleFactor` (interpolates the file radius toward the minimum; default 1
  = off; no one has a mental model for it), `pinSizeScale` (Interactive's
  multiplier, applied after the clamp). Keep the clamps as *advanced* and
  `pinSizeScale` as *the* size knob; delete `pinScaleFactor`.
- **Part-label size, three floors:** `labelMinSize` (mils, build-time),
  `labelHideThreshold` (mils, build-time cull), `labelMinScreenPx` (px,
  appear-floor) plus `partLabelScale` (multiplier). Keep the appear-floor and
  the multiplier; `labelHideThreshold` is a memory/perf guard and belongs
  under Performance as *advanced*; `labelMinSize` goes.
- **Selected-part label size:** `selectedLabelMinPx`, `selectedLabelLodRelax`,
  `selectedLabelOtherScale` — three knobs for what the label review
  (`2026-09-14-label-sizing-review.md`) reduces to one `focusLabelPx` once the
  focus-pin rule lands. The fit-to-pitch cap already made the size floor
  mostly moot.
- **Selection outline:** `selectionWidth`, `selectionMinScreenPx`,
  `selectionPadding`, `selectionFillAlpha` + the net-member ring
  `netHighlightGrow`/`netHighlightAlpha`. `selectionPadding` (default 0,
  "only ever adds") is the one nobody needs now that the outline is dynamic;
  drop it. The other five are distinct and stay.
- **Dimming:** `ambientDim` (Settings toggle) and the ribbon's spotlight
  tri-state `dimMode` in `board-store` are two switches on one behaviour, with
  `dimOverlayAlpha` and `searchAutoDim` as modifiers. Keep the ribbon as the
  control; Settings keeps only the strength slider and *ambient* as an
  advanced toggle.

### 5. Placement

- **Zoom Level of Detail is on the Input tab** (`SECTION_TO_TAB.zoomLod:
  'input'`). Every slider in it is a renderer setting. Move to Board.
- **`hierarchyDepth` sits in *Part properties*** — it is the net-line
  propagation depth. Move to Net Lines.
- **`boardFillAlpha` is under *Board Outline*** while *Board overlay* is the
  ribbon editor; the two section names collide. Rename *Board Outline* →
  *Board*.
- **`clickThreshold` ("Pin Click Radius") under Navigation** is fine (input),
  noted only because Interactive mode's pin popup would be the more natural
  home for a second copy.

### 6. Interactive mode — what is missing

Interactive mode is where a user changes sizes *by clicking the thing*; its
groups should carry everything that is about that thing's size, spacing and
visibility, and nothing about behaviour.

| Group | Has | Missing |
|---|---|---|
| Pin | size, number size, net-label size, diode size, ring size/opacity, selected-label ×3 | `pinNumberMinScreenPx` and `circleLabelMinScreenPx` (when labels appear), `labelFadeRange`, `labelFitToPitch`, `pinAlpha`, `pinNetLabelBg`, `bgaLabelGapFactor` |
| Component | label size, outline width, ring ×2, selected-label ×3 | `partBorderAlpha`, `componentFillAlpha`, `partPadding`, `labelMinScreenPx` (when names appear) |
| Board | fill opacity | `outlineWidth`, `outlineAlpha` |
| Net line | width, colour, opacity | `netLineDashed` + `netLineDashLength`, `adjacentNetLineColor`, `hierarchyDepth` |
| *(none)* | — | a **Selection** group when the click lands on the selected part: `selectionWidth`, `selectionMinScreenPx`, `selectionFillAlpha`, `dimOverlayAlpha` |

And the reverse asymmetry: the ring knobs (`netHighlightGrow/Alpha`) and the
three selected-label knobs are repeated in both the Pin and Component groups;
a Selection group is where they belong, once.

### 7. Mockups

`SettingsMockup` covers outline, parts, pins, netColors, selection. Zoom LoD,
Net Lines, Part properties and Board overlay have none. Zoom LoD is the one
that needs it most — its sliders are invisible until you zoom to the right
level — and the mockup could show the same part at three zooms.

## Proposed Board tab

```
Board           outline width · outline opacity · fill opacity · use metadata colour
Components      type colours + fill opacity · border width/opacity · padding
                labels on/off · label size (×) · hide mechanical fills
Pins            size (×) · fill opacity · numbers · net names · diode values
                pin-1 marker · label backgrounds · BGA label gap
                advanced: min/max radius
Labels & zoom   appear at ≥ px: part names · pin numbers · net names · 2-pin names
                fade-in · fit to pitch · pointed-at pin label px
                advanced: cull (mils) · global zoom floor
Selection       outline width · min size · fill · ring size/opacity · dim strength · HDR
                advanced: ambient dim · search auto-dim · selection banner
Net lines       width · opacity · colour · adjacent colour · dashed/length · pulse
                hierarchy depth
Pin colour rules / Part types / Board overlay   (unchanged)
Classic text    (only when Text rendering = Classic) atlas resolution · shadows ×2
                hide text during zoom · floating part/pin label
```

Keys removed: `netColorRules`, `twoPinLabelGapFactor`, `showSelectionHalo`,
`pinScaleFactor`, `labelMinSize`, `selectionPadding`, and — after the focus
label lands — `selectedLabelLodRelax`, `selectedLabelOtherScale`. Renamed:
`selectedLabelMinPx` → `focusLabelPx`. 74 → 64 keys; every remaining key has
a Settings control, and Interactive mode shows the size/visibility subset.

## Defaults patching — the mechanism

What exists: three ad-hoc `localStorage` markers, each guarding one `if`.
What is needed, before the consolidation above can ship: a version and an
ordered ladder, so that a user who skips five releases runs the five
migrations they missed, in order, once.

```ts
// render-settings.ts
const SETTINGS_VERSION = 4;
type Migration = (stored: Record<string, unknown>) => void;
const MIGRATIONS: Record<number, Migration> = {
  1: s => bumpDefault(s, 'wheelDetection', true, false),
  2: s => { s.textFastMode = true; },                         // graduation
  3: s => bumpDefault(s, 'circleLabelMinScreenPx', 3, 8),
  4: s => { rename(s, 'selectedLabelMinPx', 'focusLabelPx'); drop(s, 'pinScaleFactor', 'labelMinSize', …); },
};
function migrate(stored) {
  let v = Number(stored.settingsVersion ?? 0);
  // existing installs carry the three markers instead of a version:
  if (v === 0) v = inferFromMarkers();
  for (v++; v <= SETTINGS_VERSION; v++) MIGRATIONS[v]?.(stored);
  stored.settingsVersion = SETTINGS_VERSION;
}
```

Rules that keep it safe:

- **A default bump touches only an untouched value** — `bumpDefault` rewrites
  the key only when it still equals the *old* default. A user's own value is
  never moved. (This is what the pin-label bump does today; it becomes the
  rule for all of them.)
- **Renames and drops apply to per-board overrides too**
  (`boardripper-board-overrides`, one object per board); default bumps do not
  — an override is explicit by definition.
- **The version is written back only after the whole ladder ran**, so a crash
  mid-way re-runs from the same step next boot; every step is idempotent.
- **Each step has a unit test** on a fixture object: old shape in, new shape
  out, user-changed values untouched.
- The three marker keys are read once to seed the version for existing
  installs, then ignored; new bumps never add a marker.

`applyGlobal` already spreads `DEFAULTS` under the stored object, so a key
that is *added* needs no migration — only a changed default, a rename or a
drop does.

## Order of work

1. **Version ladder** (the mechanism) with the three existing bumps folded in
   and tests — small, and everything below depends on it.
2. **Deletions + placement fixes** (§1, §4 easy cases, §5) — one migration
   step, no visual change.
3. **Classic-text block + graduate the fast-mode toggle** (§2).
4. **Interactive groups** (§6) and the Settings mirrors of the five
   Interactive-only multipliers (§3).
5. **Focus label** from the label review, which retires the last two
   selected-label knobs (§4).
6. Zoom LoD mockup (§7), when convenient.

Steps 1–2 fit 0.41.1 together with the label work already on `main`; 3–5 are
0.42 material (they change what users see in Settings and deserve their own
changelog section).

## Compound control — decided 2026-09-16

The "show it / how big" pairs (pin numbers, net names, diode values, part
names, type colours + fill opacity, dashed + dash length, HDR outline +
intensity) merge into one row with one control, **`toggleSlider`**:

- **Thumb:** click = on/off, drag = size. Filled thumb = on, hollow ring =
  off; a soft halo on hover is the only "this clicks" cue. No icon.
- **Row name:** click = on/off (checkbox-label behaviour); **greyed when off**.
  No marker before the name.
- **Track:** click or drag = size, as any slider. **Number:** reads, never
  toggles; greyed when off.
- Off = name muted, number muted, track empty, thumb hollow. The value is kept
  while off; on brings it back unchanged.
- Keyboard: the name is a button (Space); the slider takes ← → Home End and
  Space. Two Tab stops per row. Tap-vs-drag on the thumb uses the usual 4 px
  threshold.
- Schema: `{ control: 'toggleSlider', onKey, key, min, max, step, unit }` —
  the two keys the settings already have; no migration, only the rows merge.

Explored and stashed (mockup `https://claude.ai/code/artifact/0a70da53-7f85-43df-986e-46e076d3a5a8`,
folded section): switch beside slider, left-end-is-off with a socket, the
thumb-plus-socket hybrid, a power cap in the track, a readout that toggles, a
ring before the name. Rejected for good: any word on the track ("OFF"), any
icon on the thumb, double-click toggles (fight double-click-to-reset), and
toggling on a click of the empty track.
