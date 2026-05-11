# Security Policy

## Supported Versions

BoardRipper ships as rolling releases through the in-app self-update path
(see [Self-update](README.md#self-update)). Only the **latest released
version** receives security fixes; please update before reporting an issue
to confirm it still reproduces.

## Reporting a Vulnerability

**Email:** [mail@ripperdoc.de](mailto:mail@ripperdoc.de) — subject line `BoardRipper security`.

If the issue affects the self-update pipeline (signed-manifest verification,
the orchestrator container, the bootstrap secret, or anything that could
deliver malicious code to running installs), please mark it `URGENT` in
the subject and I will respond within 48 hours. For everything else,
expect a response within a week.

Please include:

- BoardRipper version (visible in the toolbar version badge, or `docker
  inspect ghcr.io/alexeyinwerp/boardripper`)
- Deployment shape (Docker on Linux/Mac/Windows, Synology, standalone Go
  binary, Electron desktop)
- Reproduction steps or PoC, ideally as a single shell command or
  curl invocation
- Whether you've publicly disclosed yet (please do not — see below)

I'll work with you on a coordinated disclosure timeline. Default: fix
shipped within 14 days, public advisory within 30 days. Faster for
trivial fixes, slower if you're OK waiting and the fix needs care.

## Out of Scope

These are tracked as known limitations rather than vulnerabilities; please
do not file new reports for them unless you have a fresh angle:

- **Unauthenticated endpoints on a trusted-LAN deployment.** BoardRipper
  is designed for self-hosted home/shop networks where the operator
  controls who can reach the port. The CSRF middleware blocks browser
  drive-by attacks from a different origin, but a `curl` from another
  device on the same LAN can hit unauthenticated endpoints
  (`/api/databank/*`, `/api/sync/*`, `/api/files/*`). Adding session
  auth is on the roadmap.
- **`/api/update/bootstrap` cookie reachable on LAN.** Same caveat — a
  LAN attacker can curl the bootstrap endpoint and obtain the per-install
  update token. They still cannot install a non-signed manifest, and the
  counter + freshness + min-version checks limit replay scope to within
  the last 30 days.
- **The `apk add curl` runtime fetch in the orchestrator container.**
  Pinned to alpine-signed packages; replacing with a pre-built BoardRipper
  orchestrator image is on the roadmap.
- **No full Content-Security-Policy on the SPA.** `X-Frame-Options: DENY`
  + `X-Content-Type-Options: nosniff` + `Referrer-Policy: no-referrer`
  are set; a strict CSP needs Vite-build testing to avoid silently
  breaking inline styles / lazy-loaded chunks.

## Known intentional exposures

These are documented format-level decisions, not vulnerabilities:

- Hard-coded DES key in the XZZ parser (`0xdcfc12ac00000000`) — required
  by the file-format spec; matches OpenBoardView's reference parser.
- Default RC6 key in the FZ parser — same reason.
- Bit-rotation XOR pattern in the BRD parser — same reason.

These are parser-correctness primitives, not security primitives. Please
do not file reports about them; they exist because the file formats
require them.

## Hall of Fame

If your report leads to a fix, I'll credit you in the release notes
unless you prefer to stay anonymous — let me know in the email.
