# Label sizing and selection — review

**Date:** 2026-09-14 · **Trigger:** "if the part is not selected it is close to
what I want; selected, the pin names are big and overlap. Review the adjustment
system."

Code: `renderer/board-scene.ts` (base sizes), `renderer/label-overlay.ts`
(Text fast mode draw + visibility), `renderer/BoardRenderer.ts`
`updateElevatedLabels` (classic BitmapText path), `store/render-settings.ts`
(knobs), `store/resize-mode-store.ts` (Interactive mode groups).

## What the system is today

Four layers stack on every pin label, each with its own unit and its own knobs.

**1. Base size — world units, fixed at scene build.** A pin number fits its
pin: `0.55 × diameter / (chars × 0.6)`, capped at `0.65 × diameter`; a net name
`0.85 × diameter / (chars × 0.6)`, floored at `netFloor`; both × the Interactive
multipliers `pinNumberScale` / `netLabelScale`, quantised. Because it is a
fraction of the *pin*, a base-size label can never be wider than its pin. This
is the layer that looks right unselected.

**2. Visibility floors — screen px, per kind.** A label is drawn once
`base × zoom ≥ floor`: `circleLabelMinScreenPx` (pin numbers + net names on
ICs; was 3, now 8), `twoPinLabelMinScreenPx` 6, `labelMinScreenPx` 3 (part
names), plus `labelZoomHide` (global zoom cutoff) and `labelHideThreshold`
(mils, a build-time cull that removes labels from the scene entirely). Five
knobs, three units (screen px, zoom factor, mils).

**3. Selection overrides — screen px, Text fast mode only.**
- `selectedLabelMinPx` (11): a **size** floor — every label of the selected
  part is drawn at least this big. This is the one that breaks layer 1: the
  label stops being a fraction of its pin and becomes a constant on-screen
  size regardless of pitch.
- `selectedLabelLodRelax` (0.75): the selected part's labels **appear
  earlier** — at 0.75 × the visibility floor.
- part name: always drawn (`keepAlways`).
- `selectedLabelOtherScale` (0.8, added today): the size floor for labels that
  are not the selected/hovered pin or the part name.

**4. Classic (BitmapText) path — a different model.** Selection there does
not touch the part's labels at all. It draws two *clones* on top: the part
name and the **selected pin's** label, at a constant **18 screen px** with a
backing plate. Nothing else grows. No hover.

## Why the selected part overlaps — arithmetic, not tuning

A 0.4 mm BGA has a 15.7 mil pitch; at 100 % zoom that is ~16 px between pin
centres. A six-character net name at the 11 px selection floor is
`6 × 0.6 × 11 ≈ 40 px` wide — two and a half pitches. At 0.8 it is 32 px, two
pitches. Any size floor above `pitch × 0.6 / chars` overlaps by construction;
the number can be tuned down but not to a value that is both readable and
non-overlapping on a dense part. Layer 1 already had the answer: a label that
is a fraction of its pin cannot overlap.

The relax knob makes it worse in exactly the case that matters: selecting a
chip makes *more* of its labels appear (0.75 × floor), at the moment the user
is looking at one pin.

## What is wrong with the knobs

- **Same word, different meanings.** `selectedLabelMinPx` is a *size* floor,
  `circleLabelMinScreenPx` a *visibility* floor, `labelMinSize` a build-time
  *world* floor, `labelHideThreshold` a build-time cull. Settings calls two of
  them "Labels" and the user has to know which is which.
- **Two selection models.** Fast mode enlarges the whole part; classic
  elevates one pin + the name. What you asked for — the pointed-at pin gets
  the bump, the rest stay — *is* the classic model. Today's fix moves fast mode
  toward it but keeps a size floor on the rest (0.8 × 11 = 8.8 px, still above
  the 8 px visibility floor, so still wider than a dense pin).
