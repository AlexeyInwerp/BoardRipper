---
id: diode-mode-usage
title: When diode mode helps and when it misleads
tags: [measurement, diode, method]
applies_to: [any]
status: authoritative
---
- Diode mode is very useful on DATA lines (USB, PCIe, DP/LVDS, I2C, …): it
  reveals shorts, leakage, and blown ESD/protection diodes, with readings that
  compare meaningfully pin-to-pin.
- Do NOT rely on diode mode for major power rails or CPU/GPU phase (VCORE) nodes.
  Those readings are low and vary a lot with the meter's diode-test voltage, so
  they are neither diagnostic nor comparable between meters.
- For power rails: measure VOLTAGE (board powered) or RESISTANCE-to-ground (board
  unpowered) instead.
