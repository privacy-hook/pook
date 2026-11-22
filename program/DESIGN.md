# Pook Program Design

Decisions recorded for open implementation points in the `pook` on-chain program, its Xark circuits, launch hooks, and localnet.

## Program ID and Canonical PDAs

- **Program ID:** `7qvNkZjiikySgCNbr8jbWbUziVka3Rw1NLwcxwmwwRwd`
- **`authority_pda`** (`[b"authority"]`): `F5LdT1ZsevWdh2HQviGQtUhoBn8nn9UYScqi3pE3F2Yr`
- **`stage_pda`** (`[b"stage"]`): `9hqmRBsxBtGkEywAuZ89McRqccDuVm68NJXcXNUQQdFf`
- **`config_pda`** (`[b"config"]`): `9JtAtvLC4PNsKjEEiB1tNQN95GBgLfnRxqHotjaNfgZX`

## Notes and Privacy

- **Owner hash:** Every Pook note uses `owner_hash = Poseidon(solana_owner_identity(authority_pda), Poseidon(nullifier_secret))`, where `authority_pda = PDA([b"authority"])` and `nullifier_secret` is derived per note index from one holder wallet signature (`Sha256BE(b"POOK/nf/v1" || sig || index_le)`).
- **Public owner tag:** Every deposit (`enter` and `run`) and every `transact` change/padding output carries `view_tag = authority_pda`, so no holder wallet or per-holder viewing key appears in chain state or transaction account lists.
- **Multi-key spending:** `Run`, `Leave`, and `SeatFund` accept up to two input balance notes (`input_0` required, `input_1` optional) that may carry distinct one-time `nullifier_secret`s, pooled into one withdrawal leg and one change output to a fresh one-time `change_owner` under `authority_pda`.
- **`enter` needs no circuit:** Entering from a public wallet uses SPP's proofless `deposit` (tag 11) directly to the holder's one-time `owner_hash` with `view_tag = authority_pda`. Entering from an existing Rings private balance forwards a holder-signed SPP `transact` CPI and asserts an output carries `OwnerTag::Inline(authority_pda)`.

## Circuits (Xark, `spr-program` 0.10.0)

Six single-purpose circuits keep constraint counts small and avoid dummy-branch complexity on `DataUtxo`:

1. `run` (9,891 constraints) — Flow hooks (`amount_in > 0`). Proves one-time nullifier keys for 1–2 notes, binds `authority_identity`, `hook_hash`, `call_hash`, `amount_in`, `min_out`, `output_owner_hash`, `relayer_fee`, `expiry`, and the withdrawal `PublicTransfer`.
2. `leave` (9,898 constraints) — Exit without a hook (`leave_kind == 0` public address or `1` Rings private balance via `deposit`). Proves 1–2 notes, binds `authority_identity`, `leave_kind`, `dest_hash`, `dest_view_tag_hash`, `amount`, `relayer_fee`, `expiry`.
3. `seat_open` (6,170 constraints) — Reserves `NewAddress` for `seat_commitment = Poseidon(b"PKST", seat_secret)` and mints the initial `DataUtxo<SeatNote>` with zero balance inputs required.
4. `seat_fund` (15,721 constraints) — Seat hooks that spend balance notes (`kamino.collateral.deposit`, `kamino.repay`): spends & renews `DataUtxo<SeatNote>` plus 1–2 balance notes with a withdrawal leg.
5. `seat_action` (6,740 constraints) — Seat hooks with no input token spend (`kamino.borrow`, `kamino.collateral.withdraw`): spends & renews `DataUtxo<SeatNote>` and binds hook, `call_hash`, `min_out`, `output_owner_hash`, `relayer_fee`, `expiry`.
6. `seat_close` (4,578 constraints) — Burns `DataUtxo<SeatNote>` so `close_seat` closes `Seat` state and returns rent to `opener_relayer`.

The keys in `program/artifacts/<circuit>/` (`circuit.xbc`, `pk.bin`, `vk.bin`) and the verifiers in `program/src/verifier/` come from the phase-2 ceremony (`ceremony/`); its public transcript and `trusted-keys.sha256` are in `ceremony/transcript/`. `scripts/build-circuits.sh --keys <ceremony>/final` rebuilds the WASM against those keys and checks `wasm/{web,node}/proving-keys.json` against the trusted hashes.

## Stage Isolation and Native SOL / WSOL Handling

