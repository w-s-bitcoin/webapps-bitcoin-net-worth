#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
PORT="${PORT:-8081}"
HOST="127.0.0.1"
URL="http://${HOST}:${PORT}/"
IDLE_TIMEOUT="${IDLE_TIMEOUT:-180}"

cd "$SCRIPT_DIR"

if command -v python3 >/dev/null 2>&1; then
  PYTHON=python3
elif command -v python >/dev/null 2>&1; then
  PYTHON=python
else
  echo "Python was not found. Install Python 3 and retry."
  read -r -p "Press Enter to close..." _
  exit 1
fi

echo "Starting Bitcoin Net Worth Tracker on ${URL}"

API_URL="${URL}api/live-history/files"

if command -v curl >/dev/null 2>&1 && curl -fsS "$API_URL" >/dev/null 2>&1; then
  echo "Tracker server is already running. Opening app..."
  open "$URL" >/dev/null 2>&1 || true
  exit 0
fi

"$PYTHON" "$SCRIPT_DIR/standalone_server.py" --host "$HOST" --port "$PORT" --root "$SCRIPT_DIR" --idle-timeout "$IDLE_TIMEOUT" &
SERVER_PID=$!

cleanup() {
  if kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

echo "Waiting for server to be ready..."
READY=0
if command -v curl >/dev/null 2>&1; then
  for _ in {1..80}; do
    if curl -fsS "$API_URL" >/dev/null 2>&1; then
      READY=1
      break
    fi
    sleep 0.1
  done
else
  # Fallback when curl is unavailable; server usually starts quickly.
  sleep 0.8
  READY=1
fi

if [[ "$READY" -eq 1 ]]; then
  open "$URL" >/dev/null 2>&1 || true
else
  echo "Server did not become ready in time."
fi

wait "$SERVER_PID"
