#!/usr/bin/env bash
# Start/stop the ingester as a backgrounded loop.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$ROOT/data/ingester.pid"
LOG_FILE="$ROOT/data/ingester.log"

start() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "ingester already running, pid $(cat "$PID_FILE")"
    exit 0
  fi
  cd "$ROOT"
  # shellcheck disable=SC1090
  source "$HOME/.arc-canteen/env"
  mkdir -p "$ROOT/data"
  nohup bun run packages/ingester/src/index.ts --loop \
    >>"$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  echo "started, pid $(cat "$PID_FILE"), log: $LOG_FILE"
}

stop() {
  if [ ! -f "$PID_FILE" ]; then echo "not running"; exit 0; fi
  pid=$(cat "$PID_FILE")
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    echo "stopped pid $pid"
  else
    echo "stale pidfile, cleaning up"
  fi
  rm -f "$PID_FILE"
}

status() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    pid=$(cat "$PID_FILE")
    echo "running, pid $pid"
    echo "--- last 20 log lines ---"
    tail -n 20 "$LOG_FILE" 2>/dev/null || echo "(no log yet)"
  else
    echo "not running"
  fi
}

case "${1:-status}" in
  start) start ;;
  stop)  stop ;;
  restart) stop || true; sleep 1; start ;;
  status) status ;;
  *) echo "usage: $0 {start|stop|restart|status}"; exit 1 ;;
esac
