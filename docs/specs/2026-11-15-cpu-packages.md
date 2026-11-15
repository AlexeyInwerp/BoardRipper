# CPU / GPU package models for the 3D view

2026-11-15 · status: implemented, review with the mockup
Mockup: [2026-11-15-cpu-package-mockup.html](2026-11-15-cpu-package-mockup.html) (model beside the real ball map, lookup readout, every record)
Code: `src/frontend/src/store/cpu-packages.ts` (records + lookup), `package-estimate.ts` ▸ `knownPackage`, `three3d/part-models.ts` ▸ `buildPackage`

## What it does

A large ball field on a board is looked up in a table of known packages. When it
matches, the 3D view draws that package — substrate at its real size, the bare
dies where they sit, a lid or a stiffener ring, the die-side capacitors —
instead of a box the size of the pin field. Before this, every BGA was a flat
moulded box and only the Apple M-series had a guessed lid.

## The lookup rule, and why ball count is not the key

The brief assumed one ball count per package. The corpus says two things against
using the count alone:

- **A boardview can list fewer balls than the package has.** The MacBook Pro
  A2251's Ice Lake-U (BGA1526) lists 1,344. The other XZZ files list the full
  count (1356, 1440, 1515, 1528 all exact), so this is per delivery, not per
  format.
- **Different chips share one footprint.** GA102 and AD102 are both 3,328 balls
  on 51 × 51 mm; FP6, FP7 and FP7r2 are all 1,140 balls on 35 × 25 mm; TU104,
  TU106 and TU116 all 2,228 on 37.5 mm. The model is the same, so one record
  covers each group.

So `matchPackage` keys on the **nearest-neighbour pitch** (± 0.06 mm) and the
**outer ball-centre span** along both axes (summed error ≤ 1.2 mm, either
orientation), and uses the count as a check: a field with *more* balls than the
record is never that record, a field with fewer costs a little and reports how
many are missing. Measured on the 28 ball maps exported from the corpus
(`scripts/cpu-package-ballmaps.ts`), 28 resolve to the intended record; the
estimator run on five boards (`scripts/cpu-package-check.ts`) agrees with and
without package names.

A staggered 0.4 mm field (BGA1515, BGA1380) has diagonal nearest neighbours, so
the estimator's grid clusters report 0.26–0.28 mm; the lookup takes the
nearest-neighbour pitch from the field directly.

The A1 corner: when the pins are named, the record is turned so ball A1 sits at
its (−x, +y) corner, which puts the CPU die on the correct side of a two-die
package. Unverified against a photo so far.

## What the library boards carry

Survey of every sample board for parts with ≥ 300 pins
(`scripts/cpu-package-survey.ts`, 397 files). Intel-era Apple boards and the
Compal/Wistron/Quanta Allegro boards carry the CPUs; the GenCAD cards carry the
big GPUs. There is **no AMD laptop board** in the corpus.

