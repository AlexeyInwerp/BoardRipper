# Colour schemes review (2026-10-11)

Five built-in schemes ship today: BoardRipper Default, Landrex Classic, Drafting Paper, Daylight, Blueprint. Only Landrex reads cleanly, and it gets there by switching colour off. The three light schemes are made unusable by one default setting, and every scheme shares about forty colours that were tuned for none of them.

**Root cause:** a theme owns ten colours (backgrounds, outline, three label colours, selection). The colours that dominate the picture — pins, part bodies, copper layers, the dim veil — are global settings or renderer constants and never change with the theme.

## Method

- Boards: 820-2347 K50 (XZZ, MacBook), iPhone 16 AP+BB (XZZ, dense), tomu-fpga (KiCad, traces and pours), LA-P161PR1B (Allegro, 39 k traces).
- Every scheme on every board: fit view, a view zoomed onto the densest IC, the same with that IC selected, and the overview and zoom again with the dim off. Harness: `src/frontend/tests/theme-review-shots.spec.ts` (needs the local samples; writes to `test-results/theme-review/`).
- Contrast is WCAG contrast after blending the way the renderer does: board fill at α 0.08 over the canvas, part bodies at α 0.55 over the board, dim at α 0.5.

## What a theme controls today

| Source | Colours | Changes with the theme? |
|---|---|---|
| `THEMES[*].board` | canvas, board fill, outline, selection, butterfly selection, pin-number / part / net label, net-label box + opacity | yes |
| Render settings | default pin top `#44cc44` / bottom `#cc4444`; 12 pin-group colours; 11 part-type fills (α 0.55); net-line `#ffff44` / adjacent `#4488ff`; dim overlay (black, α 0.5) | no (only Landrex overrides some) |
| Renderer constants | part bounds top green / bottom red, inferred amber, part-selected orange, pin-1 red, label shadow black, part-label box black α 0.75 | no |
| `DEFAULT_LAYER_PALETTE` | 15 copper-layer colours, red first, green second | no |

## Findings, most damaging first

### 1. Ambient dim lays black at 50 % over every scheme

`dimMode: 'dim'` and `ambientDim: true` are the defaults, so the board is always under a black 50 % rectangle and only the hovered net punches through. On the light schemes the paper becomes mid-grey: Daylight's board goes from `#e6e8ec` to `#737476`, Drafting Paper from `#ede9dd` to `#77746f`. Every colour on top loses half its contrast. On the dark scheme the board goes from `#19191c` to `#0d0d0e`, which hides the already-dark part bodies completely. With the dim off, Daylight on the iPhone board is close to usable. This one default is most of why the light schemes look broken.

### 2. Part-type fills are one dark palette for every scheme

| Type | Fill | Dark: body vs board | Dark: label on body | Light: body vs board | Light: label on body |
|---|---|---|---|---|---|
| Resistor | `#222222` | 1.1 | 10.4 | 3.5 | 1.8–2.3 |
| IC | `#5a2090` | 1.3 | 8.6 | 2.9 | 2.1–2.7 |
| Shield | `#3a3a3a` | 1.2 | 8.8 | 2.9 | 2.2–2.7 |
| Connector | `#2a5080` | 1.5 | 7.5 | 2.5 | 2.5–3.1 |
| Diode | `#2255aa` | 1.6 | 7.0 | 2.4 | 2.6–3.3 |
| Transistor | `#0d6b55` | 1.6 | 6.6 | 2.3 | 2.7–3.4 |
| Capacitor | `#9a5a35` | 1.8 | 6.0 | 2.1 | 2.9–3.7 |
| Inductor | `#7a7a7a` | 2.1 | 5.1 | 1.9 | 3.3–4.2 |
| Test point | `#4a9060` | 2.3 | 4.8 | 1.8 | 3.5–4.4 |
| Crystal | `#e2ee00` | 4.9 | **2.2** | 1.0 | 6.0–7.5 |
| Fuse | `#efefef` | 5.4 | **2.0** | 1.0 | 6.4–8.1 |

On the dark scheme nine of eleven bodies are within 1.1–2.1 of the board, so part types cannot be told apart by colour at all; the two that do stand out (yellow crystal, white fuse) are the ones whose labels fail. On the light schemes the same fills turn into dark blocks and the scheme's dark part labels sit on them at 1.8–3.7.

### 3. A large part paints a large block

Fill opacity is the same for an 0402 and a connector the size of a third of the board. On K50, J8400's fill covers a third of the view in navy; on the light schemes that third of the paper turns dark blue and everything inside it (U1400 included) loses its labels. On tomu, U9's pads fill most of the screen in solid green at deep zoom.

