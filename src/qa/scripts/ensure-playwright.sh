#!/usr/bin/env bash
# Check if playwright is installed, install if needed.
# Usage: ensure-playwright.sh <cwd>
# Output: JSON on stdout
set -euo pipefail

CWD="${1:-.}"
cd "$CWD"

installed=false
browsers="[]"

# Check if playwright is available
if npx playwright --version >/dev/null 2>&1; then
  installed=true
else
  # Try to install playwright
  if npm install --save-dev @playwright/test >/dev/null 2>&1; then
    installed=true
  else
    echo '{"installed": false, "browsers": [], "error": "Failed to install @playwright/test"}'
    exit 1
  fi
fi

# Install chromium browser if not present
if $installed; then
  if npx playwright install chromium >/dev/null 2>&1; then
    browsers='["chromium"]'
  else
    echo '{"installed": true, "browsers": [], "error": "Failed to install chromium browser"}'
    exit 1
  fi
fi

cat <<EOF
{"installed": $installed, "browsers": $browsers}
EOF
