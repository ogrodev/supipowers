#!/usr/bin/env bash
# Install supipowers locally from the current working tree.
# Usage:  ./bin/local-install.sh
#
# This creates a global symlink so both the `supipowers` CLI and
# the Pi/OMP extension resolve to your local source — no publish needed.
# Re-run after pulling new changes; the symlink stays valid.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "→ Installing supipowers locally from $PROJECT_DIR"

# 1. Install dependencies (fast no-op when lock is current)
echo "→ Installing dependencies…"
cd "$PROJECT_DIR"
bun install --frozen-lockfile 2>/dev/null || bun install

# 2. Create a global symlink via bun link
#    This registers the package globally so `supipowers` CLI works
#    and Pi/OMP can resolve it by name.
echo "→ Linking supipowers globally…"
bun link

# 3. Verify the link
if command -v supipowers &>/dev/null; then
  echo "✓ 'supipowers' CLI is available at $(which supipowers)"
else
  echo "⚠ CLI not on PATH — you may need to add bun's global bin to \$PATH:"
  echo "  export PATH=\"\$HOME/.bun/bin:\$PATH\""
fi

# 4. Show version
VERSION=$(node -e "console.log(require('$PROJECT_DIR/package.json').version)")
echo ""
echo "✓ supipowers v${VERSION} installed locally (linked to $PROJECT_DIR)"
echo "  Any edits to src/ or skills/ take effect immediately — no rebuild needed."
