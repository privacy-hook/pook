#!/usr/bin/env bash
# Step 3: Apply one contributor's randomness across all six circuits.
# Run once per independent contributor (minimum two contributors required before finalize).
set -euo pipefail

export PATH="$HOME/pook-tools/bin:$HOME/.cargo/bin:$PATH"
XARK_BIN="${XARK_BIN:-$(command -v xark || echo "$HOME/pook-tools/bin/xark")}"
CIRCUITS=(run leave seat_open seat_fund seat_action seat_close)

DIR=""
NAME=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    *) echo "Usage: $0 --dir <ceremony-dir> --name <contributor-label>" >&2; exit 1 ;;
  esac
done
[[ -n "$DIR" ]] || { echo "Error: --dir is required" >&2; exit 1; }
[[ -n "$NAME" ]] || { echo "Error: --name is required" >&2; exit 1; }

for c in "${CIRCUITS[@]}"; do
  echo "=== Contributing to $c as '$NAME' ==="
  "$XARK_BIN" ceremony contribute --ceremony-dir "$DIR/work/$c" --label "$NAME"
done

echo "Contribution '$NAME' recorded for all 6 circuits."
