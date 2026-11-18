#!/usr/bin/env bash
# Step 2: Compile R1CS for all six Pook circuits (if needed) and initialize phase-2 ceremony.
set -euo pipefail

export PATH="$HOME/pook-tools/bin:$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/pook-target}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ZOLANA_BIN="${ZOLANA_BIN:-$HOME/pook-tools/zolana}"
XARK_BIN="${XARK_BIN:-$(command -v xark || echo "$HOME/pook-tools/bin/xark")}"
CIRCUITS=(run leave seat_open seat_fund seat_action seat_close)

DIR=""
SEED=""
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --seed) SEED="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) echo "Usage: $0 --dir <ceremony-dir> [--seed <64-hex>] [--force]" >&2; exit 1 ;;
  esac
done
[[ -n "$DIR" ]] || { echo "Error: --dir is required" >&2; exit 1; }

PTAU="$DIR/ptau/ppot_0080_14.ptau"
[[ -f "$PTAU" ]] || { echo "Error: $PTAU missing; run 01-fetch-ptau.sh first" >&2; exit 1; }

ZK_DIR="$CARGO_TARGET_DIR/zk/pook-program"
if [[ ! -f "$ZK_DIR/programs.json" || ! -f "$ZK_DIR/seat_fund/circuit.xbc" ]]; then
  echo "Compiling R1CS for pook-program circuits..."
  "$ZOLANA_BIN" zk compile \
    -p pook-program \
    --manifest-path "$WORKSPACE_DIR/program/Cargo.toml" \
    --skip-keys \
    --skip-wasm
fi

mkdir -p "$DIR/circuits" "$DIR/work"
cp -f "$ZK_DIR/programs.json" "$DIR/circuits/programs.json"

for c in "${CIRCUITS[@]}"; do
  mkdir -p "$DIR/circuits/$c"
  cp -f "$ZK_DIR/$c/circuit.xbc" "$DIR/circuits/$c/circuit.xbc"
  cp -f "$ZK_DIR/$c/digest" "$DIR/circuits/$c/digest"
  ARGS=(ceremony init "$DIR/circuits/$c" --ptau-file "$PTAU" --out "$DIR/work/$c")
  [[ -n "$SEED" ]] && ARGS+=(--phase2-seed "$SEED")
  [[ "$FORCE" == "1" ]] && ARGS+=(--force)
  echo "=== Initializing phase-2 ceremony for $c ==="
  "$XARK_BIN" "${ARGS[@]}"
done

echo "Ceremony initialized for all 6 circuits under $DIR/work/"
