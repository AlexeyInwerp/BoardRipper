# MCP OAuth Onboarding — Design (Sub-project C)

**Date:** 2026-06-15
**Status:** IMPLEMENTED on `feature/mcp-server-live-board-bridge` (Approach A, embedded AS).
Backend `mcpserver/oauth.go` + `GateAuto`; Settings auth-mode toggle. Verified end-to-end
over real HTTP (DCR → PKCE authorize → token → 20 tools via the MCP client) and in the
browser. Bearer remains the default; OAuth is opt-in via `mcp_auth_mode=oauth`. External-OIDC
(Approach B) and login-gated consent for exposed deployments remain future work.
**Depends on:** Sub-project A (MCP server + bridge), already built on `feature/mcp-server-live-board-bridge`.

## 1. Goal

Remove the token copy-paste step from connecting an agent. Today the user copies a
bearer secret into `claude mcp add … --header "Authorization: Bearer <token>"`.
With OAuth, connecting becomes:

```
claude mcp add --transport http boardripper http://<host>:1336/api/mcp
# then: /mcp in Claude Code → "Authenticate" → approve in browser → done
```

Claude Code and Claude Desktop both implement the MCP OAuth 2.1 flow (authorization-code
+ PKCE, with dynamic client registration and protected-resource-metadata discovery). The
bearer-token path stays as the default for trusted-LAN use; OAuth is the opt-in upgrade for
exposed or multi-user deployments.

## 2. Why this is its own sub-project

OAuth introduces an **authorization server** (token issuer + consent UI) that the bearer
path doesn't need. That's real surface: token issuance, expiry/refresh, a consent screen,
and persistence. It should not block the UI-onboarding work (client cards + live status),
which ships first.

## 3. What the MCP spec + go-sdk give us

The 2025-06-18 MCP auth model (the server is an OAuth **resource server**):

1. Unauthenticated request → `401` with `WWW-Authenticate` pointing at the
   **protected-resource-metadata** document (RFC 9728).
2. Client fetches `/.well-known/oauth-protected-resource`, learns the **authorization
   server**, then runs OAuth 2.1 authorization-code + PKCE (with dynamic client
   registration, RFC 7591) against it.
3. Client calls `/api/mcp` with the issued bearer access token; the server **verifies** it.

The go-sdk `auth` package (v1.6.1) provides the resource-server half directly:
- `auth.ProtectedResourceMetadataHandler(*oauthex.ProtectedResourceMetadata)` — serves step 1's metadata.
- `auth.RequireBearerToken(verifier auth.TokenVerifier, *auth.RequireBearerTokenOptions)` — middleware that returns the correct `401`/`WWW-Authenticate`, checks scopes/expiry, and puts `*auth.TokenInfo` in context.
- `auth.TokenInfoFromContext(ctx)` — read the verified identity in handlers.

What the SDK does **not** provide: the authorization server itself (login + consent + token issuance). That's the build decision below.

## 4. Approaches

**Approach A — Embed a minimal authorization server** (recommended for self-hosted).
BoardRipper hosts its own AS at `/api/mcp/oauth/*`: `/.well-known/oauth-authorization-server`
metadata, dynamic client registration, `/authorize` (a simple consent page — "Allow this
agent to access BoardRipper?" gated by the existing operator session), `/token` (issues a
signed JWT access token, verified locally via `RequireBearerToken` + a JWT verifier using
`golang-jwt`, already an indirect dep). Self-contained, no external IdP, fits the single-binary
Docker model. Most work, but matches how the product ships.

**Approach B — Delegate to an external OIDC provider** (Google, Authentik, etc.).
BoardRipper only does resource-server verification; the AS is the user's existing IdP. Far
less code, but forces every user to run/configure an IdP — wrong fit for a NAS appliance.
Offer as an *option* (config: "OAuth issuer URL") for users who already have one.

**Approach C — Discovery-only stopgap.**
Keep bearer tokens but also serve protected-resource-metadata so clients' `/mcp` auth menu
can guide users to the token. Minimal; doesn't actually remove copy-paste. Not worth it on
its own.

**Recommendation:** Approach A as the headline feature, with Approach B as a config-driven
alternative (verifier swaps to the external issuer's JWKS). Bearer remains default.

## 5. Sketch of the build (Approach A)

- New `mcpserver/oauth/` package: AS metadata, in-memory/SQLite client registry (DCR),
  `/authorize` consent handler, `/token` issuer (short-lived JWT access tokens + refresh),
  signing key persisted at `<dataDir>/.mcp-oauth-key` (mode 0600, like `.mcp-secret`).
- `RequireBearerToken` verifier validates the JWT (signature, `aud` = this resource, expiry,
  scope `boardripper`). Replaces the constant-time secret compare in `Gate` when OAuth mode is on.
- Consent screen reuses the operator session (the SPA is trusted) — "Agent X wants access," Approve/Deny.
- Settings ▸ Integrations: a third mode — **Auth: Token | OAuth** — and when OAuth is on, the
  connect cards drop the `--header` and show the bare `claude mcp add <url>` plus "you'll
  approve in the browser." A list of authorized clients with revoke.
- Config keys: `mcp_auth_mode` (`token`|`oauth`|`oidc`), `mcp_oidc_issuer` (Approach B).

## 6. Effort & risks

Medium. The fiddly parts are DCR + PKCE conformance and the consent UX; the go-sdk covers
the verification/metadata half. Risk: client-specific quirks (`mcp-remote` header handling,
Claude Desktop vs Cursor OAuth support maturity) — mitigate by keeping bearer as a fallback
always available.

## 7. Out of scope

- Per-user roles/scopes beyond a single `boardripper` scope (everything is read or
  drive-UI, already gated by `mcp_drive_ui`).
- Replacing the bearer path — OAuth is additive and opt-in.

## 8. Decision needed before planning

Confirm Approach A (embedded AS) vs starting with B (external OIDC only). Default assumption
for the plan: **A**, with B as a later config option.
