#!/usr/bin/env bash
# scripts/claude-issue-workflow.sh — Pick a GitHub issue and start a Claude Code session
set -euo pipefail

REPO="AlexeyInwerp/BoardRipper"

if [ -z "${1:-}" ]; then
  echo "Usage: $0 <issue-number>"
  echo ""
  echo "Open issues:"
  gh issue list --repo "$REPO" --state open --limit 20
  exit 0
fi

ISSUE_NUM="$1"

# Fetch issue details
echo "=== Fetching issue #${ISSUE_NUM} ==="
ISSUE_JSON=$(gh issue view "$ISSUE_NUM" --repo "$REPO" --json title,body,labels,assignees)
TITLE=$(echo "$ISSUE_JSON" | jq -r '.title')
BODY=$(echo "$ISSUE_JSON" | jq -r '.body')
LABELS=$(echo "$ISSUE_JSON" | jq -r '[.labels[].name] | join(", ")')

# Generate branch name
BRANCH="issue-${ISSUE_NUM}/$(echo "$TITLE" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-' | sed 's/^-//;s/-$//' | head -c 50)"

echo "Title:  $TITLE"
echo "Labels: $LABELS"
echo "Branch: $BRANCH"
echo ""

# Create branch
git checkout -b "$BRANCH" main 2>/dev/null || git checkout "$BRANCH"

echo "=== Branch ready: $BRANCH ==="
echo ""
echo "Start Claude Code with this context:"
echo "---"
echo "Implement GitHub issue #${ISSUE_NUM}: ${TITLE}"
echo ""
echo "${BODY}"
echo ""
echo "Labels: ${LABELS}"
echo "---"
echo ""
echo "When done, create PR with:"
echo "  gh pr create --title \"${TITLE}\" --body \"Fixes #${ISSUE_NUM}\""
