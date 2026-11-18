#!/usr/bin/env bash
# Idempotent deploy / resume / upgrade script for the `pook` program.
# Never modifies global Solana CLI config (passes --url and --keypair explicitly on every call).
# Refuses to deploy a `.so` built with `insecure-test-setup` unless `--allow-test-keys` is passed.
set -euo pipefail

export PATH="$HOME/pook-tools/bin:$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ZOLANA_BIN="${ZOLANA_BIN:-$HOME/pook-tools/zolana}"

URL=""
DEPLOYER=""
PROGRAM_KEYPAIR=""
PROGRAM_ID=""
BUFFER=""
SO_PATH="$WORKSPACE_DIR/deploy/pook_program.so"
CU_PRICE="10000"
CLUSTER=""
EXPECT_CHECKSUMS=""
ALLOW_TEST_KEYS=0
DRY_RUN=0
SKIP_RECORD=0

usage() {
  cat <<EOF
Usage: $0 --url <RPC_URL> --deployer <KEYPAIR> --buffer <BUFFER_KEYPAIR> \\
          (--program-keypair <KEYPAIR> | --program-id <PUBKEY>) \\
          [--so <PATH>] [--cu-price <MICRO_LAMPORTS>] [--cluster <NAME>] \\
          [--expect-checksums <trusted-keys.sha256>] [--allow-test-keys] [--dry-run] [--skip-record]
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --deployer) DEPLOYER="$2"; shift 2 ;;
    --program-keypair) PROGRAM_KEYPAIR="$2"; shift 2 ;;
    --program-id) PROGRAM_ID="$2"; shift 2 ;;
    --buffer) BUFFER="$2"; shift 2 ;;
    --so) SO_PATH="$2"; shift 2 ;;
    --cu-price) CU_PRICE="$2"; shift 2 ;;
    --cluster) CLUSTER="$2"; shift 2 ;;
    --expect-checksums) EXPECT_CHECKSUMS="$2"; shift 2 ;;
    --allow-test-keys) ALLOW_TEST_KEYS=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-record) SKIP_RECORD=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage >&2; exit 1 ;;
  esac
done

[[ -n "$URL" ]] || { echo "Error: --url is required" >&2; exit 1; }
[[ -n "$DEPLOYER" && -f "$DEPLOYER" ]] || { echo "Error: --deployer keypair file is required" >&2; exit 1; }
[[ -n "$BUFFER" ]] || { echo "Error: --buffer keypair path is required" >&2; exit 1; }
[[ -f "$SO_PATH" ]] || { echo "Error: program binary not found at $SO_PATH" >&2; exit 1; }
if [[ -z "$PROGRAM_KEYPAIR" && -z "$PROGRAM_ID" ]]; then
  echo "Error: provide --program-keypair (initial deploy) or --program-id (upgrade)" >&2
  exit 1
fi

if [[ -n "$PROGRAM_KEYPAIR" ]]; then
  [[ -f "$PROGRAM_KEYPAIR" ]] || { echo "Error: program keypair not found: $PROGRAM_KEYPAIR" >&2; exit 1; }
  PROGRAM_ID="$(solana-keygen pubkey "$PROGRAM_KEYPAIR")"
fi
DEPLOYER_PUBKEY="$(solana-keygen pubkey "$DEPLOYER")"

# Create fixed buffer keypair once if it does not yet exist.
if [[ ! -f "$BUFFER" ]]; then
  mkdir -p "$(dirname "$BUFFER")"
  solana-keygen new --no-bip39-passphrase --silent -o "$BUFFER"
fi
BUFFER_PUBKEY="$(solana-keygen pubkey "$BUFFER")"

ELF_BYTES="$(stat -c%s "$SO_PATH")"
ELF_SHA256="$(sha256sum "$SO_PATH" | awk '{print $1}')"

