# UI Agent — Memory

## Dockview v5 Gotchas

- `setActivePanel` doesn't exist — use `panel.api.setActive()`
- Panel registration happens in `App.tsx` component map
- All panels implement `IDockviewPanelProps`
- Floating/popout windows work out of the box

## Reactive Store Pattern

- All stores use `useSyncExternalStore` (React 18+)
- **Critical:** `getSnapshot()` must return cached reference (same object when unchanged) or infinite loop
- Factory: `createStoreHook.ts` abstracts this pattern

## Focus/Activation — Known Fragile Area

Historical bugs #1, #5, #6 all stemmed from panel focus state:
- PixiJS ticker stops when panel loses Dockview focus → zoom events queue but don't render
- Store state changes don't propagate to unfocused panels → contrast/selection delayed
- Layer toggle state lost on visibility toggle → was calling wrong function (toggleAll vs toggleTraces)

**When touching panel lifecycle or store subscriptions, test with unfocused panels.**

## Pending Work

- Dark/light theme toggle (Phase 5 remaining)
- Board lookup panel (for board database integration)
- Filename editing UI (for manual board number correction)