- **Separation of PDAs:** `authority_pda` (`[b"authority"]`) ONLY signs SPP `transact` CPIs and is strictly forbidden in every target hook CPI account list. `stage_pda` (`[b"stage"]`) owns flow-hook stage token accounts and signs flow hook CPIs, SOL settlement transfers, and SPP `deposit` CPIs.
- **Delta-based stage accounting & leftover input return:** Both Flow and Seat `run` measure stage token accounts and `stage_pda` lamports strictly by their change within the run, snapshotting stage-in and stage-out balances **before** the SPP withdrawal leg and never rejecting pre-existing balances (`StageNotEmpty` is no longer enforced; stray tokens sent to stage accounts neither block runs nor count toward output). After the target CPI:
  - `delta_out = stage_out_after - stage_out_before_withdraw` (must satisfy `delta_out >= min_out`; fees are computed strictly on `delta_out`).
  - `leftover_in = (stage_in_after - stage_in_before_withdraw).min(amount_in)` when stage-in and stage-out are distinct accounts (`0` when they are the same account, where unused input is already included in `delta_out`).
  - Whenever `leftover_in > 0` (e.g., a Kamino deposit that rounds liquidity down by 1 base unit, or a Kamino repay overpayment), Pook returns `leftover_in` to `args.output_owner_hash` with `view_tag = authority_pda` in the **same** SPP `deposit` CPI (using the `sol_interface` / `spl_interface` and `spl_interface_bump` already present in the SPP withdrawal leg, so no instruction data or account layout changes are needed): as a second asset entry when `mint_in != mint_out`, or added to the same entry when `mint_in == mint_out`. When `leftover_in == 0`, nothing extra is deposited. For no-output hooks (`has_mint_out == false`), `leftover_in` is returned when `output_owner_hash != [0; 32]`.
- **Seat stage token accounts:** For `HookKind::Seat` hooks, `StageIn` and `StageOut` SPL/WSOL ATAs are owned by `seat_pda` (`find_ata(seat_pda, mint)`). This satisfies protocols such as Kamino Lend that enforce `token::authority == obligation.owner` (`seat_pda`) without extra token transfer CPIs. `run` settles `delta_out` and any `leftover_in` signed by `seat_pda` (or `stage_pda` for native SOL), closing `seat_pda`'s WSOL ATA to `stage_pda` on unwrap/leftover return and refunding ATA rent to `payer`.
- **Forbidden accounts:** Before invoking any hook target program, `run` rejects any CPI account matching `pook::ID`, `SPP`, `authority_pda`, `config`, `hook`, `output_tree`, `author_fees`, `author_fees_ata`, `fee_recipient_ata`, `seat_state`, `spl_interface_out`, `spl_interface_in`, or `sol_interface_in`.
- **Stage lamport guard:** `run` snapshots `stage_pda.lamports()` before the SPP withdrawal leg and fails (`StageLamportsDrained`) if the target drains `stage_pda` below that pre-withdrawal balance.
- **WSOL wrapping/unwrapping:** Hooks set `wrap_sol_in` and `unwrap_sol_out`. When `mint_out == SOL` and `unwrap_sol_out == true`, the relayer creates the WSOL ATA idempotently ahead of `run`; after measuring `delta_out >= min_out`, Pook closes the WSOL ATA to `stage_pda`, refunds the ATA rent (capped at rent-exempt minimum, never crediting stray WSOL) back to `payer`, pays SOL fees, and deposits `net_out` as native SOL into Rings. If `wrap_sol_in == true` leaves `leftover_in > 0` WSOL in `stage_in_wsol_ata`, Pook likewise closes it to `stage_pda`, refunds its rent to `payer`, and includes `leftover_in` in the SPP `deposit` CPI.

## Seats

- A seat uses two PDAs derived from `seat_commitment = Poseidon(b"PKST", seat_secret)`:
  - `seat_pda = PDA([b"seat", seat_commitment])`: system-owned PDA with 0 data that owns external protocol positions (e.g., Kamino obligations) and signs seat hook CPIs and seat setup CPIs.
  - `seat_state = PDA([b"seat_state", seat_commitment])`: Pook-owned state account storing `commitment`, `opener_relayer`, `opened_at`, and bumps. Never passed to target hook CPIs. Closed by `close_seat`, returning its rent and any stray `seat_pda` lamports (such as refunded Kamino obligation rent) to `opener_relayer`.
- **Optional setup CPIs in `open_seat`:** `OpenSeatArgs` includes `spp_account_count: u8` and `setup_cpis: Vec<SetupCpi>` (up to 4 CPIs), and `open_seat` accounts are `[payer, seat_state, seat_pda, system_program, ..spp_accounts, ..setup_accounts]`. After verifying `seat_open`, creating `seat_state`, and executing the SPP `transact` CPI, `open_seat` invokes each `SetupCpi` signed only by `seat_pda` (+ `payer`), subject to the same forbidden-account rules (never `authority_pda`, `stage_pda`, `seat_state`, `config`, `pook::ID`, `SPP`, or `output_tree`). Kamino seats use this to execute `init_user_metadata` and `init_obligation` atomically with `open_seat`.

## Launch Hooks

