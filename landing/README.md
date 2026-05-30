# BoardRipper landing page

Source for the page served at <https://www.ripperdoc.de/boardripper/>.

## Layout

- `index.html` — the entire page. Plain HTML5, embedded CSS, no JS, no build step.
- `screenshots/` — four PNGs referenced from the page: `board.png`, `multi-layer.png`, `revisions.png`, `library.png`.

## Preview locally

```bash
open landing/index.html
```

The file works as-is via `file://`. No server needed — this is the same exact HTML the visitor sees, so a local preview is a faithful reproduction.

## Updating

To bump the version, add a feature, or replace a screenshot:

1. Edit `index.html` directly. There is no template engine; the file is the source of truth.
2. If replacing a screenshot, drop the new PNG over the old file in `screenshots/`. Same filename, similar dimensions.
3. Commit and push in this repo.

The next time the **RipperDocWeb** repo runs `./deploy.sh`, it pulls a fresh copy of this directory from your local clone and rsyncs it into `public/boardripper/` before the FTP mirror. There is nothing to do on the RipperDocWeb side for a content change.

The page carries a templated version block — the lines between `<!-- BR_VERSION:START -->` and `<!-- BR_VERSION:END -->` are rewritten by the BoardRipper release script on every release (current version + release date). Don't hand-edit that block; the next release will overwrite it. Other release-time edits (new features, new screenshots, format-table updates) are content-only and stay manual.

Changelog and Download links point at `https://www.ripperdoc.de/boardripper/` — release artifacts and the changelog page are uploaded to FTP by the same release script. There is no GitHub-Releases dependency.

**Desktop downloads** (`BoardRipper-{macOS-universal,Legacy-macOS-x64,Windows-x64}-latest.zip`) live under `/boardripper/desktop/` on the website mirror; GitHub Releases is the primary host and this mirror is the failover for when github.com is unreachable. The release script uploads both the versioned `-vX.Y.Z.zip` (archived per release) and the `-latest.zip` pointer (atomic via `.new` rename) whenever it runs with `--desktop` or `--desktop-only`. Same bytes as the GitHub Release attachments.

## Common edits

- **New format:** add a row to the formats `<table>`, update the "eleven boardview formats" count in the lead.
- **New feature:** add a bullet to the Features `<ul>`, in the same em-dash style as existing entries.
- **New screenshot:** add another `<a><img></a>` to the `.thumbs` div and a one-line caption.
- **Allegro version coverage:** the Allegro row in the formats table lists which Allegro generations are fully supported and which are still in beta.
- **New version (automated):** the release script rewrites the `BR_VERSION` block — don't edit it by hand.

## Why a static HTML file

Plain HTML is the simplest tool that fits. The page changes a few times a year, has no dynamic content, and is served as a subpath of a Hugo site that already handles the rest. A build step would be friction without payoff.

## How it gets to ripperdoc.de

```
edit landing/ → commit + push (this repo)
                  ↓
         git pull in local clone
                  ↓
     ./deploy.sh in RipperDocWeb
                  ↓
   rsync landing/ → public/boardripper/
                  ↓
              FTP mirror
                  ↓
   https://www.ripperdoc.de/boardripper/
```

The RipperDocWeb deploy script reads from `$BOARDRIPPER_DIR` (defaults to `~/Desktop/Boardviewer`). It does not `git pull` automatically — keep your local clone of this repo up to date before deploying.
