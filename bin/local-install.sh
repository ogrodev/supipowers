#!/usr/bin/env bash
# Install supipowers locally from the current working tree.
# Usage:  ./bin/local-install.sh
#
# Creates a global symlink so `supipowers` CLI works, then runs the
# installer with --debug to deploy the extension and write a log file.
# Re-run after pulling new changes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "-> Installing supipowers locally from $PROJECT_DIR"

# 1. Install dependencies (fast no-op when lock is current)
echo "-> Installing dependencies..."
cd "$PROJECT_DIR"
bun install --frozen-lockfile 2>/dev/null || bun install

# 2. Create a global symlink via bun link
echo "-> Linking supipowers globally..."
bun link

# 3. Verify the link
if command -v supipowers &>/dev/null; then
  echo "[OK] 'supipowers' CLI is available at $(which supipowers)"
else
  echo "[WARN] CLI not on PATH -- you may need to add bun's global bin to \$PATH:"
  echo "  export PATH=\"\$HOME/.bun/bin:\$PATH\""
fi

# 4. Run the installer with --debug to deploy extension + write log
echo "-> Running installer (--debug mode)..."
bun run "$PROJECT_DIR/bin/install.ts" --debug --force

# 5. Show version and log location
VERSION=$(node -e "console.log(require('$PROJECT_DIR/package.json').version)")
echo ""
echo "[OK] supipowers v${VERSION} installed locally"
if [ -f "$PROJECT_DIR/supipowers-install.log" ]; then
  echo "  Debug log: $PROJECT_DIR/supipowers-install.log"
fi