- **Three places to adjust, three different lists.** Settings ▸ Zoom LoD has
  seven sliders; Interactive mode's pin/part popups expose a different subset
  (`selectedLabelLodRelax` is only reachable there); the part-name fade
  (80→240 px) is a hard-coded constant with no knob at all.

## Proposal — one rule, fewer knobs

1. **Unselected: unchanged.** Base size × zoom, per-kind visibility floor.
   The 8 px default for pin/net names is the right kind of fix — it changes
   *when* labels appear, never how big they are.
2. **Selected part: no size floor on its pin labels.** They keep their
   geometric size, so they cannot overlap. Drop `selectedLabelOtherScale`
   (added today) rather than tune it; set `selectedLabelLodRelax` to 1 or
   delete it. The selected part's labels are then exactly the unselected
   look, lit, on top.
3. **Focus label: one pin, constant size, with a plate.** The selected pin
   and the hovered pin get a label at `focusLabelPx` (default 14; classic uses
   18) on a backing plate, drawn last. One knob replaces `selectedLabelMinPx`.
   The part name keeps its always-on treatment at the same constant size.
4. **Same rule on both paths.** Classic already does 3; add hover there and
   drop the size floor from fast mode — then the two paths agree and the
   setting means one thing.
5. **Name the knobs by what they do.** "Pin names appear at ≥ N px" /
   "2-pin net names appear at ≥ N px" / "Part names appear at ≥ N px" for
   layer 2; "Pointed-at pin label: N px" for layer 3. Interactive mode's pin
   group gets the same three, nothing else.

If a size floor for the whole selected part is ever wanted back, bound it by
geometry: `min(floor, pitchPx × 0.6 / chars)` — but with the focus label
doing the reading, it has no job left.

## For 0.41.1

Ship the two changes already made (0.8 on the rest; 8 px appear-floor) — both
are strictly better than v0.41.0. Then decide on the proposal above; steps 2–3
are a small change in `label-overlay.ts` (`selectedFloorPx` becomes "focus
pin or part name → `focusLabelPx`, else 0") plus a setting rename with a
migration, and step 4 is a hover clone in `updateElevatedLabels`.

## Pin numbers: inside the pin, for longer — sketch (prototyped)

A pin number is drawn *inside* its pin (0.55 × diameter, capped at 0.65), so
it cannot overlap a neighbour at any zoom. It only leaves the centre for one
reason: to make room for the net name, which goes on the other side
(BGA-alternating above/below). Today both share one appear-floor, so the
number is hidden just as early as the name and, when it shows, it is already
sitting in its shifted spot with nothing next to it.

Two changes, both in the overlay (Text fast mode):

1. **Separate floor.** `pinNumberMinScreenPx` (default 5) for numbers,
   `circleLabelMinScreenPx` (8) for net names. Settings: "Pin Numbers" and
   "Net Names on Pins". At 5 px a three-character number inside a pin is a
   legible glyph; the name at the same size is a smear.
2. **Two placements, chosen at draw time.** The label record carries the
   shifted position (as before) **and** a centred one (`alt`), plus the
   sibling net name's fontSize (`pairFontSize`). At draw time the overlay
   applies the net name's own appear-rule — the same one `selectVisibleLabels`
   uses, relaxed for the selected part — and draws the number centred while
   the name is hidden, shifted from the frame the name appears. The switch is
   a jump, not an animation; it lands on exactly the zoom where the name pops
   in, so the two read as one event.

```
zoom →   number hidden │ number centred, name hidden │ number shifted + name
         < 5 px        │ 5 px … name-floor (8 px)     │ ≥ 8 px
```

What it does not touch: 2-pin parts (their numbers are off by default), the
classic BitmapText path (positions are baked at scene build there; giving it
the same behaviour means two BitmapTexts per pin or a re-anchor on zoom), and
base sizes.

Knobs after this: *Pin Numbers appear at* / *Net Names on Pins appear at* /
*2-Pin Net Names appear at* / *Part Names appear at* — one unit, one verb.