# 1. Verify embedded Groth16 verifying keys in `.so` (refuse insecure-test-setup unless explicitly allowed).
echo "=== 1. Checking verifying keys in $SO_PATH ==="
VKS_ARGS=(vks check --so "$SO_PATH")
[[ -n "$EXPECT_CHECKSUMS" ]] && VKS_ARGS+=(--expect "$EXPECT_CHECKSUMS")
if "$ZOLANA_BIN" "${VKS_ARGS[@]}"; then
  KEY_KIND="production"
else
  if [[ "$ALLOW_TEST_KEYS" == "1" ]]; then
    echo "WARNING: --allow-test-keys set; proceeding with insecure-test-setup binary (localnet/rehearsal only)."
    KEY_KIND="insecure-test-setup"
  else
    echo "Error: refusing to deploy $SO_PATH because verifying key check failed (insecure-test-setup or checksum mismatch). Pass --allow-test-keys for localnet rehearsal only." >&2
    exit 1
  fi
fi

# 2. Identify cluster from genesis hash (never write RPC URL anywhere).
GENESIS_HASH="$(solana genesis-hash --url "$URL" | tr -d '[:space:]')"
if [[ -z "$CLUSTER" ]]; then
  case "$GENESIS_HASH" in
    5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d) CLUSTER="mainnet-beta" ;;
    EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG) CLUSTER="devnet" ;;
    *) CLUSTER="localnet" ;;
  esac
fi

# Detect whether the program already exists on chain.
ALREADY_DEPLOYED=0
if solana program show "$PROGRAM_ID" --url "$URL" >/dev/null 2>&1; then
  ALREADY_DEPLOYED=1
fi
PROG_ARG="${PROGRAM_KEYPAIR:-$PROGRAM_ID}"

# 3. Compute exact deploy figure via dry balance check with an unfunded temporary fee payer.
TMP_UNFUNDED="/tmp/pook-dry-payer-$$.json"
cleanup() { rm -f "$TMP_UNFUNDED"; }
trap cleanup EXIT
solana-keygen new --no-bip39-passphrase --silent --force -o "$TMP_UNFUNDED"

echo "=== 2. Computing exact deploy figure (dry balance check, CU price=$CU_PRICE) ==="
set +e
if [[ "$ALREADY_DEPLOYED" == "1" ]]; then
  DRY_OUT="$(solana program deploy "$SO_PATH" \
    --url "$URL" \
    --keypair "$TMP_UNFUNDED" \
    --fee-payer "$TMP_UNFUNDED" \
    --upgrade-authority "$DEPLOYER" \
    --program-id "$PROG_ARG" \
    --buffer "$BUFFER" \
    --with-compute-unit-price "$CU_PRICE" 2>&1)"
else
  DRY_OUT="$(solana program deploy "$SO_PATH" \
    --url "$URL" \
    --keypair "$TMP_UNFUNDED" \
    --program-id "$PROG_ARG" \
    --buffer "$BUFFER" \
    --with-compute-unit-price "$CU_PRICE" 2>&1)"
fi
set -e

FIGURE_LINE="$(printf '%s\n' "$DRY_OUT" | grep -i "insufficient funds" | head -n 1 || true)"
echo "  Program ID:      $PROGRAM_ID (existing=$ALREADY_DEPLOYED)"
echo "  Deployer:        $DEPLOYER_PUBKEY"
echo "  Buffer:          $BUFFER_PUBKEY"
echo "  ELF size:        $ELF_BYTES bytes (sha256=$ELF_SHA256)"
echo "  Cluster:         $CLUSTER (genesis=$GENESIS_HASH)"
echo "  CLI figure:      ${FIGURE_LINE:-$DRY_OUT}"

DEPLOYER_BALANCE="$(solana balance "$DEPLOYER_PUBKEY" --url "$URL" --lamports | awk '{print $1}')"
echo "  Deployer bal:    $DEPLOYER_BALANCE lamports"

