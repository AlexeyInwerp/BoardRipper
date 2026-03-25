## Summary
<!-- What does this PR do? Link related issues with "Fixes #123" -->

## Component
<!-- Which area: renderer, pdf, parser, library, backend, ui, desktop -->

## Testing
- [ ] Playwright tests pass (`cd src/frontend && npm test`)
- [ ] Go tests pass (`cd src/backend && go test ./...`)
- [ ] Docker build succeeds (`docker build -t boardripper:test .`)
- [ ] Manual smoke test on target deployment

## Regression Check
<!-- Based on prior session analysis, these are high-risk areas. Check if your changes touch them: -->
- [ ] Does NOT break info panel ↔ renderer connection
- [ ] Does NOT break PDF viewer search scope
- [ ] Does NOT flip board top/bottom orientation
- [ ] Does NOT break library file listing
- [ ] Does NOT regress PDF open performance
- [ ] PixiJS lifecycle safe (no `app.destroy()`, no new singletons)

## Screenshots
<!-- If visual change, before/after screenshots -->
