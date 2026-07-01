# Session history: server-saved vs locally-saved — design plan

- **Status:** PLAN (design only — not approved to implement; "needs way more work")
- **Date:** 2026-07-01
- **Owner ask:** *"plan adding a switch to history to be server-saved or locally saved (needs way more work)."*
- **Scope of this doc:** the storage-location switch only. The checkbox de-select picker (same request) is already shipped on `feat/session-restore-picker`.

## 1. Current state

Session history is **local-only**:

- The open-set snapshot lives in `localStorage['boardripper-session']` as a `SavedSession`
  (`{ version:1, savedAt, entries: SessionEntry[] }`) — `store/session-store.ts`.
- `SessionEntry = { kind: 'board'|'pdf', fileName, fileSize, fileLastModified, fileId?, active? }`.
- Capture is continuous + debounced (`initSessionStore` subscribes to `boardStore`/`pdfStore`,
  500 ms debounce, plus a `beforeunload` flush).
- Restore is user-driven: `SessionRestorePrompt` reads the snapshot at mount and calls
  `restoreSession()` only on the explicit **Reopen** (never auto-restores — a board that hung
  the app last time can't re-hang on load).

**Consequence:** the session is bound to one browser profile on one device. Open boards on the
NAS from your workshop laptop, walk to the bench PC, and the bench PC knows nothing about it.
"Server-saved" would make the last session follow the *install* rather than the *browser*.

## 2. Why this is "way more work" (the honest part)

The backend is **single-install, single-tenant with no user identity**. There is one
`databank.db` config table (`db.GetConfig/SetConfig`, exposed via `GET/PUT /api/config` behind an
allowlist — `handlers/databank.go:36`). There are per-install *secrets* (`.mcp-secret`,
`.update-secret`) but **no per-user / per-browser identity**. So "server-saved" does **not** mean
"my session, synced to my account". It means **one shared session for every browser and device
pointed at that instance**. That raises real questions the local model never had to answer:

1. **Whose session wins?** Two browsers open different boards. Both capture (debounced) to the
   server. Last-writer-wins silently clobbers the other's open set. Local storage never had this
   because each browser owned its own key.
2. **Capture cadence → write amplification.** Local capture is a free `localStorage.setItem` every
   500 ms of activity. Server capture is an HTTP `PUT` on the same cadence → needs heavier
   debounce/coalescing (e.g. capture on meaningful open/close + `beforeunload`, not on every
   pan/zoom-driven store tick) and a `navigator.sendBeacon` on unload.
3. **Restore-prompt semantics.** With a shared server session, *every* browser that connects sees
   "reopen your last session?" — including the one that just saved it. Need an origin/echo guard
   (e.g. a per-browser `clientId` stamped on the snapshot; don't prompt a browser with its own most
   recent snapshot).
4. **Offline / desktop (Electron).** The desktop app may have no reachable backend. Server mode must
   degrade to local, not lose the session.

None of this is hard individually; together it's a genuine feature, not a flag flip. Hence: plan
now, build later.

## 3. Goal

A **Settings ▸ Session** toggle: **"Save open-session: This browser (local) · This server
(shared)"**. Default = **local** (today's behaviour, zero regression). In server mode the snapshot
round-trips through the backend so any browser hitting the same install can offer to reopen it;
local mode is byte-for-byte the current behaviour.

## 4. Design

### 4.1 Where the *switch itself* lives
The switch is a preference, not session data. Store it in the backend config KV
(`session_persistence` ∈ `{local, server}`, add to `allowedConfigKeys`) so it's an install-level
default, **mirrored into `localStorage['boardripper-session-mode']`** for a synchronous read at
boot (the config fetch is async; the restore prompt must decide local-vs-server before the first
paint without a flash). Boot reads the local mirror first, reconciles with `/api/config` once
loaded. (Chicken-and-egg avoided: the *mode* is tiny and safe to cache locally; only the *snapshot*
location changes.)

### 4.2 Backend: a dedicated session blob endpoint (not the config KV)
The snapshot can be a few KB of JSON and changes often — wrong shape for the config table (which is
meant for small stable scalars and is fully returned by `GET /api/config`). Add a purpose-built
endpoint instead:

```
GET  /api/session        → { snapshot: SavedSession | null, savedAt, clientId }   (200; {snapshot:null} when unset)
PUT  /api/session        → body: SavedSession + clientId; writes if newer         (200)
DELETE /api/session      → clears it                                              (204)
```

Storage: a single row in a new `session_state` table (`id=1, json TEXT, saved_at INTEGER,
client_id TEXT`) in `databank.db`, or a `<dataDir>/session.json` atomic-write file (mirrors the OBD
cache pattern — always writable across container updates, no schema migration). **Prefer the file**
for simplicity and to avoid a DB migration; it's a single small blob, not queryable data.

- Body cap (e.g. 256 KiB) — reject oversize with 413.
- Last-writer-wins by `savedAt` (server rejects a PUT whose `savedAt` is older than stored →
  409, so a stale tab can't clobber a fresher session). Not full CRDT — good enough for
  "reopen my last session".
- No auth beyond the existing app auth cookie; this is the same trust boundary as `/api/files`.

### 4.3 Frontend: a storage abstraction behind `session-store.ts`
Introduce a `SessionBackend` seam so `captureNow`/`readSession`/`clearSession` don't care where
bytes live:

```ts
interface SessionBackend {
  read(): Promise<SavedSession | null>;   // local: sync-wrapped; server: GET /api/session
  write(s: SavedSession): void;           // fire-and-forget; server: debounced PUT + sendBeacon on unload
  clear(): void;
}
```

- `localBackend` = today's `localStorage` code (keeps the synchronous path).
- `serverBackend` = fetch-based, with: heavier capture debounce (§2.2), `clientId` stamping (§2.3),
  `sendBeacon('/api/session', …)` on `beforeunload`, and **silent fallback to `localBackend` on any
  network error** (so server mode never loses a session when the backend is unreachable — §2.4).
- `SessionRestorePrompt` becomes async: `readSession()` returns a promise; render nothing until it
  resolves (the prompt is already gated on a non-empty session, so a one-frame delay is invisible).
- **Echo guard:** stamp `clientId` (a random id in `localStorage`, per browser) into each snapshot;
  the prompt skips prompting when `snapshot.clientId === myClientId && snapshot.savedAt` is the one
  this browser just wrote (i.e. don't offer to reopen what you never closed).

### 4.4 Mode switch behaviour (migration between modes)
- **local → server:** on flip, PUT the current local snapshot to the server (seed it), keep the
  local copy as fallback.
- **server → local:** on flip, GET the server snapshot once and write it to local, then stop
  syncing to the server (leave the server copy for other devices).
- Switching modes never *deletes* the other side silently.

## 5. Files to change (when built)
| File | Change |
|------|--------|
| `src/backend/handlers/session.go` (new) | `GET/PUT/DELETE /api/session`, atomic file at `<dataDir>/session.json`, savedAt guard, size cap |
| `src/backend/main.go` | register the three routes (behind the same auth `read`/`write` wrappers as `/api/config`) |
| `src/backend/handlers/databank.go` | add `session_persistence` to `allowedConfigKeys` |
| `src/frontend/src/store/session-store.ts` | `SessionBackend` seam; local + server backends; async `readSession`; clientId + echo guard; sendBeacon on unload |
| `src/frontend/src/components/SessionRestorePrompt.tsx` | await async `readSession()`; skip on echo |
| `src/frontend/src/panels/SettingsPanel.tsx` (or wherever Settings lives) | the local/server toggle, wired to `/api/config` + local mirror |
| `tests/session-restore.spec.ts` | server-mode round-trip (backend-gated, like existing test 4); echo-guard; fallback-to-local on 5xx |

## 6. Open questions (confirm before coding)
1. **Multi-client model — confirm "one shared session per install" is acceptable** (last-writer-wins),
   vs. per-browser server slots keyed by `clientId` (each browser gets its own server-stored session
   — more storage, no clobber, but "shared across my devices" is lost). The spec above assumes ONE
   shared session; the per-client-slot variant is a real alternative if the point is backup/roaming
   rather than a single hand-off.
2. **Default mode:** local (zero regression, my recommendation) or server (more "it just follows me")?
3. **Storage medium:** `<dataDir>/session.json` file (my recommendation, no migration) vs a
   `session_state` table in `databank.db`.
4. **Desktop/Electron:** does the desktop build even expose this toggle, or is it local-only there
   (no shared backend to speak of)?
5. **Privacy:** the snapshot contains file **names/sizes** of what was open. On a shared instance
   that leaks "what boards were being worked on" to anyone with app access. Acceptable given the app
   is already single-trust-boundary, or gate server mode behind a note?

## 7. Risks
- **Silent clobber** between browsers is the headline risk; the `savedAt` guard (409 on stale) +
  echo guard mitigate but don't eliminate it. If that's unacceptable, go per-client slots (Q1).
- **Async restore path** must not regress the "never auto-restore" safety property — the prompt
  stays user-driven; only the *read* becomes async.
- **Write amplification** if the server backend reuses the 500 ms local debounce — must coalesce to
  open/close events + unload beacon.
- **Fallback correctness:** server-mode network failure must fall back to local **without** dropping
  the in-flight snapshot, or a backend hiccup loses the session.