### 4. Pin colours are not theme-aware and collide in meaning

- Top-side green `#44cc44` is 1.7:1 on every light scheme.
- Red means two things: bottom side (`#cc4444`) and power (`#dd3333`). They are almost the same colour.
- Ground `#666666`, the most frequent pin on any BGA, is 3.1:1 on the dark board and nearly the same as NC `#555555`.
- On a dense BGA the field is green (signals), red/orange (power/PP) and grey (ground) — the green majority carries no information and is the loudest colour on screen.

### 5. The copper-layer palette reuses the same red and green

Layer 0 is red, layer 1 is green. On the Allegro board the screen is red and green traces at full strength: they read as "power" and "side", and they bury the parts. The palette is a constant and does not follow the scheme.

### 6. Light-scheme selection is too faint

The amber selection is 1.8:1 (Drafting Paper) and 2.2:1 (Daylight, Blueprint) against the paper.

### 7. Three light schemes are near duplicates

Drafting Paper, Daylight and Blueprint differ by a few percent of canvas lightness and a label tint. They share findings 1–6 exactly.

### 8. Interface accents (minor)

Accent text is shaded automatically on light backgrounds, so the presets mostly work. Atari rainbow blue `#2a3192` is 1.9:1 on the dark interface. The Atari presets are brand history rather than a palette chosen for use; low priority.

### What works

- Dark scheme labels: pin numbers 17.5:1, part names 10.9:1, net names 10.1:1.
- Landrex: consistent and readable, because nothing competes.
- Daylight with the dim off, on the iPhone board.

## Proposal

**A. A scheme owns the whole picture.** Replace the ten slots with roles: surface (canvas, board), ink (three label levels), body tint per part type, pin semantics (signal, power, rail, ground, NC, data, logic), side cue, selection / highlight / net lines, dim colour, copper layers, and the current renderer constants. Global settings become user overrides on top of the scheme instead of the source of these colours.

**B. Derive, don't list.** Each role is a hue plus a lightness rule per scheme: on dark, pale tints at low opacity; on light, darker strokes with pale fills. A new scheme is then a short table, and part and pin colours stay legible on it by construction.

**C. One meaning per hue.** Side is not shown as red/green (tone, outline or a muted pair instead); power stays warm; ground is neutral but visible (≥ 3:1) and clearly apart from NC; data and logic take cool hues. Plain signal pins get the quietest colour, not the loudest. Copper layers default to tints that avoid the pin-semantic hues.

**D. Dim toward the canvas, not black.** The dim colour is the scheme's canvas colour.

**E. Fill fades with size.** Body opacity falls with on-screen area; above a size a body is an outline with a light tint.

**F. Ship three new schemes.** Dark, Light, Monochrome next to the unchanged BoardRipper Default (see Decisions). Daylight and Blueprint are retired or kept only as accent variants; Custom stays.

**G. Guard it with tests.** A unit test per scheme: labels ≥ 4.5:1 on the board and on every part body, pins ≥ 3:1 on the board, selection ≥ 3:1, semantic pin colours pairwise distinct. Keep the screenshot harness for visual review of every change.

## Decisions (2026-10-11)

1. **Dim:** switching the scheme turns the dim off. The dim itself fades toward the canvas colour and only appears with a selection.
2. **Sides:** top and underside get their own colour codes, so red means power only. The underside's plain signal and ground pins take their own colours (violet-grey on Dark and Light, woodgrain brown on Atari, darker grey on Monochrome); in the two-sided view the underside sits behind, faded, with dashed body edges.
3. **Light schemes:** two. One plain Light, and one **Atari (light)**: 2600 silver-label paper and black ink, the rainbow as part tints and pin roles (red power, orange rails, blue data, green logic), Atari yellow as the selection highlighter; connectors stay silver because a large red block would read as power.
4. **Custom colours:** a user's custom scheme and saved overrides are kept as they are.
5. **BoardRipper Default stays exactly as it is** and stays the default: many users are used to it. The proposed Dark is added next to it, not in its place. Nothing in the rework changes how Default draws: its pin, part and layer colours and its black ambient dim are kept, apart from the dim turning off on a scheme switch.

Shipping set: BoardRipper Default (unchanged, still the default), Dark, Light, Atari (light), Monochrome, plus Custom. All four proposed schemes pass the 26 contrast checks in the mockup (`claude.ai/artifact/9SzQM5xQaWsoEab6CPNgPX`); today's Drafting Paper passes 10, Default 23.
