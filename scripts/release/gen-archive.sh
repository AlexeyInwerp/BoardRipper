#!/usr/bin/env bash
# Generate archive.html from CHANGELOG.md — a single landing page listing
# every historical BoardRipper release with download / source links.
#
# Called from scripts/release/site-artifacts.sh during release.sh. Can also
# be run standalone for ad-hoc regeneration:
#
#     REPO_ROOT=$(pwd) OUT=/tmp/archive.html ./scripts/release/gen-archive.sh
#
# Inputs (env):
#   REPO_ROOT   — repo root (default: parent of script dir)
#   OUT         — output path (default: /tmp/archive.html)
#   GHCR_KEEP   — space-separated list of versions still on GHCR
#                 (default: "v0.19.0 v0.19.5 v0.20.5 v0.20.8")
#
# Maintenance: as versions retire (deleted from GHCR), update GHCR_KEEP and
# re-run. As versions are removed from ripperdoc.de FTP, the corresponding
# rows fall back to source-only automatically (the script does not probe
# FTP — the link convention determines availability).
#
# See docs/RELEASE_ARCHIVE.md for the retention policy.
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
OUT="${OUT:-/tmp/archive.html}"
GHCR_KEEP="${GHCR_KEEP:-v0.19.0 v0.19.5 v0.20.5 v0.20.8}"

# Versions with drop-bundles on ripperdoc.de. v0.19.0–v0.19.3 only have the
# .tar.gz Docker tarball, not the signed .tar drop-bundle (the bundle format
# didn't exist until v0.19.4 — `release.sh` started emitting it then).
HAS_BUNDLE='^v0\.(19\.[4-9]|20\.)'
# Versions with a Docker tarball + drop-bundle on ripperdoc.de.
# Pre-v0.19.0 used a now-retired GitHub Actions pipeline; nothing was
# mirrored to ripperdoc.de for those, so they're source-only.
HAS_TARBALL='^v0\.(19|20)\.'