# Parse required spend + fee in lamports if reported.
REQUIRED_LAMPORTS="$(python3 - "$FIGURE_LINE" <<'PY'
import re, sys
line = sys.argv[1]
m = re.search(r"spend \(([0-9.]+) SOL\) \+ fee \(([0-9.]+) SOL\)", line)
if m:
    spend = round(float(m.group(1)) * 1_000_000_000)
    fee = round(float(m.group(2)) * 1_000_000_000)
    print(spend + fee)
else:
    print(0)
PY
)"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "Dry run complete (--dry-run); no transactions sent."
  exit 0
fi

if [[ "$REQUIRED_LAMPORTS" -gt 0 && "$DEPLOYER_BALANCE" -lt "$REQUIRED_LAMPORTS" ]]; then
  SHORTFALL="$((REQUIRED_LAMPORTS - DEPLOYER_BALANCE))"
  echo "Error: deployer $DEPLOYER_PUBKEY needs at least $REQUIRED_LAMPORTS lamports (shortfall: $SHORTFALL lamports)." >&2
  exit 1
fi

# 4. Deploy / resume / upgrade.
echo "=== 3. Deploying $SO_PATH to $PROGRAM_ID on $CLUSTER ==="
BAL_BEFORE="$(solana balance "$DEPLOYER_PUBKEY" --url "$URL" --lamports | awk '{print $1}')"
DEPLOY_OUT="$(solana program deploy "$SO_PATH" \
  --url "$URL" \
  --keypair "$DEPLOYER" \
  --program-id "$PROG_ARG" \
  --buffer "$BUFFER" \
  --with-compute-unit-price "$CU_PRICE" \
  --output json)"
BAL_AFTER="$(solana balance "$DEPLOYER_PUBKEY" --url "$URL" --lamports | awk '{print $1}')"
SPENT_LAMPORTS="$((BAL_BEFORE - BAL_AFTER))"
DEPLOY_SIG="$(python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); print(d.get("signature","") or d.get("programId",""))' <<<"$DEPLOY_OUT" 2>/dev/null || true)"
SHOW_JSON="$(solana program show "$PROGRAM_ID" --url "$URL" --output json)"

echo "  Deploy complete. Net deployer spend: $SPENT_LAMPORTS lamports"
echo "$SHOW_JSON"

# 5. Update chain-derived setup record `program/deploy/<cluster>.json` (never stores RPC URL or keys).
if [[ "$SKIP_RECORD" != "1" ]]; then
  RECORD_PATH="$WORKSPACE_DIR/deploy/${CLUSTER}.json"
  python3 - "$RECORD_PATH" "$CLUSTER" "$GENESIS_HASH" "$PROGRAM_ID" "$DEPLOYER_PUBKEY" "$ELF_BYTES" "$ELF_SHA256" "$KEY_KIND" "$CU_PRICE" "$FIGURE_LINE" "$SPENT_LAMPORTS" "$DEPLOY_SIG" "$SHOW_JSON" <<'PY'
import json, pathlib, sys
from datetime import datetime, timezone

(
    record_path, cluster, genesis, program_id, deployer,
    elf_bytes, elf_sha256, key_kind, cu_price, figure_line,
    spent_lamports, deploy_sig, show_json_str
) = sys.argv[1:]

path = pathlib.Path(record_path)
data = json.loads(path.read_text()) if path.exists() else {}
show = json.loads(show_json_str)

data["cluster"] = cluster
data["genesisHash"] = genesis
data["programId"] = program_id
data["deploy"] = {
    "deployer": deployer,
    "programData": show.get("programdataAddress"),
    "upgradeAuthority": show.get("authority"),
    "elfBytes": int(elf_bytes),
    "elfSha256": elf_sha256,
    "dataLen": show.get("dataLen"),
    "programDataLamports": show.get("lamports"),
    "keyKind": key_kind,
    "computeUnitPriceMicroLamports": int(cu_price),
    "cliFigure": figure_line,
    "netDeployerSpendLamports": int(spent_lamports),
    "signature": deploy_sig,
    "deployedAtUtc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(data, indent=2) + "\n")
print(f"Updated setup record: {path}")
PY
fi
