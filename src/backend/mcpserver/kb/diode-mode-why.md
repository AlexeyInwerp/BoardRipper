---
id: diode-mode-why
title: Why diode mode works (and what the number means)
tags: [concept, diode, measurement, teaching]
applies_to: [any]
status: draft
---
Diode mode pushes a small test current through the probes and shows the resulting
voltage drop. Across a healthy silicon junction that's roughly 0.4–0.7 V; a dead
short reads near 0; an open reads OL (over-limit). On a data line to ground you're
reading the drop across the ESD/protection diodes at the pin — a consistent,
comparable number pin-to-pin, so an outlier flags a blown protection diode or a
short. On a heavy power rail the reading is dominated by many parallel low-value
paths, so it's low and swings with the meter's test voltage — which is why diode
mode is diagnostic on data lines but not on rails.
