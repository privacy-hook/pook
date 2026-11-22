#!/usr/bin/env bash
# Build Pook Xark circuits, test keys, generated verifiers, WASM packages (web + node),
# and SBF program .so inside WSL using CARGO_TARGET_DIR=$HOME/pook-target.
set -euo pipefail

export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/pook-target}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ZOLANA_BIN="${ZOLANA_BIN:-$HOME/pook-tools/zolana}"

cd "$WORKSPACE_DIR"

# --keys <ceremony>/final: rebuild only the web + node WASM against the ceremony's keys.
# Verifiers, artifacts and the .so stay as 06-export-and-build.sh wrote them.
if [[ "${1:-}" == "--keys" ]]; then
  FINAL="${2:?usage: $0 --keys <ceremony>/final}"
  STAGE="$CARGO_TARGET_DIR/zk/pook-program-prod"
  rm -rf "$STAGE"; mkdir -p "$STAGE"
  cp -r "$CARGO_TARGET_DIR/zk/pook-program/." "$STAGE/"
  for c in run leave seat_open seat_fund seat_action seat_close; do
    cp -f "$FINAL/$c/"{circuit.xbc,pk.bin,vk.bin,digest,metadata.json} "$STAGE/$c/"
  done
  for t in web nodejs; do
    out="$WORKSPACE_DIR/wasm/$([[ "$t" == nodejs ]] && echo node || echo web)"
    "$ZOLANA_BIN" zk compile -p pook-program --manifest-path "$WORKSPACE_DIR/program/Cargo.toml" \
      --r1cs-out "$STAGE" --skip-r1cs --skip-keys --wasm-target "$t" --wasm-out "$out"
  done
  python3 - "$WORKSPACE_DIR" "$FINAL/trusted-keys.sha256" <<'PY'
import json, pathlib, sys
ws = pathlib.Path(sys.argv[1])
trusted = dict(reversed(l.split()) for l in pathlib.Path(sys.argv[2]).read_text().splitlines() if l.strip())
for d in ("web", "node"):
    for name, e in json.loads((ws / "wasm" / d / "proving-keys.json").read_text()).items():
        if bytes(e["provingKeySha256"]).hex() != trusted[f"{name}/pk.bin"] or e.get("insecureTestSetup"):
            raise SystemExit(f"{d}/{name}: proving key does not match {sys.argv[2]}")
print("WASM (web + node) built against the trusted keys")
PY
  exit 0
fi

echo "=== 1. Compiling Xark circuits, test keys, verifiers, and web WASM ==="
"$ZOLANA_BIN" zk compile \
  -p pook-program \
  --manifest-path "$WORKSPACE_DIR/program/Cargo.toml" \
  --test \
  --wasm-target web \
  --wasm-out "$WORKSPACE_DIR/wasm/web"

echo "=== 2. Building Node.js WASM package (reusing compiled R1CS & keys) ==="
"$ZOLANA_BIN" zk compile \
  -p pook-program \
  --manifest-path "$WORKSPACE_DIR/program/Cargo.toml" \
  --test \
  --skip-r1cs \
  --skip-keys \
  --wasm-target nodejs \
  --wasm-out "$WORKSPACE_DIR/wasm/node"

echo "=== 3. Checking generated verifiers ==="
"$ZOLANA_BIN" zk compile \
  -p pook-program \
  --manifest-path "$WORKSPACE_DIR/program/Cargo.toml" \
  --check

echo "=== 4. Copying circuit artifacts (circuit.xbc, pk.bin, vk.bin) and verifying pk.bin SHA-256 ==="
ARTIFACTS_DIR="$WORKSPACE_DIR/artifacts"
PROVING_KEYS_JSON="$WORKSPACE_DIR/wasm/web/proving-keys.json"
mkdir -p "$ARTIFACTS_DIR"

for circuit in run leave seat_open seat_fund seat_action seat_close; do
  SRC_DIR="$CARGO_TARGET_DIR/zk/pook-program/$circuit"
  DST_DIR="$ARTIFACTS_DIR/$circuit"
  mkdir -p "$DST_DIR"
  for f in circuit.xbc pk.bin vk.bin; do
    cp -f "$SRC_DIR/$f" "$DST_DIR/$f"
  done
done

python3 - "$ARTIFACTS_DIR" "$PROVING_KEYS_JSON" <<'PY'
import hashlib, json, pathlib, sys
artifacts = pathlib.Path(sys.argv[1])
manifest = json.loads(pathlib.Path(sys.argv[2]).read_text())
circuits = ["run", "leave", "seat_open", "seat_fund", "seat_action", "seat_close"]
for name in circuits:
    pk_path = artifacts / name / "pk.bin"
    actual = hashlib.sha256(pk_path.read_bytes()).hexdigest()
    entry = manifest.get(name)
    if not isinstance(entry, dict) or "provingKeySha256" not in entry:
        raise SystemExit(f"Missing provingKeySha256 for {name} in {sys.argv[2]}")
    raw_expected = entry["provingKeySha256"]
    expected = bytes(raw_expected).hex() if isinstance(raw_expected, list) else str(raw_expected)
    if actual != expected:
        raise SystemExit(f"SHA-256 mismatch for {name}/pk.bin: actual={actual} expected={expected}")
    print(f"  OK {name}/pk.bin sha256={actual[:16]}... ({pk_path.stat().st_size} B)")
PY

echo "=== Done with circuits, verifiers, WASM (web + node), and artifacts ==="
ls -la "$WORKSPACE_DIR/program/src/verifier"
ls -la "$WORKSPACE_DIR/wasm/web"
ls -la "$WORKSPACE_DIR/wasm/node"
ls -la "$ARTIFACTS_DIR"
