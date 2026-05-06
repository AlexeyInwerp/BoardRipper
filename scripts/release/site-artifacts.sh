#!/usr/bin/env bash
# Generates HTML site artifacts from repo markdown files.
# Called from release.sh: VERSION, RELEASED_AT, OUT_DIR set in env.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${OUT_DIR:-$REPO_ROOT/out}"
mkdir -p "$OUT/site"

# --- Landing page version-block templating ---
LANDING_SRC="$REPO_ROOT/landing/index.html"
LANDING_OUT="$OUT/site/index.html"
RELEASE_DATE="$(echo "$RELEASED_AT" | cut -d'T' -f1)"

awk -v ver="$VERSION" -v date="$RELEASE_DATE" '
  /<!-- BR_VERSION:START -->/ { print; in_block=1;
    print "  <p class=\"tagline\" style=\"margin-top:4px\"><span class=\"small\">Latest release: <b>" ver "</b> &mdash; released " date "</span></p>";
    next }
  /<!-- BR_VERSION:END -->/ { in_block=0; print; next }
  in_block { next }
  { print }
' "$LANDING_SRC" > "$LANDING_OUT"

# Render a Markdown file to a self-contained HTML page using a built-in
# sed+awk converter. Handles the BoardRipper CHANGELOG.md format:
# headings (#/##/###), bullet lists, fenced code blocks, blank-line
# paragraphs, inline `code`, **bold**, and [link](url) syntax. Anything
# more exotic (tables, images, nested lists deeper than one level)
# falls through as plain text — that's a deliberate scope cap.
md_to_html() {
  local title="$1"
  local md="$2"
  local out="$3"
  # Pass 1 (sed): inline transforms — code, bold, links.
  # Pass 2 (awk): block-level — headings, lists, fenced code, paragraphs.
  # Pass 1a (perl): escape <> inside backtick spans first — without this, a
  # CHANGELOG entry like `boardripper:<version>` ends up with the browser
  # interpreting <version> as an HTML tag and dropping the text. Using perl
  # because sed's regex doesn't support per-match callback substitution.
  perl -pe 's|`([^`]+)`|my $x=$1; $x =~ s/</\&lt;/g; $x =~ s/>/\&gt;/g; "<code>$x</code>"|ge' "$md" | \
  sed -E '
    s|\*\*([^*]+)\*\*|<strong>\1</strong>|g
    s|\[([^]]+)\]\(([^)]+)\)|<a href="\2">\1</a>|g
    s|<(https?://[^>]+)>|<a href="\1">\1</a>|g
  ' | awk '
    BEGIN { in_list = 0; in_code = 0 }
    /^```/ {
      if (in_list) { print "</ul>"; in_list = 0 }
      if (in_code) { print "</pre>"; in_code = 0 }
      else { print "<pre>"; in_code = 1 }
      next
    }
    in_code { print; next }
    /^### / { sub(/^### /, ""); if (in_list) { print "</ul>"; in_list = 0 } print "<h3>" $0 "</h3>"; next }
    /^## /  { sub(/^## /,  ""); if (in_list) { print "</ul>"; in_list = 0 } print "<h2>" $0 "</h2>"; next }
    /^# /   { sub(/^# /,   ""); if (in_list) { print "</ul>"; in_list = 0 } print "<h1>" $0 "</h1>"; next }
    /^- / {
      sub(/^- /, "")
      if (!in_list) { print "<ul>"; in_list = 1 }
      print "<li>" $0 "</li>"
      next
    }
    /^  - / {
      sub(/^  - /, "")
      print "<li style=\"margin-left:1em;list-style:circle\">" $0 "</li>"
      next
    }
    /^[[:space:]]*$/ {
      if (in_list) { print "</ul>"; in_list = 0 }
      print ""
      next
    }
    {
      if (in_list) { print "</ul>"; in_list = 0 }
      print "<p>" $0 "</p>"
    }
    END {
      if (in_list) print "</ul>"
      if (in_code) print "</pre>"
    }
  ' > /tmp/md-body-$$.html

  cat > "$out" <<HTML
<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<title>$title</title>
<style>
  body { font-family: Verdana, Geneva, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; line-height: 1.55; color: #000; background: #fff; }
  h1 { font-size: 1.6rem; margin-top: 0; }
  h2 { font-size: 1.25rem; margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #ccc; }
  h3 { font-size: 1.05rem; margin-top: 1.5rem; }
  p { margin: 0.6rem 0; }
  ul { margin: 0.4rem 0 0.8rem 1.4rem; padding: 0; }
  li { margin: 0.2rem 0; }
  code { background: #f4f4f4; padding: 1px 4px; border-radius: 3px; font-size: 0.9em; }
  pre { background: #f4f4f4; border: 1px solid #ddd; padding: 0.6rem 0.8rem; overflow-x: auto; font-size: 0.85rem; }
  pre code { background: none; padding: 0; }
  a { color: #0a58ca; }
  a:visited { color: #6f42c1; }
  hr { border: none; border-top: 1px solid #ccc; margin: 2rem 0; }
</style>
</head><body>
$(cat /tmp/md-body-$$.html)
<hr>
<p style="font-size:0.85em;color:#666">BoardRipper — <a href="/boardripper/">project page</a></p>
</body></html>
HTML
  rm -f /tmp/md-body-$$.html
}

# --- changelog.html ---
if [ -f "$REPO_ROOT/CHANGELOG.md" ]; then
  md_to_html "BoardRipper Changelog" "$REPO_ROOT/CHANGELOG.md" "$OUT/site/changelog.html"
else
  cat > "$OUT/site/changelog.html" <<EOF
<!DOCTYPE html><html><body><h1>BoardRipper changelog</h1>
<p>Changelog will be populated from CHANGELOG.md once it exists.</p></body></html>
EOF
fi

# --- third_party.html ---
if [ -f "$REPO_ROOT/THIRD_PARTY.md" ]; then
  md_to_html "BoardRipper third-party attributions" "$REPO_ROOT/THIRD_PARTY.md" "$OUT/site/third_party.html"
fi

# --- releases/ index page ---
mkdir -p "$OUT/site/releases"
cat > "$OUT/site/releases/index.html" <<EOF
<!DOCTYPE html><html><body><h1>BoardRipper releases</h1>
<p>Latest: <a href="boardripper-$VERSION.tar.gz">$VERSION</a> (released $RELEASE_DATE).</p>
<p>Manifest: <a href="../manifest.json">manifest.json</a> (signed).</p>
<p>For older versions, ask the maintainer.</p></body></html>
EOF

echo ">>> Site artifacts generated under $OUT/site/"
