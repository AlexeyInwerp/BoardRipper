---
id: measurement-request-hygiene
title: Requesting measurements economically
tags: [measurement, method, efficiency]
applies_to: [any]
status: authoritative
---
- Treat nets bridged by a populated 0Ω resistor or a closed jumper as ONE
  electrical node. Don't request (or ask the user to probe) the same node twice.
- Before collapsing two nets into one node, confirm the bridging link is actually
  populated. A 0Ω resistor / jumper pad left unpopulated (DNP / open) does NOT
  connect the nets — if the link may be open, have the user verify it is bridged
  on this board before treating the nets as one.
- Detecting a bridge: net_neighbors surfaces nets reachable through 2-pin parts;
  part_info on the bridging part gives its value. Only a 0Ω-class link (0 / 0R /
  jumper) collapses the node; a real resistor does not.