| Package | Balls | Pitch | Span (mm) | Boards | Named in the file as |
|---|---:|---:|---|---|---|
| Intel BGA1168 Haswell-ULT | 1168 | 0.65 | 38.7 × 22.7 | 12 (A1465/A1466/A1502/A1418, LA-9591P, LA-B441P) | `SHARK-BAY-ULT_BGA_1168P-T`, `BGA1168-INTEL-HASWELL` |
| Intel BGA1364 Haswell-H | 1364 | 0.70 | 35.9 × 30.6 | 9 (A1398, A1418, LA-9941P) | `HASWELL_BGA_1364P-T` |
| Intel BGA1380 Bay Trail | 1380 | 0.40 | 16.0 × 16.0 | 1 | `BGA1380-INTEL-VALLEYVIEW-T` |
| Intel BGA1356 Skylake/Kaby Lake-U | 1356 | 0.65 | 40.7 × 22.8 | 12 (A1706/A1708/A1418, Acer F5-573G, LA-C881P, LA-E671P, LA-F661P, P3HCJ) | `SKL-U_BGA_1356P-T`, `BGA1356-INTEL-SKYLAKE-U` |
| Intel BGA1440 Skylake-H → Coffee Lake-H | 1440 | 0.65 | 40.7 × 26.8 | 9 (A1707/A1990/A2141/A1993, LA-C361P, LA-E331P, LA-H281P) | `SKL-H_BGA_1440P-T`, `CFL-H_BGA_1440P-T` |
| Intel BGA1515 Skylake/Amber Lake-Y | 1515 | 0.40 | 15.2 × 18.7 | 7 (A1534, A1932) | — |
| Intel BGA1528 Coffee/Comet Lake-U | 1528 | 0.65 | 44.7 × 22.7 | 6 (A1989, A2159, A2289) | — |
| Intel BGA1526 Ice Lake-U | 1344 listed | 0.635 | 44.0 × 23.2 | 1 (A2251) | — |
| Intel BGA1744 Alder Lake-P | 1744 | 0.65 | 49.2 × 24.5 | 1 (LA-P161P) | `ADL-P_BGA_1744P-T` |
| Intel PCH-H 100/200 | 837 | 0.543 | 22.0 × 22.0 | 4 | `SKY-S-PCH_BGA_837P-T` |
| Intel PCH-H 300 | 874 | 0.535 | 22.6 × 23.6 | 1 | `CNP-H_BGA_874P-T` |
| NVIDIA 29 mm laptop GPU | 908 | 0.80 | 27.4 × 27.4 | 9 (N13P-GS, N13M, N15P-GT, N17P-G0, iMac GK107) | `N15P-GT_BGA_908P`, `N17P-G0-A1_FCBGA_908P` |
| NVIDIA 40 mm (GK104) | 1745 | 0.787 | 38.4 × 38.4 | 2 (A1418 D8, A1419) | — |
| NVIDIA GB4B-256 (Turing 37.5 mm) | 2228 | 0.70 | 35.7 × 35.7 | 1 (MSI MS-V385) | `BGA_2228_P070_375X375` |
| NVIDIA GN22-X4 (GB206 laptop) | 2088 | 0.65 | 31.2 × 31.2 | 1 (LA-P161P) | `GN22-X4-A1_FCBGA_2088P` |
| NVIDIA GA102 / AD102 | 3328 | 0.80/0.90 | 49.4 × 49.4 | 2 (RTX 3080, RTX 4090) | `BGA_3328_P080_P090_510X510` |
| AMD Polaris 10/20 | 1401 | 0.90 | 37.4 × 37.4 | 2 (MSI RX 580, A1419 2017) | `BGA_ELLESMEREL4` |
| AMD Vega 10 | 2013 | 0.99 | 44.8 × 44.9 | 1 (A1862) | — |
| AMD GPU, iMac 2019 | 1928 | 0.787 | 39.9 × 39.9 | 1 (A2115) | — |
| Apple T2 | 1406 | 0.381 | 14.4 × 14.8 | 9 | — |
| Apple M1 / M2 / M1 Pro / M1 Max / M3 Pro | 2502 / 2565 / 2971 / 4183 / 2647 | 0.5 / 0.48 / 0.635 / 0.635 / 0.65 | 27.0 × 22.5 … 55.2 × 34.4 | 20 | — |
| Intel LGA1151 / LGA2066 socket pads | 1200 / 2066 | 0.914 / 1.0 | 36.6 × 37.9 / 51.4 × 45.9 | 6 (iMacs) | — |

Two readings from the ball maps that shape the models: Intel U/H/P packages have
one rectangular depopulated block in the centre — that is where the land-side
capacitors sit, under the dies; NVIDIA packages have a square void the size of
the die with a dense ring of balls around it. The Y-series fields are fully
populated. The contact sheet of all 28 maps is in the mockup.

## The records

43 records in `cpu-packages.ts`, each with its sources and a confidence line.
What each number rests on:

**Intel (6th gen → Core Ultra 200V).** Ball count, pitch, body size and, where
the datasheet gives it, substrate thickness and stack height come from Intel's
datasheet volume 1 "Package Mechanical Attributes" tables (doc numbers 332990,
334408, 337344, 338023, 615211, 631121, 655258, 743844, 792044, 842704, 834774,
829568, 633935). Every mobile package but the HX line is a "Balls Anywhere"
pattern — no regular grid — which is why the span, not a grid, is the key.
Spans are measured where the corpus has the package and derived (body − 1.3 mm)
otherwise. Die areas are third-party die-shot measurements (± 5 %); die
*positions* come from package photos: CPU die on the A1 side, PCH-LP beside it
along the long axis. H-series packages carry one die, the PCH-H is its own BGA.
Meteor Lake / Arrow Lake / Lunar Lake are Foveros stacks drawn as a base tile
carrying the compute, GPU, SoC and IOE tiles; Lunar Lake adds the two LPDDR5X
packages, which are the tallest things on it. No Intel mobile package has a lid
or a stiffener ring. Two contradictions inside Intel's own documents are
settled in the records' notes (BGA1787 height, BGA1964 height).

