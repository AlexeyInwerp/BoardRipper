# QA Agent — Memory

## Test Infrastructure

- **Playwright** for frontend E2E (Chromium headless)
- **go test** for backend unit tests
- **CI:** GitHub Actions runs both on push/PR to main
- **Known limitation:** Headless Chromium has no WebGL adapters — PixiJS "No available adapters" warning is expected

## Historical Bug Patterns

From issue tracker (8 resolved issues):
1. **Focus/activation state** (3 issues) — panel focus ↔ store ↔ ticker lifecycle
2. **Rendering correctness** (2 issues) — pad outline sizing, selection overlay duplication
3. **Format support** (1 issue) — TVW files not listed in library scan
4. **Desktop build** (1 issue) — pdf.js worker path in Electron
5. **Feature gap** (1 issue) — recently viewed boards

**Regression risk area:** Dockview panel focus changes + store subscriptions + PixiJS ticker. When these three interact, bugs appear. Tests should specifically cover unfocused panel state.

## Priority for New Tests

1. Backend board resolution API (boarddb package) — about to ship, zero tests
2. Backend scanner/PDF extraction — complex async pipeline, untested
3. Panel focus edge cases — historical bug cluster
4. Electron smoke test — zero coverage currently
