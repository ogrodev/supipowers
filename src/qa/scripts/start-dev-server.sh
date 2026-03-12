#!/usr/bin/env bash
# Start the dev server in the background and wait for it to be ready.
# Usage: start-dev-server.sh <cwd> <dev_command> <port> <timeout_seconds> <session_dir>
# Output: JSON on stdout
set -euo pipefail

CWD="$1"
DEV_COMMAND="$2"
PORT="$3"
TIMEOUT="${4:-60}"
SESSION_DIR="${5:-.}"

cd "$CWD"

# Check if port is already in use
if curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT" 2>/dev/null | grep -qE '^[0-9]'; then
  echo "{\"pid\": null, \"url\": \"http://localhost:$PORT\", \"ready\": true, \"note\": \"Server already running\"}"
  exit 0
fi

# Start dev server in background
eval "$DEV_COMMAND" > "$SESSION_DIR/dev-server.log" 2>&1 &
PID=$!
echo "$PID" > "$SESSION_DIR/dev-server.pid"

# Wait for server to be ready
for i in $(seq 1 "$TIMEOUT"); do
  # Check if process is still alive
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "{\"pid\": $PID, \"url\": \"http://localhost:$PORT\", \"ready\": false, \"error\": \"Server process exited\"}"
    exit 1
  fi

  # Check if port responds
  if curl -s -o /dev/null "http://localhost:$PORT" 2>/dev/null; then
    echo "{\"pid\": $PID, \"url\": \"http://localhost:$PORT\", \"ready\": true}"
    exit 0
  fi

  sleep 1
done

# Timeout — kill the server
kill "$PID" 2>/dev/null || true
echo "{\"pid\": $PID, \"url\": \"http://localhost:$PORT\", \"ready\": false, \"error\": \"Timeout after ${TIMEOUT}s\"}"
exit 1
