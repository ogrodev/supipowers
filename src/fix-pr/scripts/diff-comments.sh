#!/bin/bash
# Compares two JSONL comment snapshots, outputs only new/changed comments
# Usage: diff-comments.sh <prev_snapshot> <new_snapshot>
# Exit 0 if new comments found, exit 1 if identical
set -euo pipefail

PREV="$1"
NEW="$2"

# If no previous snapshot, all comments are new
if [[ ! -f "$PREV" ]]; then
  cat "$NEW"
  exit 0
fi

# Build fingerprint: id + updatedAt for each comment
prev_fingerprints=$(jq -r '[.id, .updatedAt] | @tsv' "$PREV" 2>/dev/null | sort)
new_fingerprints=$(jq -r '[.id, .updatedAt] | @tsv' "$NEW" 2>/dev/null | sort)

# Find IDs that are new or changed
new_ids=$(comm -13 <(echo "$prev_fingerprints") <(echo "$new_fingerprints") | cut -f1)

if [[ -z "$new_ids" ]]; then
  exit 1
fi

# Output the full comment objects for new/changed IDs
while IFS= read -r id; do
  [[ -z "$id" ]] && continue
  jq -c "select(.id == $id)" "$NEW"
done <<< "$new_ids"

exit 0
