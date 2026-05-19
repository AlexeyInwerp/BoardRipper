# ripperdoc-devicedb — Roadmap & Backlog

Living list of work past the current shipped prototype. Ordered by ROI; not a contract.

## Shipped already
- ✅ PHP impl deployed at `https://www.ripperdoc.de/devicedb/` (Linevast)
- ✅ Signed Ed25519 snapshots + admin CLI + cron-snapshot.php
- ✅ Password-based registration + login + sessions (HttpOnly+SameSite=Strict)
- ✅ Online editing — pencil affordances on every writable field
- ✅ Keyword + codename aliases (split out from generic `aliases`)
- ✅ URL-only board photos (`board_photos`, `model_photos`)
- ✅ BoardRipper-side contribdb client + Settings + write-capable Database Editor
- ✅ Integration e2e green end-to-end (BR push → admin accept → snapshot regen → BR pull → resolver reflects new value)

## Immediate hardening (host-side only — needs SSH)

| # | Task | Why |
|---|---|---|
| H1 | Production Ed25519 signing key on the host (replace ephemeral dev key) | Signature verification can only land on the BR side once the prod key is stable |
| H2 | Maintainer reviewer user-token (`php admin.php token issue --scopes contributions:moderate`) | So you can accept/reject from anywhere, not just SSH SQL |
| H3 | Register cron-snapshot.php every 10 min via Linevast control panel | Without it, accepts don't materialise into a new snapshot tarball until manually run |

## Backlog — ordered by user-visible impact

### B1 — Bulk-edit ODM (apply ODM to many boards at once)
Today contributing `odm` is one-board-at-a-time. For "all Apple = Foxconn (Quanta on some)" or "all Compal `LA-*` boards" this is hundreds of clicks.

**Design sketch:**
- New affordance on **model** and **family** and **brand** rows: an [edit ODM for descendants] button.
- Click → modal: target ODM, optional regex/glob filter on `board_number`, confidence + evidence.
- Frontend generates one contribution per matching board and submits them as a batch.
- Server: probably add a `submitted_at` group_id column on `contributions` so the admin UI can accept/reject the whole batch in one click. Alternatively `POST /v1/contributions/bulk` taking an array.
- Optimistic concurrency stays per-board — boards whose current ODM already matches get skipped client-side.

**Risk:** one bad bulk submission can pollute a lot of boards. Need a "preview" step that lists target rows before submit. Probably add the batch concept first, then the UI.

### B2 — Pull `K87`-style codenames out of `notes` into `board_aliases(kind='codename')`
One-shot SQL pass on the canonical DB. Estimated ~44 boards get a real codename; the marooned `820-2530 K24` pattern becomes searchable. Safe + reversible (notes column is left intact). Idempotent.

```sql
INSERT OR IGNORE INTO board_aliases (uuid, board_uuid, alias, alias_type, kind)
SELECT lower(hex(randomblob(16))), b.uuid,
       trim(replace(notes, 'xzz:'||model_number||'_'||board_number||' ','')),
       'codename-from-notes', 'codename'
FROM boards b
JOIN models m ON b.model_uuid = m.uuid
WHERE b.notes LIKE 'xzz:%K%' OR b.notes LIKE 'xzz:%J%';
```

### B3 — File upload for photos (lift the URL-only limit)
- `POST /v1/boards/{uuid}/photos` multipart/form-data → store at `data/photos/<uuid>.<ext>` (capped at 5 MB, image/* only, EXIF stripped).
- Thumbnail generation via GD or Imagick (Linevast has both).
- `.htaccess` rule: serve `data/photos/` directly (but deny the rest of `data/`).
- Frontend: drag-drop upload onto a board's detail pane.

### B4 — Admin web UI (replace the SSH CLI)
- New `admin.html` page, gated by `scopes ⊇ contributions:moderate`.
- Lists the moderation queue with each contribution's diff inline.
- Accept / reject / withdraw buttons in-page.
- Single-click bulk accept for batched submissions (see B1).

### B5 — `needs_changes` review state
- Reviewer can ask the contributor for more info instead of outright rejecting.
- Only meaningful once accounts exist (they do).
- Adds: state, comment field, contributor inbox view ("you have 2 patches that need attention").

### B6 — GitHub OAuth + email-passwordless options
Current sign-in is handle+password. For better adoption:
- "Sign in with GitHub" (a half-day with `league/oauth2-client` or hand-rolled — Composer is already on the host)
- "Email me a magic link" (sends a short-lived signed token, no password required)
- Link an existing handle to a GitHub account.

### B7 — Release-pipeline integration
- `scripts/release.sh` curls `/v1/snapshots/latest`, verifies the Ed25519 signature with the baked-in pubkey, places the tarball's `boards.db` at `Board Database/boards.db` before `docker build`.
- Effect: every fresh BoardRipper install starts with the most-current canonical DB. Removes the "pull on first sync" delay.

### B8 — BoardRipper-side snapshot pubkey via ldflags
- `go build -ldflags "-X main.DBPubKey=<base64>" ./src/backend`
- Enables signature verification on the BR side (today `SnapshotPubKey=""` so verification is skipped).
- Requires B7 OR a one-time stable host key from H1.

### B9 — DB-quality dashboard
A small read-only `/devicedb/quality.html`:
- Coverage by brand (% of boards with `board_name`, `odm`, photos, keywords)
- TODO buckets sized by board count
- Recent contributors leaderboard
- "Most-edited entities this week"

Cheap and motivational.

## Phase 4 (the wiki vision — separate workstream)

- `wiki_articles`, `wiki_revisions`, `wiki_links(entity_type, entity_uuid, article_slug)` tables.
- Article system on `ripperdoc.de/wiki/` (sibling Hugo site, already exists).
- Similarity engine: brand+family+ODM overlap baseline; embeddings if needed.
- BoardRipper "related boards" surfaced via `/v1/entities/{type}/{uuid}/related`.

## Schema deferred — only if needed

- `boards.power_pattern` / `boards.cpu` / `boards.gpu` — repair-relevant fields not in v2 today. Add when first patch arrives that wants them.
- `contributions.batch_id` — needed for B1 bulk submit (see above).
- `boards.deleted_at` — soft-delete for when an entity is judged spurious.

## Won't do (yet)

- Server-side full-text search across notes / aliases / descriptions. The dataset is small enough that the client's tree filter is fast.
- Federation / multiple authoritative hosts. One canonical DB at `ripperdoc.de` is enough until someone forks.
- BoardRipper-side write-CACHE-then-resolve. Reads stay against the locally-pulled snapshot; writes always go to the canonical via the contribdb push.
