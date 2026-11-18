#!/usr/bin/env bash
# Step 5: Finalize the ceremony with a public beacon, stage finalized keys,
# and write `trusted-keys.sha256` for `zolana zk export-verifier`.
set -euo pipefail

export PATH="$HOME/pook-tools/bin:$HOME/.cargo/bin:$PATH"
XARK_BIN="${XARK_BIN:-$(command -v xark || echo "$HOME/pook-tools/bin/xark")}"
CIRCUITS=(run leave seat_open seat_fund seat_action seat_close)

DIR=""
BEACON=""
BEACON_SOURCE="public-beacon"
PTAU=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --beacon) BEACON="$2"; shift 2 ;;
    --beacon-source) BEACON_SOURCE="$2"; shift 2 ;;
    --ptau) PTAU="$2"; shift 2 ;;
    *) echo "Usage: $0 --dir <ceremony-dir> --beacon <64-hex> [--beacon-source <desc>] [--ptau <ptau-file>]" >&2; exit 1 ;;
  esac
done
[[ -n "$DIR" ]] || { echo "Error: --dir is required" >&2; exit 1; }
[[ -n "$BEACON" ]] || { echo "Error: --beacon <64-hex> is required" >&2; exit 1; }
BEACON_CLEAN="${BEACON#0x}"
if [[ ! "$BEACON_CLEAN" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo "Error: --beacon must be 64 hex characters (32 bytes)" >&2
  exit 1
fi
[[ -n "$PTAU" ]] || PTAU="$DIR/ptau/ppot_0080_14.ptau"
[[ -f "$PTAU" ]] || { echo "Error: ptau file not found at $PTAU" >&2; exit 1; }

# Enforce at least 2 independent contributors before beacon finalization.
for c in "${CIRCUITS[@]}"; do
  COUNT="$(tr -d '[:space:]' < "$DIR/work/$c/contribution_count")"
  if [[ "$COUNT" -lt 2 ]]; then
    echo "Error: circuit '$c' has only $COUNT contribution(s); at least 2 independent contributors are required before finalize" >&2
    exit 1
  fi
done

BEACON_LABEL="beacon:${BEACON_SOURCE}:${BEACON_CLEAN:0:16}"
for c in "${CIRCUITS[@]}"; do
  echo "=== Applying public beacon contribution and finalizing $c ==="
  "$XARK_BIN" ceremony contribute --ceremony-dir "$DIR/work/$c" --label "$BEACON_LABEL"
  "$XARK_BIN" ceremony finalize "$DIR/circuits/$c" --ceremony-dir "$DIR/work/$c" --ptau-file "$PTAU"
done

# Stage finalized artifacts in the exact layout `zolana zk export-verifier` expects.
FINAL="$DIR/final"
rm -rf "$FINAL"
mkdir -p "$FINAL"
cp -f "$DIR/circuits/programs.json" "$FINAL/programs.json"

for c in "${CIRCUITS[@]}"; do
  mkdir -p "$FINAL/$c"
  cp -f "$DIR/circuits/$c/circuit.xbc" "$FINAL/$c/circuit.xbc"
  cp -f "$DIR/circuits/$c/digest" "$FINAL/$c/digest"
  cp -f "$DIR/work/$c/proving_key.bin" "$FINAL/$c/pk.bin"
  cp -f "$DIR/work/$c/verifying_key.bin" "$FINAL/$c/vk.bin"
  cp -f "$DIR/work/$c/metadata.json" "$FINAL/$c/metadata.json"
done

# Write trusted-keys.sha256 pinning every circuit's vk.bin, pk.bin, and metadata.json.
(
  cd "$FINAL"
  : > trusted-keys.sha256
  for c in "${CIRCUITS[@]}"; do
    sha256sum "$c/metadata.json" "$c/pk.bin" "$c/vk.bin" >> trusted-keys.sha256
  done
)

# Record beacon attestation metadata.
cat > "$FINAL/beacon.json" <<EOF
{
  "beacon": "$BEACON_CLEAN",
  "source": "$BEACON_SOURCE",
  "label": "$BEACON_LABEL",
  "finalized_at_utc": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "ptau": "$(basename "$PTAU")",
  "ptau_sha256": "$(sha256sum "$PTAU" | awk '{print $1}')"
}
EOF

echo "Finalized artifacts and checksum manifest written to $FINAL/trusted-keys.sha256"
cat "$FINAL/trusted-keys.sha256"
