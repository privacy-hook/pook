#!/usr/bin/env bash
# Step 4: Verify the full contribution chain and key consistency for all six circuits.
set -euo pipefail

export PATH="$HOME/pook-tools/bin:$HOME/.cargo/bin:$PATH"
XARK_BIN="${XARK_BIN:-$(command -v xark || echo "$HOME/pook-tools/bin/xark")}"
CIRCUITS=(run leave seat_open seat_fund seat_action seat_close)

DIR=""
PTAU=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --ptau) PTAU="$2"; shift 2 ;;
    *) echo "Usage: $0 --dir <ceremony-dir> [--ptau <ptau-file>]" >&2; exit 1 ;;
  esac
done
[[ -n "$DIR" ]] || { echo "Error: --dir is required" >&2; exit 1; }
[[ -n "$PTAU" ]] || PTAU="$DIR/ptau/ppot_0080_14.ptau"
[[ -f "$PTAU" ]] || { echo "Error: ptau file not found at $PTAU" >&2; exit 1; }

for c in "${CIRCUITS[@]}"; do
  echo "=== Verifying ceremony chain for $c ==="
  "$XARK_BIN" ceremony verify "$DIR/circuits/$c" --ceremony-dir "$DIR/work/$c" --ptau-file "$PTAU"
done

echo "All 6 circuit ceremony chains verified."
