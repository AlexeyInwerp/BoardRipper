# DevOps Agent — File Map

**git_hash:** a7bbb79
**last_updated:** 2026-04-11

## Staleness Check

```bash
git log --oneline a7bbb79..HEAD -- Dockerfile docker-compose.yml .github/ desktop/ scripts/
```

## Domain: Docker

| File | Lines | Purpose |
|------|-------|---------|
| `Dockerfile` | 31 | 3-stage build: node → golang → scratch (~15MB) |
| `docker-compose.yml` | ~30 | Port 8081:8080, volumes data+library, 512MB mem cap |

## Domain: CI/CD (`.github/workflows/`)

| File | Lines | Purpose |
|------|-------|---------|
| `ci.yml` | ~60 | Push/PR: lint, typecheck, smoke test, go test, Docker build |
| `release.yml` | ~200 | Tag push: full pipeline + 4 standalone binaries + 3 Electron apps + Docker image + GitHub Release |

## Domain: Desktop (`desktop/`)

| File | Lines | Purpose |
|------|-------|---------|
| `main.js` | 480 | Electron entry: window creation, file dialogs, logging, library scan |
| `preload.js` | ~30 | Context isolation, no Node integration |
| `build-all.mjs` | ~200 | Build orchestration across all targets |
| `build-mac.mjs` | ~80 | macOS universal (arm64 + x64) |
| `build-mac-legacy.mjs` | ~80 | macOS x64 (Electron 22.3.27, Catalina+) |
| `build-win.mjs` | ~80 | Windows x64 |
| `package.json` | — | Electron 35.1.5, electron-packager 18.3.6 |

## Domain: Scripts (`scripts/`)

Check for NASdeploy.sh and any automation scripts.

## Build Targets

| Target | Platform | Electron | Notes |
|--------|----------|----------|-------|
| Docker (scratch) | linux/amd64 | — | Production deployment |
| Standalone binary | linux/amd64, win/amd64, mac/amd64, mac/arm64 | — | CGO_ENABLED=0 |
| Desktop macOS universal | darwin/arm64+x64 | 35.1.5 | **Unsigned** |
| Desktop macOS legacy | darwin/x64 | 22.3.27 | Catalina 10.15+ |
| Desktop Windows | win32/x64 | 35.1.5 | GPU sandbox disabled |

## Key Gaps

- macOS code signing + notarization: NOT DONE (users must `xattr -cr`)
- Windows SmartScreen: NOT DONE
- No health check in docker-compose (test: NONE)
- Desktop test coverage: ZERO
