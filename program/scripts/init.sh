#!/usr/bin/env bash
# Idempotent post-deploy initialization script for `pook`:
#   1. init_config (admin = deployer, fee_recipient = launch wallet, explicit run_fee_bps & author_share_bps)
#   2. Fund stage_pda rent reserve
#   3. Create missing launch wallet, stage_pda, and author-fees ATAs for launch payout mints
#   4. Register missing SPP SPL interfaces when `spl_interface_creation_is_permissionless` allows (else list them)
#   5. Publish all nine launch hooks from `program/hooks/*.json`
#   6. Merge chain-derived record into `program/deploy/<cluster>.json` (never stores RPC URL or keys)
set -euo pipefail

export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/pook-target}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN="$CARGO_TARGET_DIR/release/pook_init"

if [[ ! -x "$BIN" ]]; then
  echo "Building pook_init release binary..."
  cargo build --manifest-path "$WORKSPACE_DIR/Cargo.toml" -p pook-test --bin pook_init --release
fi

exec "$BIN" "$@"