| Package | Balls | Pitch | Body | Height | Dies | Used by |
|---|---:|---:|---|---:|---|---|
| BGA1515 | 1515 | 0.40 | 20 × 16.5 | ~1.0 | CPU + PCH-LP | Skylake-Y → Amber Lake-Y |
| BGA1356 | 1356 | 0.65 | 42 × 24 | ~1.3 | CPU + PCH-LP (+ eDRAM on Iris) | Skylake-U, Kaby Lake-U/R |
| BGA1440 | 1440 | 0.65 | 42 × 28 | 1.49 | CPU | Skylake-H → Comet Lake-H |
| BGA1528 | 1528 | 0.65 | 46 × 24 | ~1.3 | CPU + PCH-LP (+ eDRAM at 28 W) | Coffee Lake-U, Whiskey Lake-U, Comet Lake-U |
| BGA1526 | 1526 | 0.65 | 50 × 25 | 1.3 | CPU + PCH-LP | Ice Lake-U |
| BGA1449 | 1449 | 0.65 | 45.5 × 25 | 1.185 | CPU + PCH-LP | Tiger Lake UP3 / H35 |
| BGA1598 | 1598 | 0.40 | 26.5 × 18.5 | 0.963 | CPU + PCH-LP | Tiger Lake UP4 |
| BGA1787 | 1787 | 0.65 | 50 × 26.5 | 1.41 | CPU | Tiger Lake-H45 |
| BGA1744 | 1744 | 0.65 | 50 × 25 | 1.185 | CPU + PCH-P | Alder / Raptor Lake-P/H/U15 |
| BGA1781 | 1781 | 0.40 | 28.5 × 19 | 1.033 | CPU + PCH-P | Alder Lake-U 9 W |
| BGA1792 | 1792 | 0.62 | 40 × 25 | 1.171 | CPU + PCH-PX | Raptor Lake-PX |
| BGA1964 | 1964 | 0.80 grid | 45 × 37.5 | 2.005 | desktop die | Alder / Raptor Lake-HX |
| BGA2049 | 2049 | 0.65 | 50 × 25 | 1.245 | Foveros tiles | Meteor Lake-U/H, Arrow Lake-H/U |
| BGA2551 | 2551 | 0.37/0.40 | 23 × 19 | 0.675 | Foveros tiles | Meteor Lake-U Type 4 |
| BGA2114 | 2114 | unpublished (0.65 inferred) | 37.5 × 30.2 | ? | Foveros tiles | Arrow Lake-HX |
| BGA2833 | 2833 | 0.50 | 27.5 × 27 | 1.34 / 1.58 | Foveros + 2 LPDDR5X | Lunar Lake |
| FCBGA1338 | 1338 | 0.593 | 35 × 24 | 1.406 | SoC + PCH | Jasper Lake |

Not recorded because the pitch is unpublished and a guess would never match:
Gemini Lake FCBGA1090 (25 × 24), Apollo Lake FCBGA1296 (24 × 31), Alder Lake-N
FCBGA1264 (35 × 24), Comet/Ice Lake-Y BGA1377 (26.5 × 18.5).

**AMD.** Every FP/FL package is a lidless flip-chip die (or dies) inside a
peripheral stiffener frame (AMD XAPP1377), and every one is multi-pitch, so the
recorded pitch is the minimum. FP6 / FP7 / FP7r2: 1,140 balls, 0.65 mm,
25 × 35 × 1.38 mm from AMD's Ryzen Embedded V3000 and 8000 briefs — primary.
FP5 (1,140, 0.7 min, 35 × 25) is WikiChip only. FP8 (1,377 balls, 25 × 40 — the
body from AMD's press release, the count from a leaked AMD document, the pitch
unknown), FP11 Strix Halo (2,077, 37.5 × 45, two CCDs flanking the IOD/GPU die
on a fan-out interposer, pitch unknown) and FL1 Dragon/Fire Range (1,763,
40 × 40, desktop chiplets without an IHS, pitch unknown) are recorded with
0.65 mm assumed and say so. Two corrections to the brief: FL1 is Dragon Range,
Strix Halo is FP11; Rembrandt is FP7, not FP6. Polaris, Vega 10 and the
iMac 2019 GPU are measured on the corpus; the Vega 10 record draws the GPU and
two HBM2 stacks on an interposer.

