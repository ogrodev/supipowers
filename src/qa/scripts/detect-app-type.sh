#!/usr/bin/env bash
# Detect web app framework, dev command, and port.
# Usage: detect-app-type.sh <cwd>
# Output: JSON on stdout
set -euo pipefail

CWD="${1:-.}"

type="generic"
devCommand="npm run dev"
port=3000

# Check for Next.js
if [ -f "$CWD/next.config.js" ] || [ -f "$CWD/next.config.mjs" ] || [ -f "$CWD/next.config.ts" ]; then
  if [ -d "$CWD/app" ]; then
    type="nextjs-app"
  elif [ -d "$CWD/src/app" ]; then
    type="nextjs-app"
  elif [ -d "$CWD/pages" ] || [ -d "$CWD/src/pages" ]; then
    type="nextjs-pages"
  else
    type="nextjs-app"
  fi
  port=3000

# Check for Vite
elif [ -f "$CWD/vite.config.ts" ] || [ -f "$CWD/vite.config.js" ] || [ -f "$CWD/vite.config.mjs" ]; then
  type="vite"
  port=5173

# Check for Angular
elif [ -f "$CWD/angular.json" ]; then
  type="generic"
  devCommand="npm start"
  port=4200

# Check for Express (look for express in dependencies)
elif [ -f "$CWD/package.json" ]; then
  if grep -q '"express"' "$CWD/package.json" 2>/dev/null; then
    type="express"
    port=3000
  fi
fi

# Try to detect dev command from package.json scripts
if [ -f "$CWD/package.json" ]; then
  # Check for common dev script names
  if node -e "const p=JSON.parse(require('fs').readFileSync('$CWD/package.json','utf8')); process.exit(p.scripts?.dev ? 0 : 1)" 2>/dev/null; then
    devCommand="npm run dev"
  elif node -e "const p=JSON.parse(require('fs').readFileSync('$CWD/package.json','utf8')); process.exit(p.scripts?.start ? 0 : 1)" 2>/dev/null; then
    devCommand="npm start"
  elif node -e "const p=JSON.parse(require('fs').readFileSync('$CWD/package.json','utf8')); process.exit(p.scripts?.serve ? 0 : 1)" 2>/dev/null; then
    devCommand="npm run serve"
  fi

  # Try to detect port from scripts
  devScript=$(node -e "const p=JSON.parse(require('fs').readFileSync('$CWD/package.json','utf8')); console.log(p.scripts?.dev || p.scripts?.start || '')" 2>/dev/null || echo "")
  portMatch=$(echo "$devScript" | grep -oE '(--port|PORT=)\s*([0-9]+)' | grep -oE '[0-9]+' | head -1 || echo "")
  if [ -n "$portMatch" ]; then
    port="$portMatch"
  fi
fi

baseUrl="http://localhost:$port"

cat <<EOF
{"type": "$type", "devCommand": "$devCommand", "port": $port, "baseUrl": "$baseUrl"}
EOF
