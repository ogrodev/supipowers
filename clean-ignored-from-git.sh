#!/usr/bin/env bash
# ------------------------------------------------------------------
# clean-ignored-from-git.sh
#
# Finds files tracked by Git that match the current .gitignore rules
# and removes them from the index (--cached). The files stay on disk;
# only Git stops tracking them.
#
# Usage:
#   ./scripts/clean-ignored-from-git.sh          # dry-run (default)
#   ./scripts/clean-ignored-from-git.sh --apply   # actually remove
# ------------------------------------------------------------------
set -euo pipefail

APPLY=false
if [[ "${1:-}" == "--apply" ]]; then
	APPLY=true
fi

# Collect tracked files that should be ignored.
# -c  = cached (tracked)
# -i  = ignored
# --exclude-standard = honor .gitignore, .git/info/exclude, global excludes
FILES=()
while IFS= read -r -d '' file; do
	FILES+=("$file")
done < <(git ls-files -ci --exclude-standard -z)

if [[ ${#FILES[@]} -eq 0 ]]; then
	echo "Nothing to clean — no tracked files match .gitignore."
	exit 0
fi

COUNT=${#FILES[@]}

echo "Found $COUNT tracked file(s) matching .gitignore:"
echo ""
printf '  %s\n' "${FILES[@]}"
echo ""

if [[ "$APPLY" == false ]]; then
	echo "Dry run. Re-run with --apply to remove these from the Git index."
	echo "  ./scripts/clean-ignored-from-git.sh --apply"
	exit 0
fi

# Remove from index only (files stay on disk).
printf '%s\0' "${FILES[@]}" | xargs -0 git rm -r --cached --

echo ""
echo "Done. $COUNT file(s) removed from the Git index."
echo "They remain on disk but are now untracked."
echo ""
echo "Next steps:"
echo "  git status                  # review the changes"
echo "  git commit -m 'chore: remove files that should be gitignored'"
