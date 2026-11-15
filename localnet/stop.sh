#!/usr/bin/env bash
# Stop ONLY the processes recorded by localnet/start.sh (never by name/pattern).
set -euo pipefail

PID_FILE="${POOK_LOCALNET_PID_FILE:-/tmp/pook-localnet.pids}"
LOG_DIR="${POOK_LOCALNET_LOG_DIR:-/tmp/pook-localnet-logs}"

if [[ ! -f "$PID_FILE" ]]; then
  echo "No PID file at $PID_FILE (localnet not running)."
  exit 0
fi

mapfile -t PIDS < "$PID_FILE"
for pid in "${PIDS[@]}"; do
  [[ "$pid" =~ ^[0-9]+$ ]] || continue
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
  fi
done

sleep 1

for pid in "${PIDS[@]}"; do
  [[ "$pid" =~ ^[0-9]+$ ]] || continue
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
done

rm -f "$PID_FILE"
rm -rf "$LOG_DIR"
rm -rf "/tmp/zolana-photon-${POOK_PHOTON_PORT:-20813}"
echo "Pook localnet stopped and scratch files removed."