cat > "$OUT" <<'HTML_HEAD'
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BoardRipper — Version archive</title>
<meta name="description" content="Historical BoardRipper releases. Docker tarballs and signed drop-bundles for v0.19.0 onward; pre-v0.19 build from source.">
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html { font-size: 16px; }
  body { margin: 0; background: #fff; color: #000; font-family: Verdana, Geneva, sans-serif; font-size: 14px; line-height: 1.55; }
  main { max-width: 880px; margin: 0 auto; padding: 28px clamp(14px, 4vw, 32px) 60px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 28px 0 8px; }
  a { color: #0000ee; }
  a:visited { color: #551a8b; }
  nav { margin: 8px 0 22px; font-size: 13px; line-height: 1.9; }
  nav a { margin: 0 2px; }
  hr.stars { border: none; text-align: center; color: #888; margin: 24px 0; letter-spacing: 6px; height: 1em; }
  hr.stars::before { content: "* * *"; }
  table.archive { border-collapse: collapse; width: 100%; margin: 12px 0 24px; font-size: 13px; }
  table.archive th, table.archive td { border-bottom: 1px solid #ddd; padding: 6px 10px 6px 0; vertical-align: top; text-align: left; }
  table.archive th { font-weight: bold; border-bottom: 2px solid #888; }
  table.archive td.ver { font-family: 'Courier New', ui-monospace, monospace; white-space: nowrap; }
  table.archive td.date { color: #666; white-space: nowrap; font-size: 12px; }
  table.archive td.dl a { font-family: 'Courier New', ui-monospace, monospace; font-size: 12px; }
  .tag-current { background: #ecffec; }
  .tag-keep { background: #fff8e1; }
  .small { color: #666; font-size: 12px; }
  code { font-family: 'Courier New', ui-monospace, monospace; font-size: 13px; background: #f4f4f4; padding: 1px 4px; }
  pre { background: #f4f4f4; border: 1px solid #ccc; padding: 10px 12px; font-family: 'Courier New', ui-monospace, monospace; font-size: 13px; overflow-x: auto; }
  @media (max-width: 640px) {
    main { padding: 20px 14px 50px; }
    table.archive { font-size: 12px; }
    table.archive td.date { display: none; }
  }
</style>
</head>
<body>
<main>

<header>
  <h1>BoardRipper version archive</h1>
  <p class="small">Historical releases. The current version is always at <a href="manifest.json">manifest.json</a>. To check what your install is running, click the version badge in the toolbar.</p>
  <nav>
    [<a href="./">Home</a>] |
    [<a href="changelog.html">Changelog</a>] |
    [<a href="https://github.com/AlexeyInwerp/BoardRipper">Source on GitHub</a>]
  </nav>
</header>

<h2 id="how">How to install an archived version</h2>

<p>Three install paths, in order of effort:</p>

<ol>
<li><b>Tarball</b> (any release with a Docker tarball link below) &mdash; <code>docker load &lt; boardripper-vX.Y.Z.tar.gz &amp;&amp; docker run &hellip;</code>. Same image as GHCR; loadable offline.</li>
<li><b>Drop-bundle</b> (signed manifest + tarball, packaged as one <code>.tar</code>) &mdash; drag it onto a running BoardRipper window via <code>/api/update/apply-bundle</code>. Only useful for recovery from a broken in-app updater; the running container must be v0.19.5+.</li>
<li><b>Source build</b> (any version) &mdash; <code>git clone https://github.com/AlexeyInwerp/BoardRipper.git &amp;&amp; git checkout vX.Y.Z &amp;&amp; docker build -t boardripper:vX.Y.Z .</code>. Required for pre-v0.19.0 versions; pre-v0.19 builds used a now-retired GitHub Actions pipeline and aren&rsquo;t mirrored here.</li>
</ol>

<p class="small">&#9888; Older releases predate fixes in newer versions. If you&rsquo;re recovering a broken install, prefer the latest version unless you specifically need to downgrade.</p>

<h2 id="ghcr">GHCR image availability</h2>

<p>Only a handful of versions are kept on GHCR &mdash; others were pruned during the retention sweep. Versions still on GHCR can be pulled directly:</p>

<pre>docker pull ghcr.io/alexeyinwerp/boardripper:vX.Y.Z</pre>

<p>Versions <b>only</b> available as tarball / source: GHCR pull will 404. Use the tarball link in the table below.</p>

<hr class="stars">

<h2 id="versions">All versions</h2>

<table class="archive">
<thead>
<tr><th>Version</th><th>Date</th><th>Tarball</th><th>Drop-bundle</th><th>GHCR</th><th>Source</th></tr>
</thead>
<tbody>
HTML_HEAD

# Walk CHANGELOG entries newest → oldest. Skip the "v0.14.0 and earlier"
# catchall heading (no specific version to link to).
grep -E '^## v[0-9]+\.[0-9]+\.[0-9]+' "$REPO_ROOT/CHANGELOG.md" | \
while IFS= read -r line; do
  # "## v0.20.8 — 2026-05-13"
  ver=$(echo "$line" | sed -E 's/^## (v[0-9]+\.[0-9]+\.[0-9]+).*/\1/')
  date=$(echo "$line" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' || echo "")

  tarball_cell="&mdash;"
  bundle_cell="&mdash;"
  ghcr_cell="&mdash;"
  cls=""

  if [[ "$ver" =~ $HAS_TARBALL ]]; then
    tarball_cell="<a href=\"releases/boardripper-${ver}.tar.gz\">.tar.gz</a>"
  fi
  if [[ "$ver" =~ $HAS_BUNDLE ]]; then
    bundle_cell="<a href=\"releases/boardripper-update-${ver}.tar\">.tar</a>"
  fi
  for kept in $GHCR_KEEP; do
    if [ "$ver" = "$kept" ]; then
      ghcr_cell="<code>${ver}</code>"
      cls=' class="tag-keep"'
      break
    fi
  done

  # Newest entry in CHANGELOG.md = current release (highlighted green).
  if [ -z "${PRINTED_CURRENT:-}" ]; then
    cls=' class="tag-current"'
    PRINTED_CURRENT=1
  fi

  src_link="<a href=\"https://github.com/AlexeyInwerp/BoardRipper/tree/${ver}\">${ver}</a>"

  cat >> "$OUT" <<ROW
<tr${cls}>
<td class="ver">${ver}</td>
<td class="date">${date}</td>
<td class="dl">${tarball_cell}</td>
<td class="dl">${bundle_cell}</td>
<td class="dl">${ghcr_cell}</td>
<td class="dl">${src_link}</td>
</tr>
ROW
done

cat >> "$OUT" <<'HTML_TAIL'
</tbody>
</table>

<p class="small">
<span style="background:#ecffec;padding:0 4px">&block;</span> current release &nbsp;
<span style="background:#fff8e1;padding:0 4px">&block;</span> kept on GHCR &nbsp;
&mdash; = not available
</p>

<hr class="stars">

<p class="small">
For pre-v0.19.0 versions, build from the git tag (see <a href="#how">How to install</a> above). The GitHub release pages for pre-v0.19 releases were removed during the 2026-05-13 archive cleanup; the underlying git tags remain immutable.
</p>

<p class="small">
Maintained by <a href="https://github.com/AlexeyInwerp">AlexeyInwerp</a>. Issues: <a href="https://github.com/AlexeyInwerp/BoardRipper/issues">github.com/AlexeyInwerp/BoardRipper/issues</a>. AGPL-3.0.
</p>

</main>
</body>
</html>
HTML_TAIL

echo ">>> archive.html generated at $OUT ($(wc -c < "$OUT") bytes, $(grep -c '^<tr' "$OUT") rows)"
