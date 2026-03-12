#!/usr/bin/env bash
# Stop the dev server started by start-dev-server.sh.
# Usage: stop-dev-server.sh <session_dir>
set -euo pipefail

SESSION_DIR="${1:-.}"
PID_FILE="$SESSION_DIR/dev-server.pid"

if [ ! -f "$PID_FILE" ]; then
  echo '{"stopped": false, "error": "No PID file found"}'
  exit 0
fi

PID=$(cat "$PID_FILE")

if [ -z "$PID" ]; then
  echo '{"stopped": false, "error": "Empty PID file"}'
  exit 0
fi

# Kill the process and its children
if kill -0 "$PID" 2>/dev/null; then
  # Kill process group if possible
  kill -- -"$PID" 2>/dev/null || kill "$PID" 2>/dev/null || true
  # Wait briefly for cleanup
  sleep 1
  # Force kill if still alive
  if kill -0 "$PID" 2>/dev/null; then
    kill -9 "$PID" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  echo "{\"stopped\": true, \"pid\": $PID}"
else
  rm -f "$PID_FILE"
  echo "{\"stopped\": true, \"pid\": $PID, \"note\": \"Process was already dead\"}"
fi
