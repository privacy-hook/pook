#!/usr/bin/env bash
# Step 6: Export production verifiers via `zolana zk export-verifier`, copy finalized artifacts,
# build the production SBF `.so` WITHOUT `insecure-test-setup`, and verify with `zolana vks check`.
set -euo pipefail

export PATH="$HOME/pook-tools/bin:$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/pook-target}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ZOLANA_BIN="${ZOLANA_BIN:-$HOME/pook-tools/zolana}"
CIRCUITS=(run leave seat_open seat_fund seat_action seat_close)

DIR=""
SBF_OUT="$WORKSPACE_DIR/deploy"
INSTALL_ARTIFACTS=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --sbf-out) SBF_OUT="$2"; shift 2 ;;
    --no-install-artifacts) INSTALL_ARTIFACTS=0; shift ;;
    *) echo "Usage: $0 --dir <ceremony-dir> [--sbf-out <dir>] [--no-install-artifacts]" >&2; exit 1 ;;
  esac
done
[[ -n "$DIR" ]] || { echo "Error: --dir is required" >&2; exit 1; }

FINAL="$DIR/final"
CHECKSUMS="$FINAL/trusted-keys.sha256"
[[ -f "$CHECKSUMS" ]] || { echo "Error: $CHECKSUMS missing; run 05-finalize.sh first" >&2; exit 1; }

echo "=== 1. Exporting production verifiers via zolana zk export-verifier ==="
"$ZOLANA_BIN" zk export-verifier \
  -p pook-program \
  --manifest-path "$WORKSPACE_DIR/program/Cargo.toml" \
  --out "$FINAL" \
  --checksums "$CHECKSUMS"

if [[ "$INSTALL_ARTIFACTS" == "1" ]]; then
  echo "=== 2. Copying production circuit artifacts and trusted-keys.sha256 ==="
  mkdir -p "$WORKSPACE_DIR/artifacts" "$SBF_OUT"
  for c in "${CIRCUITS[@]}"; do
    mkdir -p "$WORKSPACE_DIR/artifacts/$c"
    cp -f "$FINAL/$c/circuit.xbc" "$WORKSPACE_DIR/artifacts/$c/circuit.xbc"
    cp -f "$FINAL/$c/pk.bin" "$WORKSPACE_DIR/artifacts/$c/pk.bin"
    cp -f "$FINAL/$c/vk.bin" "$WORKSPACE_DIR/artifacts/$c/vk.bin"
  done
  cp -f "$CHECKSUMS" "$SBF_OUT/trusted-keys.sha256"
fi

echo "=== 3. Building production pook_program.so WITHOUT insecure-test-setup ==="
mkdir -p "$SBF_OUT"
WIN_BUILD_SBF=""
if command -v wslpath >/dev/null 2>&1; then
  if command -v cargo-build-sbf.exe >/dev/null 2>&1; then
    WIN_BUILD_SBF="cargo-build-sbf.exe"
  elif command -v cmd.exe >/dev/null 2>&1; then
    WIN_BUILD_SBF="$(cmd.exe /c where cargo-build-sbf 2>/dev/null | tr -d '\r' | head -n 1 || true)"
    [[ -n "$WIN_BUILD_SBF" ]] && WIN_BUILD_SBF="$(wslpath -u "$WIN_BUILD_SBF")"
  fi
fi

if [[ -n "$WIN_BUILD_SBF" ]]; then
  WIN_MANIFEST="$(wslpath -w "$WORKSPACE_DIR/program/Cargo.toml")"
  STAGE_DIR="$WORKSPACE_DIR/deploy/.tmp-sbf-$$"
  mkdir -p "$STAGE_DIR"
  trap 'rm -rf "$STAGE_DIR"' EXIT
  WIN_STAGE="$(wslpath -w "$STAGE_DIR")"
  "$WIN_BUILD_SBF" --arch v0 \
    --manifest-path "$WIN_MANIFEST" \
    --sbf-out-dir "$WIN_STAGE" \
    -- --no-default-features --features bpf-entrypoint
  cp -f "$STAGE_DIR/pook_program.so" "$SBF_OUT/pook_program.so"
  rm -rf "$STAGE_DIR"
  trap - EXIT
else
  cargo-build-sbf --arch v0 \
    --manifest-path "$WORKSPACE_DIR/program/Cargo.toml" \
    --sbf-out-dir "$SBF_OUT" \
    -- --no-default-features --features bpf-entrypoint
fi

SO_PATH="$SBF_OUT/pook_program.so"
echo "=== 4. Verifying production .so with zolana vks check ==="
"$ZOLANA_BIN" vks check --so "$SO_PATH" --expect "$CHECKSUMS"

echo "Production .so ready and verified: $SO_PATH ($(stat -c%s "$SO_PATH") bytes)"
