#!/bin/bash
# Triggers automated reviewer to re-review a PR
# Usage: trigger-review.sh <owner/repo> <pr_number> <reviewer_type> <trigger_method>
set -euo pipefail

REPO="$1"
PR="$2"
REVIEWER="$3"
METHOD="${4:-}"

case "$REVIEWER" in
  coderabbit)
    gh api "repos/${REPO}/issues/${PR}/comments" -f body="$METHOD" >/dev/null 2>&1
    echo '{"triggered": true, "reviewer": "coderabbit"}'
    ;;
  copilot)
    if [[ -n "$METHOD" ]]; then
      gh api "repos/${REPO}/issues/${PR}/comments" -f body="$METHOD" >/dev/null 2>&1
    else
      gh api "repos/${REPO}/pulls/${PR}/requested_reviewers" \
        --method POST -f "reviewers[]=copilot" >/dev/null 2>&1 || true
    fi
    echo '{"triggered": true, "reviewer": "copilot"}'
    ;;
  gemini)
    gh api "repos/${REPO}/issues/${PR}/comments" -f body="$METHOD" >/dev/null 2>&1
    echo '{"triggered": true, "reviewer": "gemini"}'
    ;;
  none)
    echo '{"triggered": false, "reviewer": "none"}'
    ;;
  *)
    echo '{"triggered": false, "error": "unknown reviewer type: '"$REVIEWER"'"}'
    exit 1
    ;;
esac
