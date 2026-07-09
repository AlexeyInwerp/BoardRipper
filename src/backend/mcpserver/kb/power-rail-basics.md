---
id: power-rail-basics
title: Power rails and where they come from
tags: [concept, power, teaching]
applies_to: [any]
status: draft
---
A power rail is a net that distributes one supply voltage to many parts. Rails are
produced by regulators: a **buck converter** steps a higher voltage down
efficiently by switching (look for an inductor + switching IC), while an **LDO**
drops voltage linearly (simpler, wastes the difference as heat, no inductor).
Rails usually sequence — some must come up before others — under the control of a
PMIC or power-management logic. Decoupling capacitors sit across a rail to steady
it; a shorted decoupling cap is a common cause of a dead rail. When tracing a
fault, identify which rail feeds the misbehaving part and whether that rail is
present and at the right voltage before suspecting the part itself.
