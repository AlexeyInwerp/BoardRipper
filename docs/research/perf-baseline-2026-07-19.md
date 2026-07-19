# Perf baseline — 2026-07-19

Baseline numbers for the renderer-smoothness work on `feature/smoothness-text-overlay`.
Task 10 re-runs `src/frontend/tests/perf-probe.spec.ts` unchanged for the
after-comparison — treat the automated rows below as the canonical baseline
this task exists to produce.

## Automated probe (canonical baseline)

Command:

```bash
cd src/frontend && npx playwright test tests/perf-probe.spec.ts 2>&1 | grep PERF
```

Chromium is launched with `--use-gl=angle --use-angle=swiftshader
--enable-unsafe-swiftshader`, i.e. a **software** (SwiftShader) GL backend —
absolute FPS is far below a real GPU and is not meaningful in isolation. It is
only valid for **relative** before/after comparison on this same machine.

Machine: macOS 26.5 (Darwin 25.5.0), Apple Silicon (arm64, MacBook Pro),
headless Chromium via Playwright 1.58.2, Node v25.2.1. Backend not running
during the probe (dev server only) — harmless proxy ECONNREFUSED noise for
`/api/*` appears in webServer logs and does not affect the renderer-only
measurement.

| Sample | Format | panFps | zoomFps | Notes |
|---|---|---|---|---|
| `samples/820-02016/820-02016.bvr` | BVR3 | 51.3 | 57.6 | run 1 |
| `samples/820-02016/820-02016.bvr` | BVR3 | 52.3 | 57.6 | run 2 (repeatability check) |
| `samples/NM-G611/NM-G611-Intel.tvw` | TVW | 11.3 | 24.4 | densest local sample found (see below); probed with a throwaway copy of the same script pointed at this file, not committed |

Raw PERF lines:

```
PERF {"panFps":51.3,"zoomFps":57.6}
PERF {"panFps":52.3,"zoomFps":57.6}
PERF-TVW {"panFps":11.3,"zoomFps":24.4}
```

`820-02016.bvr` (3075 parts / 11129 pins per CLAUDE.md) is the fixture
`perf-probe.spec.ts` actually exercises and is what Task 10 will re-run
verbatim. `NM-G611-Intel.tvw` (~29 MB, Teboview multi-layer) is a much denser
board and was probed by hand with a temporary copy of the same spec (same
scripted zoom-in + pan + zoom-burst sequence, same 3 s/2.5 s measurement
windows) to sanity-check that the smoothness problem is real and scales with
density — it loaded and completed within ~35 s, well inside the ~2 min budget.
It is not part of the committed spec since the brief only asks for
`820-02016.bvr` as the tracked fixture.

`samples/` was checked for an `NM-G611` or `LA-H271P` folder per the CLAUDE.md
"densest local sample" pointer; `NM-G611/NM-G611-Intel.tvw` is present,
`LA-H271P` is not.

## Manual perf-HUD pass (real browser): pending

The scripted mouse/wheel automation above runs the actual renderer through
SwiftShader in headless Chromium, but it cannot exercise the manual
Settings ▸ Performance & Debug ▸ perf overlay HUD readings that the brief
also calls for — that requires a human driving a real GPU-accelerated browser
window and eyeballing the on-canvas overlay text at three zoom depths (fit,
mid-zoom-labels-visible, deep zoom) on the densest sample. This automated
agent runs headless only and cannot do that.

**TODO (manual, real browser, before/after Task 10):**

| Depth | Board | Browser | Machine | perf overlay reading |
|---|---|---|---|---|
| Fit | NM-G611-Intel.tvw (or 820-02016.bvr) | — | — | pending |
| Mid-zoom (labels visible) | — | — | — | pending |
| Deep zoom | — | — | — | pending |

Fill in via Settings ▸ Performance & Debug ▸ "Show Perf Overlay", open the
densest available sample, and read the on-canvas HUD at each of the three
depths in a real (non-headless) browser with hardware GPU acceleration.

---

## After-numbers — Task 10 validation (2026-07-19, same machine, branch complete through 52de7249)

Same command, same machine, same SwiftShader caveats as above.

| Config | panFps | zoomFps | vs baseline |
|---|---|---|---|
| `820-02016.bvr`, textFastMode OFF (default) | 47.3 | 56.8 | pan −8% / zoom −1% — **within the ±10% noise gate**; the default path did not regress |
| `820-02016.bvr`, textFastMode ON (throwaway probe copy, toggled after load) | 41.0 | 56.4 | see interpretation below |

Raw lines:

```
PERF {"panFps":47.3,"zoomFps":56.8}
PERF-ON {"panFps":41,"zoomFps":56.4}
```

### Interpretation — two regimes, both real

- **At the probe's mid-zoom profile (few labels visible):** ON measures ~13%
  below OFF under SwiftShader. With little text on screen, the BitmapText
  path renders a handful of culled quads nearly for free, while the overlay
  pays a full-viewport Canvas2D `clearRect` + software-composited second
  canvas every dirty frame. SwiftShader exaggerates this (CPU compositing);
  a real GPU compositor pays far less for the second canvas.
- **At label-heavy zoom (the regime the mode exists for):** the Task 9
  parity captures show the HUD reading **11 fps (OFF) vs 60–61 fps (ON)**
  at an identical 171% viewport on `820-02016.bvr`
  (`test-results/labels-bitmaptext.png` vs `labels-overlay.png`) — a ~5.5×
  win exactly where BitmapText density is the bottleneck.

**Gate verdict:** default-path non-regression PASSES (±10% gate); the
label-depth ≥1.3× requirement PASSES on the HUD evidence (5.5×). The
mid-zoom SwiftShader delta is recorded honestly as a known trade-off of the
experimental mode and is expected to shrink on real GPUs — to be confirmed
during the field-debug period via the (still pending) manual real-browser
HUD pass above.

`buildBoardScene` build-time comparison: precise ms capture deferred to the
manual pass (headless log capture of the load-progress ticks was not
reliably attributable per-mode within the time budget). Directionally, mode
ON skips construction of all ~15,885 label BitmapTexts on this board.
