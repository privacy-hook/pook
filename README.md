# Pook

Use any protocol without being seen.

Pook is a Solana program that spends a private balance on Solana Privacy Rings into an existing protocol and returns the result to a private balance in the same transaction. The protocol never sees a wallet: Pook's own PDA withdraws the input, calls the target program and deposits what came back to a new note that only the holder can spend.

Each protocol instruction Pook can call is described by a hook, a public on-chain record of the target program, the instruction, which accounts carry the input and output, and who wrote it. Anyone can publish a hook. Its author earns a share of the run fee on every run through it.

Program ID: `7qvNkZjiikySgCNbr8jbWbUziVka3Rw1NLwcxwmwwRwd`

## How a run works

1. `enter` deposits tokens from a wallet (or an existing Rings balance) into a Pook note. The note's owner is Pook's authority PDA plus a one-time nullifier key derived from one wallet signature, so the wallet appears nowhere on chain after this point.
2. `run` takes a Groth16 proof that the caller can spend one or two notes, withdraws the input into a stage account, calls the hook's target program, measures what arrived in the stage, checks it against `min_out`, takes the fee, and deposits the rest as a new note. Unused input goes back to the holder in the same deposit.
3. `leave` spends notes to a public address or to a Rings private balance.

A relayer signs and pays for every proven transaction, so the holder's key never appears in its account list. Positions that live in a protocol account, such as a Kamino obligation, are held by a seat: a PDA derived from a secret commitment, opened with `open_seat` and closed with `close_seat`.

`program/DESIGN.md` has the accounts, the call hash, stage accounting, fees and the forbidden-account rules.

## Layout

| Path | What it is |
|---|---|
| `program/program/` | The `pook` program: `init_config`, `set_config`, `publish_hook`, `enter`, `run`, `leave`, `open_seat`, `close_seat`, `claim_author_fees` |
| `program/program/src/circuits/` | The six Xark circuits: `run`, `leave`, `seat_open`, `seat_fund`, `seat_action`, `seat_close` |
| `program/program/src/verifier/` | On-chain Groth16 verifiers generated from the circuits |
| `program/artifacts/` | Circuit bytecode, proving and verifying keys from the test setup, served by the prover |
| `program/sdk/` | Rust SDK: instruction builders, proving, notes, and the nine launch hooks |
| `program/hooks/` | The launch hooks as `publish_hook` arguments: `jupiter.swap`, `kamino.supply`, `kamino.withdraw`, `jito.stake`, `jito.unstake`, `kamino.collateral.deposit`, `kamino.borrow`, `kamino.repay`, `kamino.collateral.withdraw` |
| `program/test/` | The end-to-end suite and the localnet bootstrap and `pook_init` binaries |
| `program/scripts/` | `build-circuits.sh`, `deploy.sh`, `init.sh` |
| `program/ceremony/` | The phase-2 trusted setup for the six circuits, which produces the mainnet keys and verifiers |
| `contract/` | `@pook/contract`: the API's zod schemas, error model, HTTP client, OpenAPI document and fixtures |
| `sdk/` | `@pook/sdk`: the browser-safe developer surface (`createPook`, `run`, `enter`, `leave`, `balance`, `seats`, `defineHook`, `publishHook`, `simulateHook`). Notes are found and decrypted on the client |
| `hooks/` | Display metadata for the launch hooks, written with `defineHook` |
| `src/roles/` | The services: `api`, `relayer`, `prover`, `indexer`, `crank` |
| `prisma/` | PostgreSQL schema and migrations |
| `localnet/` | A Rings localnet with the protocols the launch hooks call, captured from mainnet |
| `scripts/flows.mjs` | Runs the user flows through `@pook/sdk` against a running stack |

## Services

All five share one Postgres database and start with `node start-service.mjs <role>` after a build.

| Role | Port | What it does |
|---|---|---|
| `api` | 20810 | Hook registry, run feed over SSE, quotes, unsigned builders for wallet-signed instructions, simulation, and relays for RPC, Photon and the Rings prover |
| `relayer` | 20811 | Checks proven `run`, `leave`, `open_seat` and `close_seat` instructions, simulates them, signs as fee payer and sends |
| `prover` | 20812 | Serves circuit artifacts with SHA-256 headers and proxies the Rings prover |
| `indexer` | | Decodes `pook` instructions and token flows into Postgres and notifies the feed |
| `crank` | | Swaps accrued protocol fees to the POOK mint through Jupiter and burns them |

Configuration is in `.env.example`. With `MODE=fixture` the API answers from deterministic fixtures and needs no database or chain; send `X-Fixture: <scenario>` to pick a state.

## Build

You need Node 22 and the Rust toolchain pinned in `program/rust-toolchain.toml`.

```bash
npm ci
npm run build       # Prisma client, @pook/contract (+ openapi.json), @pook/sdk, services
npm run typecheck
MODE=fixture node start-service.mjs api
```

```bash
cd program
cargo test -p pook-sdk --release    # launch hook definitions against program/hooks/*.json
```

Circuits, verifiers and the circuit WASM are built with the `zolana` CLI (set `ZOLANA_BIN`), on Linux or WSL:

```bash
bash program/scripts/build-circuits.sh
```

The SBF binary for a localnet, with the test-setup verifiers:

```bash
cargo-build-sbf --arch v0 --manifest-path program/program/Cargo.toml \
  --sbf-out-dir program/deploy -- --no-default-features --features bpf-entrypoint,insecure-test-setup
```

A mainnet binary is built from the ceremony's verifiers: `program/ceremony/README.md`.

## Test on a localnet

The localnet runs the Rings programs, Photon and the Rings prover through `zolana dev start`, with Jupiter, Meteora, Raydium, Kamino, Jito and the SPL programs loaded from a mainnet capture.

```bash
MAINNET_RPC_URL=<mainnet rpc> JUPITER_API_KEY=<key> node localnet/capture.mjs
bash localnet/start.sh
```

`start.sh` loads `program/deploy/pook_program.so`, creates and funds the holder, relayer and admin keys under `localnet/keys/`, runs `init_config` and publishes the nine launch hooks. Then:

```bash
cd program
cargo test -p pook-test --test e2e --release -- --nocapture
```

The suite runs every launch hook, the full seat lifecycle on Kamino, the slippage and account-isolation invariants and stray tokens in the stage, and checks on each relayed transaction that the holder's wallet is not among its accounts.

With Postgres and the `prover`, `relayer`, `indexer` and `api` services running against the localnet in `MODE=chain`, `node scripts/flows.mjs` runs the same flows through the SDK.

## Deploy

`program/scripts/deploy.sh` deploys, resumes or upgrades the program and refuses a binary built with test keys unless told otherwise. `program/scripts/init.sh` runs `init_config`, creates the fee accounts, registers the payout mints on Rings and publishes the launch hooks, then records what it created in `program/deploy/<cluster>.json`. `program/deploy/FIGURES.md` has the rent each step costs.

## License

See `LICENSE`.
