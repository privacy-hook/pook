# Pook Phase-2 Groth16 Ceremony

Multi-party phase-2 trusted setup for the six Pook Xark circuits (`run`, `leave`, `seat_open`, `seat_fund`, `seat_action`, `seat_close`), anchored on PSE's Perpetual Powers of Tau (`ppot_0080_14.ptau`, power 14 = 16,384 constraints; largest circuit `seat_fund` is 15,721 constraints + 1 public input = 15,722).

Requires at least **two independent human contributors** before finalization, followed by a public randomness beacon (e.g., a future Solana slot blockhash or drand pulse hash read after the last contributor finishes).

## Commands in order (WSL)

Run from `program/ceremony/` with a chosen working directory `$CEREMONY_DIR` (outside git):

```bash
bash 01-fetch-ptau.sh --dir "$CEREMONY_DIR"
bash 02-init.sh --dir "$CEREMONY_DIR"
bash 03-contribute.sh --dir "$CEREMONY_DIR" --name "<contributor-1>"
bash 03-contribute.sh --dir "$CEREMONY_DIR" --name "<contributor-2>"
bash 04-verify.sh --dir "$CEREMONY_DIR"
bash 05-finalize.sh --dir "$CEREMONY_DIR" --beacon "<64-hex-public-beacon>" --beacon-source "<drand-round-or-solana-slot>"
bash 06-export-and-build.sh --dir "$CEREMONY_DIR"
```

Add as many extra `03-contribute.sh` runs as needed between contributors before running `04-verify.sh` and `05-finalize.sh`.

## Outputs

- `$CEREMONY_DIR/work/<circuit>/contribution_*.json` and `$CEREMONY_DIR/final/beacon.json`: public ceremony transcript to archive and publish.
- `program/program/src/verifier/*.{rs,vk.rs}`: production on-chain verifiers without `insecure-test-setup`.
- `program/deploy/trusted-keys.sha256`: pinned SHA-256 manifest of `metadata.json`, `pk.bin`, and `vk.bin` for all six circuits.
- `program/artifacts/<circuit>/{circuit.xbc,pk.bin,vk.bin}`: proving and verifying keys for the prover service and SDK.
- `program/deploy/pook_program.so`: production SBF binary built with `--no-default-features --features bpf-entrypoint` and verified with `zolana vks check --so ... --expect trusted-keys.sha256`.
