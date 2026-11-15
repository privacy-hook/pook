#!/usr/bin/env bash
# Start the Pook Rings localnet (surfpool offline + Rings prover + Photon indexer)
# with cached Rings artifacts, captured mainnet programs/accounts, and the pook program.
#
# Ports (all bound to 127.0.0.1):
#   20820: validator RPC
#   20821: validator WebSocket
#   20813: Photon indexer
#   20814: Rings prover
#
# Keeps this process alive in the foreground so WSL stays running while tests execute.
# Stop via localnet/stop.sh (kills only the recorded PIDs).
set -euo pipefail

export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

NO_POOK="${POOK_NO_POOK:-0}"
for arg in "$@"; do
  case "$arg" in
    --no-pook) NO_POOK=1 ;;
    *) echo "Unknown arg: $arg (supported: --no-pook)" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ZOLANA_BIN="${ZOLANA_BIN:-$HOME/pook-tools/zolana}"
ZOLANA_CACHE="${ZOLANA_CACHE:-$HOME/.config/zolana/cache}"

export SURFPOOL_BIN="${SURFPOOL_BIN:-$ZOLANA_CACHE/cli-v0.10.0/surfpool/surfpool}"
export PROVER_BIN="${PROVER_BIN:-$ZOLANA_CACHE/cli-v0.10.0/prover-linux-x64-cli-v0.10.0}"
export ZOLANA_PHOTON_BIN="${ZOLANA_PHOTON_BIN:-$ZOLANA_CACHE/cli-v0.10.0/photon-linux-x64-cli-v0.10.0}"
export ZOLANA_PROVER_AUTO_DOWNLOAD="${ZOLANA_PROVER_AUTO_DOWNLOAD:-true}"

RPC_PORT="${POOK_RPC_PORT:-20820}"
PHOTON_PORT="${POOK_PHOTON_PORT:-20813}"
PROVER_PORT="${POOK_PROVER_PORT:-20814}"
LOG_DIR="${POOK_LOCALNET_LOG_DIR:-/tmp/pook-localnet-logs}"
PID_FILE="${POOK_LOCALNET_PID_FILE:-/tmp/pook-localnet.pids}"
POOK_SO="${POOK_PROGRAM_SO:-$REPO_ROOT/program/deploy/pook_program.so}"
POOK_ID="7qvNkZjiikySgCNbr8jbWbUziVka3Rw1NLwcxwmwwRwd"
SPP_ID="ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW"
SPP_SO="$ZOLANA_CACHE/shielded-pool-v1.0.0/shielded_pool_program.so"
SQUADS_ID="SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf"
SQUADS_SO="$ZOLANA_CACHE/cli-v0.10.0/squads_smart_account_program-cli-v0.10.0.so"
SPP_ACCOUNTS="$ZOLANA_CACHE/cli-v0.10.0/accounts"
DUMMY_AUTHORITY="11111111111111111111111111111111"

mkdir -p "$LOG_DIR"
rm -f "$PID_FILE"

ARGS=(
  dev start
  --local
  --rpc-port "$RPC_PORT"
  --photon-port "$PHOTON_PORT"
  --prover-port "$PROVER_PORT"
  --gossip-host 127.0.0.1
  --log-dir "$LOG_DIR"
  --sbf-program "$SPP_ID" "$SPP_SO"
  --account-dir "$SPP_ACCOUNTS"
  --account-dir "$SCRIPT_DIR/accounts"
)

if [[ -f "$SQUADS_SO" ]]; then
  ARGS+=(--sbf-program "$SQUADS_ID" "$SQUADS_SO")
fi

# Rings user registry (wallet -> shielded address records): Rings registration and leave-by-wallet.
USER_REGISTRY_ID="regy3WAeRXMYuMYxr5iK3Bf9Arr3PcxGxyzAddbiqDQ"
USER_REGISTRY_SO="$HOME/.config/zolana/cache/user-registry-v1.0.0/spr_user_registry.so"
if [[ -f "$USER_REGISTRY_SO" ]]; then
  ARGS+=(--sbf-program "$USER_REGISTRY_ID" "$USER_REGISTRY_SO")
fi

# Load pook program (skipped when --no-pook is passed for deploy rehearsals)
if [[ "$NO_POOK" == "1" ]]; then
  echo "Starting localnet WITHOUT preloaded pook program (--no-pook)"
  POOK_SKIP_SETUP=1
elif [[ -f "$POOK_SO" ]]; then
  ARGS+=(--sbf-program "$POOK_ID" "$POOK_SO")
else
  echo "Warning: $POOK_SO not found; starting localnet without pook program" >&2
fi

# Load captured mainnet venue & protocol programs
for so_file in "$SCRIPT_DIR"/programs/*.so; do
  [[ -f "$so_file" ]] || continue
  addr="$(basename "$so_file" .so)"
  case "$addr" in
    TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA|TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb|ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL)
      if [[ "${POOK_OVERRIDE_SPL:-0}" == "1" ]]; then
        ARGS+=(--upgradeable-program "$addr" "$so_file" "$DUMMY_AUTHORITY")
      fi
      ;;
    *)
      ARGS+=(--upgradeable-program "$addr" "$so_file" "$DUMMY_AUTHORITY")
      ;;
  esac
done

echo "Starting Pook Rings localnet on RPC=$RPC_PORT Photon=$PHOTON_PORT Prover=$PROVER_PORT..."
"$ZOLANA_BIN" "${ARGS[@]}"

# Record exact PIDs listening on our own ports + this keeper shell PID.
# Never use pkill/killall; stop.sh kills only PIDs written to $PID_FILE.
{
  echo "$$"
  for port in "$RPC_PORT" "$((RPC_PORT + 1))" "$PHOTON_PORT" "$PROVER_PORT"; do
    ss -tlnp "sport = :$port" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 || true
  done
} | sort -u > "$PID_FILE"

# Bootstrap localnet keys (holder, relayer, admin), funding, SPP SPL interfaces,
# init_config (fee_recipient = launch wallet), and all 9 launch hooks.
if [[ "${POOK_SKIP_SETUP:-0}" != "1" ]]; then
  export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/pook-target}"
  export POOK_RPC_URL="http://127.0.0.1:$RPC_PORT"
  export POOK_PHOTON_URL="http://127.0.0.1:$PHOTON_PORT"
  export POOK_PROVER_URL="http://127.0.0.1:$PROVER_PORT"
  export POOK_LOCALNET_DIR="$SCRIPT_DIR"
  SETUP_BIN="$CARGO_TARGET_DIR/release/localnet_setup"
  if [[ ! -x "$SETUP_BIN" ]]; then
    echo "Building localnet_setup bootstrap binary..."
    cargo build --manifest-path "$REPO_ROOT/program/Cargo.toml" -p pook-test --bin localnet_setup --release
  fi
  "$SETUP_BIN"
fi

echo "POOK_LOCALNET_READY (PIDs recorded in $PID_FILE)"
cat "$PID_FILE"

cleanup() {
  if [[ -f "$PID_FILE" ]]; then
    while IFS= read -r pid; do
      [[ -n "$pid" && "$pid" != "$$" ]] || continue
      kill -TERM "$pid" 2>/dev/null || true
    done < "$PID_FILE"
  fi
  rm -f "$PID_FILE"
  rm -rf "$LOG_DIR"
}
trap cleanup EXIT INT TERM

# Stay attached in foreground so WSL remains running while localnet is active.
while true; do
  sleep 60
done
