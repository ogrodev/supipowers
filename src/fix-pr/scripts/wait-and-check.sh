#!/bin/bash
# Waits for delay, fetches new PR comments, diffs against previous snapshot
# Usage: wait-and-check.sh <session_dir> <delay_seconds> <iteration> <owner/repo> <pr_number>
# Output: new comment lines + JSON summary on last line
set -euo pipefail

SESSION_DIR="$1"
DELAY="$2"
ITERATION="$3"
REPO="$4"
PR="$5"

SNAPSHOTS_DIR="${SESSION_DIR}/snapshots"
PREV_ITERATION=$((ITERATION - 1))
PREV_SNAPSHOT="${SNAPSHOTS_DIR}/comments-${PREV_ITERATION}.jsonl"
NEW_SNAPSHOT="${SNAPSHOTS_DIR}/comments-${ITERATION}.jsonl"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Wait for reviewer to process
echo "Waiting ${DELAY}s for reviewer to process changes..." >&2
sleep "$DELAY"

# Fetch new comments
echo "Fetching PR comments (iteration ${ITERATION})..." >&2
bash "${SCRIPT_DIR}/fetch-pr-comments.sh" "$REPO" "$PR" "$NEW_SNAPSHOT"

# Diff against previous
DIFF_OUTPUT=$(bash "${SCRIPT_DIR}/diff-comments.sh" "$PREV_SNAPSHOT" "$NEW_SNAPSHOT" 2>/dev/null) || true

if [[ -n "$DIFF_OUTPUT" ]]; then
  DIFF_COUNT=$(echo "$DIFF_OUTPUT" | wc -l | tr -d ' ')
  echo "$DIFF_OUTPUT"
  echo "{\"hasNewComments\": true, \"count\": ${DIFF_COUNT}, \"iteration\": ${ITERATION}}"
else
  echo "{\"hasNewComments\": false, \"count\": 0, \"iteration\": ${ITERATION}}"
fi