**NVIDIA.** No public document gives a ball pitch (NVIDIA calls the pattern
"protection-worthy IP"), and the database counts disagree by a few balls. The
corpus settles the packages that matter: the 29 mm 128-bit laptop package is
908 balls at 0.8 mm across Kepler, Maxwell and Pascal (N13P/N13M/N15P/N17P);
Turing's GB4B-256 is 2,228 balls at 0.7 mm on 37.5 mm (the count and body are
in NVIDIA's own NPN product sheets, the pitch is measured); GA102/AD102 are
3,328 balls on 51 mm at a mixed 0.8/0.9 mm pitch; the GB206 laptop part
(GN22-X4) is 2,088 balls at 0.65 mm. Every photo shows the same construction —
bare die centred, metal frame around the substrate perimeter, capacitors
between — so that is the model. Not recorded for lack of a measured pitch:
GA104/GA106/AD103/AD104 (2,714 balls, 40 mm), GA107 (1,358, 29 mm), GP104
(2,150, 37.5 mm), GB203 (3,064), TU117 (960 at 29 mm and 603 at 23 mm), GP108
(595, 23 mm). A board with one of them would give the pitch in a minute.

**Apple.** M1, M2, M1 Pro, M1 Max and T2 are measured on the corpus; lid and
memory placement from photos. The old heuristic (≥ 2,000 balls at ≤ 0.55 mm
and ≥ 400 mm² ⇒ lid + two dies) stays as the fallback for an unmatched
Apple-sized field.

**Sockets.** The iMacs' LGA1151 / LGA2066 pad fields draw a socket frame with a
lidded CPU in it.

## The models

`buildPackage` (`part-models.ts`) draws from a record: substrate (vendor colour),
bare dies as dark silicon with an underfill fillet and a lighter mirror top,
memory dies darker, an optional interposer / base tile, a nickel lid with a
sealant rim, a stiffener ring (four bars), rows of 0402/0201 caps, a socket
frame, and the A1 mark. Everything is boxes, merged per material by the
renderer as before. The mockup draws the same shapes from the same table
(`scripts/cpu-package-specs-export.ts` writes it to
`2026-11-15-cpu-package-specs.js`).

## Verified

- 28 of 28 corpus ball maps resolve to the intended record (mockup ▸ Lookup;
  `window.lookupAll()`).
- `tests/cpu-package-3d.spec.ts`: on the Dell XPS 15 9550 board (LA-C361P)
  the Skylake-H, the GeForce 960M and the PCH-H draw as their records in the
  app's 3D view; screenshot checked by eye — the CPU shows its die and cap
  rows, the GPU its die in a ring.
- Unit: `cpu-packages.test.ts` (span/pitch rule, turned fields, missing balls,
  every record finds itself).

## Open

- Die positions are from photos, not drawings; Intel keeps the mechanical
  drawings in its restricted design centre. A photo comparison like the
  Feather RP2040 one would settle the U-series layouts.
- The A1 turn is untested against a real package orientation.
- Ice Lake-U is recorded at the span of the one sample, which lists 1,344 of
  1,526 balls; a file listing them all may span more and miss.
- AMD mobile has no sample board, so none of its records is measured.
- GA102 vs AD102, FP6 vs FP7, TU10x: one record each, by design.

## Reproduce

```sh
cd src/frontend
npx vite-node ../../scripts/cpu-package-survey.ts -- ../../samples 300 > survey.tsv
npx vite-node ../../scripts/cpu-package-ballmaps.ts -- ../../samples ../../docs/specs/2026-11-15-cpu-package-ballmaps.js
npx vite-node ../../scripts/cpu-package-specs-export.ts
npx vite-node ../../scripts/cpu-package-check.ts -- "../../samples/LA-P161PR1B.brd"
BR_3D_SHOT=/tmp npx playwright test tests/cpu-package-3d.spec.ts
```