Nine launch hooks are defined in `program/sdk/src/hooks.rs` and exported as canonical `PublishHookArgs` JSON (with base58 pubkeys) in `program/hooks/<id>.json`:

- Flow hooks: `jupiter.swap`, `kamino.supply` (`deposit_reserve_liquidity` + `refresh_reserve` companion), `kamino.withdraw` (`redeem_reserve_collateral` + `refresh_reserve` companion), `jito.stake` (`DepositSol`, opcode 14), `jito.unstake` (`WithdrawSol`, opcode 16).
- Seat hooks (Kamino Lend V2 instructions, which permit CPI and refresh reserve farms inline, with `refresh_reserve` + `refresh_obligation` companions): `kamino.collateral.deposit` (`deposit_reserve_liquidity_and_obligation_collateral_v2`), `kamino.borrow` (`borrow_obligation_liquidity_v2`), `kamino.repay` (`repay_obligation_liquidity_v2`), `kamino.collateral.withdraw` (`withdraw_obligation_collateral_and_redeem_reserve_collateral_v2`).

## Fees and Rounding

- `Config` stores `run_fee_bps` and `author_share_bps` (both supplied to `init_config`; no production defaults hardcoded).
- `run_fee = floor(delta_out * run_fee_bps / 10_000)`.
- `protocol_fee = floor(run_fee * (10_000 - author_share_bps) / 10_000)` (protocol share rounded down); `author_fee = run_fee - protocol_fee`.
- Protocol share is paid directly in `run` to `fee_recipient` (SOL, as lamports by a System transfer from the stage) or `fee_recipient`'s derived ATA (SPL, a token transfer signed by the stage or seat PDA).
- Buyback reads only those payments. The indexer takes each run's transfers to `fee_recipient` that a stage or seat PDA signed beneath the `run` instruction and adds them to `buyback_fee` per asset. The crank swaps at most `accrued - spent` per asset (and at most what the account holds) to POOK, and burns exactly the POOK that swap delivered, read from the swap transaction itself. The fee recipient's own balances (SOL, tokens, a standing POOK allocation) are never an input.
- Author share accrues to `AuthorFees` PDA `[b"author_fees", author, mint]` (auto-created on first accrual; SOL sits above rent exemption in the PDA, SPL sits in the PDA's derived ATA) and is claimed via `claim_author_fees`.

## Call Hash Binding

```text
call_hash = Sha256BE(
    b"PKCALL01"
    || target_program (32B)
    || has_mint_out (1B)
    || mint_out (32B)
    || cpi_data_len (u32 LE) || cpi_data
    || cpi_accounts_len (u16 LE)
    || for each CPI account: (pubkey (32B) || is_writable (1B) || is_signer (1B))
)
```

`Sha256BE` clears byte 0 so the digest is always a canonical BN254 `Field`.

## Localnet

- Uses `zolana dev start --local` with cached `surfpool 1.6.0` (`--offline`, Agave 4.x SVM supporting Transaction v1 and SBPF v3), cached `shielded-pool-v1.0.0`, Photon indexer (`20813`), and Rings prover (`20814`), validator RPC `20820` / WS `20821`, all bound to `127.0.0.1`, loading `pook_program.so` at `7qvNkZjiikySgCNbr8jbWbUziVka3Rw1NLwcxwmwwRwd`.
- One-time mainnet capture (`localnet/capture.mjs`) dumps 11 programs (Jupiter v6, Meteora DLMM, Raydium CLMM, Kamino Lend, Kamino Farms, Scope, Jito Stake Pool, Lighthouse, SPL Token, Token-2022, ATA) and 45 accounts, and reproducibly patches localnet fixtures: USDC mint authority rewritten to `localnet/mint-authority.json`; Jito Stake Pool `last_update_epoch` set to `0`; Kamino USDC & SOL reserves patched (`last_update.slot = 0`, `stale = 1`, `timestamp = 0`, `market_price_last_updated_ts = 0`, `max_age_price/twap_seconds = 1_000_000_000`); Scope `OraclePrices` entries' `last_updated_slot` set to `0`.
- `localnet/start.sh` runs `localnet_setup` on startup, creating gitignored `localnet/keys/{holder,relayer,admin}.json` once, funding `holder` (100 SOL + 10,000 USDC), `relayer` (100 SOL), `admin` (10 SOL), launch wallet `AFMxmWEUi1oDVA9SHay9BV4jg1GZHfZPZawt8H8Tk4hW` (1 SOL + ATAs), and `stage_pda`, registering USDC/kUSDC/kSOL/JitoSOL on SPP, running `init_config` (`RUN_FEE_BPS`/`AUTHOR_SHARE_BPS` env vars, localnet placeholders `30`/`5000` if unset), and publishing all 9 launch hooks.
