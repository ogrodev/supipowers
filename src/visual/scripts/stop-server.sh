#!/bin/bash
# Stop the visual companion server
# Usage: stop-server.sh <screen_dir>

SCREEN_DIR="$1"

if [[ -z "$SCREEN_DIR" ]]; then
  echo '{"error": "Usage: stop-server.sh <screen_dir>"}'
  exit 1
fi

PID_FILE="${SCREEN_DIR}/.server.pid"

if [[ -f "$PID_FILE" ]]; then
  pid=$(cat "$PID_FILE")
  kill "$pid" 2>/dev/null
  rm -f "$PID_FILE" "${SCREEN_DIR}/.server.log"
  echo '{"status": "stopped"}'
else
  echo '{"status": "not_running"}'
fi
