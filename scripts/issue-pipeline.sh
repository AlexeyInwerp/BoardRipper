#!/usr/bin/env bash
# scripts/issue-pipeline.sh — Retrieve and categorize GitHub issues for planning
set -euo pipefail

REPO="AlexeyInwerp/BoardRipper"

echo "=== BoardRipper Issue Pipeline ==="
echo "Date: $(date -u +%Y-%m-%d)"
echo ""

# --- Critical bugs (P0) ---
echo "## P0 — Critical Bugs (crashes, data loss)"
gh issue list --repo "$REPO" --label "P0-critical" --state open --json number,title,labels,createdAt \
  --template '{{range .}}#{{.number}} {{.title}} ({{timeago .createdAt}}){{"\n"}}{{end}}'
echo ""

# --- High priority bugs ---
echo "## P1 — High Priority Bugs"
gh issue list --repo "$REPO" --label "P1-high" --state open --json number,title,labels,createdAt \
  --template '{{range .}}#{{.number}} {{.title}} ({{timeago .createdAt}}){{"\n"}}{{end}}'
echo ""

# --- Regressions ---
echo "## Regressions (previously working)"
gh issue list --repo "$REPO" --label "regression" --state open --json number,title,createdAt \
  --template '{{range .}}#{{.number}} {{.title}} ({{timeago .createdAt}}){{"\n"}}{{end}}'
echo ""

# --- Feature requests by area ---
echo "## Feature Requests by Component"
for comp in renderer pdf parser library backend ui desktop; do
  count=$(gh issue list --repo "$REPO" --label "comp:$comp,enhancement" --state open --json number | jq length 2>/dev/null || echo 0)
  if [ "$count" -gt 0 ]; then
    echo ""
    echo "### comp:$comp ($count open)"
    gh issue list --repo "$REPO" --label "comp:$comp,enhancement" --state open --json number,title,createdAt \
      --template '{{range .}}  #{{.number}} {{.title}} ({{timeago .createdAt}}){{"\n"}}{{end}}'
  fi
done
echo ""

# --- New format requests ---
echo "## New Format Requests"
gh issue list --repo "$REPO" --label "new-format" --state open --json number,title,createdAt \
  --template '{{range .}}#{{.number}} {{.title}} ({{timeago .createdAt}}){{"\n"}}{{end}}'
echo ""

# --- Good first issues ---
echo "## Good First Issues (for contributors)"
gh issue list --repo "$REPO" --label "good-first-issue" --state open --json number,title,createdAt \
  --template '{{range .}}#{{.number}} {{.title}} ({{timeago .createdAt}}){{"\n"}}{{end}}'
echo ""

# --- Recently closed (last 30 days) ---
echo "## Recently Closed (velocity check)"
gh issue list --repo "$REPO" --state closed --limit 20 --json number,title,closedAt,labels \
  --template '{{range .}}#{{.number}} {{.title}} (closed {{timeago .closedAt}}){{"\n"}}{{end}}'
echo ""

# --- Summary stats ---
OPEN=$(gh issue list --repo "$REPO" --state open --json number | jq length)
CLOSED=$(gh issue list --repo "$REPO" --state closed --json number | jq length)
echo "## Summary"
echo "Open: $OPEN | Closed: $CLOSED | Total: $((OPEN + CLOSED))"
