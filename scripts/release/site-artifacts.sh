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

# --- changelog.html ---
if command -v pandoc >/dev/null 2>&1 && [ -f "$REPO_ROOT/CHANGELOG.md" ]; then
  pandoc -f markdown -t html -s --metadata title="BoardRipper Changelog" \
    "$REPO_ROOT/CHANGELOG.md" -o "$OUT/site/changelog.html"
else
  cat > "$OUT/site/changelog.html" <<EOF
<!DOCTYPE html><html><body><h1>BoardRipper changelog</h1>
<p>Changelog will be populated from CHANGELOG.md once it exists.</p></body></html>
EOF
fi

# --- third_party.html ---
if command -v pandoc >/dev/null 2>&1 && [ -f "$REPO_ROOT/THIRD_PARTY.md" ]; then
  pandoc -f markdown -t html -s --metadata title="BoardRipper third-party attributions" \
    "$REPO_ROOT/THIRD_PARTY.md" -o "$OUT/site/third_party.html"
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
