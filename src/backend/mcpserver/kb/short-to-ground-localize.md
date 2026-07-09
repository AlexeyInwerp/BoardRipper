---
id: short-to-ground-localize
title: Localizing a short to ground on a power rail
tags: [short, power, method]
applies_to: [any]
status: draft
---
1. Confirm the short: with the board unpowered, resistance/diode from the rail to
   GND reads very low (near 0 Ω / a few ohms). Compare against a known-good sister
   board where possible.
2. Narrow the domain: use net_neighbors and the schematic to list every component
   on the rail. The short is one of the parts tied to it (often a decoupling cap,
   a load IC, or the regulator).
3. Inject-and-find: apply a low, current-limited voltage into the rail; the
   shorted part heats first — locate it with a thermal camera or freeze-spray +
   isopropyl (the wet spot over the short dries first).
4. On a multi-cap rail, lift/remove suspect caps one at a time and re-measure
   after each; the short clearing identifies the culprit.
