# DevOps Agent — Memory

## Deployment Targets

- **NAS:** Synology DSM 7.2+, port 8090 external, NASdeploy.sh script
- **Docker:** scratch-based ~15MB image, self-update via Docker socket API
- **Desktop:** Electron for macOS (universal + legacy) and Windows x64

## Self-Update System

- Uses Docker socket API for in-place container updates
- Requires external orchestrator container (can't restart itself)
- GitHub API polling for new releases
- Version comparison handles git-describe format

## Historical Issues

- #3: PDF files couldn't open in Electron — `GlobalWorkerOptions.workerSrc` not set in desktop build (pdf.js worker path issue)
- GPU sandbox disabled on Windows Electron due to ANGLE issues
- macOS App Translocation moves unsigned .app to random temp path — affects file path resolution

## Key Constraints

- Docker image MUST stay < 20MB (NAS storage is constrained)
- Go binary is statically linked (CGO_ENABLED=0) — no glibc dependency
- Version injected at build time: `-ldflags -X boardripper/updater.Version=${APP_VERSION}`
- CA certificates included for HTTPS (GitHub API calls)
