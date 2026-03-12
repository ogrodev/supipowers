#!/bin/bash
# Start the visual companion server and output connection info
# Usage: start-server.sh [--host <bind-host>] [--url-host <display-host>] [--foreground]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Parse arguments
FOREGROUND="false"
BIND_HOST="127.0.0.1"
URL_HOST=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      BIND_HOST="$2"
      shift 2
      ;;
    --url-host)
      URL_HOST="$2"
      shift 2
      ;;
    --foreground|--no-daemon)
      FOREGROUND="true"
      shift
      ;;
    *)
      echo "{\"error\": \"Unknown argument: $1\"}"
      exit 1
      ;;
  esac
done

if [[ -z "$URL_HOST" ]]; then
  if [[ "$BIND_HOST" == "127.0.0.1" || "$BIND_HOST" == "localhost" ]]; then
    URL_HOST="localhost"
  else
    URL_HOST="$BIND_HOST"
  fi
fi

# Session dir must be set via environment
SCREEN_DIR="${SUPI_VISUAL_DIR}"
if [[ -z "$SCREEN_DIR" ]]; then
  echo '{"error": "SUPI_VISUAL_DIR environment variable not set"}'
  exit 1
fi

PID_FILE="${SCREEN_DIR}/.server.pid"
LOG_FILE="${SCREEN_DIR}/.server.log"

# Create session directory if needed
mkdir -p "$SCREEN_DIR"

# Kill any existing server for this session
if [[ -f "$PID_FILE" ]]; then
  old_pid=$(cat "$PID_FILE")
  kill "$old_pid" 2>/dev/null
  rm -f "$PID_FILE"
fi

cd "$SCRIPT_DIR"

# Foreground mode
if [[ "$FOREGROUND" == "true" ]]; then
  echo "$$" > "$PID_FILE"
  env SUPI_VISUAL_DIR="$SCREEN_DIR" SUPI_VISUAL_HOST="$BIND_HOST" SUPI_VISUAL_URL_HOST="$URL_HOST" node index.js
  exit $?
fi

# Background mode
nohup env SUPI_VISUAL_DIR="$SCREEN_DIR" SUPI_VISUAL_HOST="$BIND_HOST" SUPI_VISUAL_URL_HOST="$URL_HOST" node index.js > "$LOG_FILE" 2>&1 &
SERVER_PID=$!
disown "$SERVER_PID" 2>/dev/null
echo "$SERVER_PID" > "$PID_FILE"

# Wait for server-started message
for i in {1..50}; do
  if grep -q "server-started" "$LOG_FILE" 2>/dev/null; then
    # Verify server is still alive
    alive="true"
    for _ in {1..20}; do
      if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        alive="false"
        break
      fi
      sleep 0.1
    done
    if [[ "$alive" != "true" ]]; then
      echo "{\"error\": \"Server started but was killed. Retry with --foreground\"}"
      exit 1
    fi
    grep "server-started" "$LOG_FILE" | head -1
    exit 0
  fi
  sleep 0.1
done

echo '{"error": "Server failed to start within 5 seconds"}'
exit 1
