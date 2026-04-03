#!/bin/bash
# Fetches all review comments for a PR, outputs JSONL
# Usage: fetch-pr-comments.sh <owner/repo> <pr_number> <output_file>
set -euo pipefail

REPO="$1"
PR="$2"
OUTPUT="$3"

# Ensure output directory exists
mkdir -p "$(dirname "$OUTPUT")"

# Fetch inline review comments (code-level)
gh api --paginate "repos/${REPO}/pulls/${PR}/comments" \
  --jq '.[] | {id, path, line: .line, body, user: .user.login, userType: .user.type, createdAt: .created_at, updatedAt: .updated_at, inReplyToId: .in_reply_to_id, diffHunk: .diff_hunk, state: "COMMENTED"}' \
  > "$OUTPUT" 2>/dev/null || true

# Fetch review-level comments (top-level reviews with body text)
gh api --paginate "repos/${REPO}/pulls/${PR}/reviews" \
  --jq '.[] | select(.body != null and .body != "") | {id, path: null, line: null, body, user: .user.login, userType: .user.type, createdAt: .submitted_at, updatedAt: .submitted_at, inReplyToId: null, diffHunk: null, state}' \
  >> "$OUTPUT" 2>/dev/null || true

# Output summary to stderr for caller
TOTAL=$(wc -l < "$OUTPUT" | tr -d ' ')
echo "{\"total\": ${TOTAL}}" >&2
