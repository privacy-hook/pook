#!/usr/bin/env bash
# Step 1: Download Phase-1 PSE Perpetual Powers of Tau (power 14 = 16,384 constraints).
# Largest Pook circuit is `seat_fund` at 15,721 constraints (+1 public input = 15,722 <= 16,384).
set -euo pipefail

PTAU_URL="https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_14.ptau"
PTAU_NAME="ppot_0080_14.ptau"
DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    *) echo "Usage: $0 --dir <ceremony-dir>" >&2; exit 1 ;;
  esac
done
[[ -n "$DIR" ]] || { echo "Error: --dir is required" >&2; exit 1; }

mkdir -p "$DIR/ptau"
DEST="$DIR/ptau/$PTAU_NAME"

if [[ -f "$DEST" && -s "$DEST" ]]; then
  echo "Reusing existing $DEST"
else
  echo "Downloading $PTAU_URL -> $DEST ..."
  curl -fL --retry 3 -o "$DEST.tmp" "$PTAU_URL"
  mv "$DEST.tmp" "$DEST"
fi

SIZE="$(stat -c%s "$DEST")"
SHA="$(sha256sum "$DEST" | awk '{print $1}')"
echo "Phase-1 ptau ready: $DEST ($SIZE bytes, sha256=$SHA)"
