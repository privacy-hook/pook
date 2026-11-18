# Pook Mainnet & Localnet Launch Figures

Measured from the localnet rehearsal (`--no-pook` deploy + fresh `init.sh` + idempotent re-run) and rescaled to Solana mainnet's rent rate (`5,080` lamports per byte × `(data_len + 128)`, checked 2026-11; localnet test validator charges `6,960` lamports per byte × `(data_len + 128)`).

## Program Binary & Deploy Figure

| Metric | Localnet Rehearsal (Test `.so`, 6,960 lamports/B) | Mainnet Estimate (Prod `.so`, 5,080 lamports/B) |
|---|---:|---:|
| ELF size | 254,248 B | 254,256 B |
| `Program` account rent (36 B) | 1,141,440 lamports (`0.001141440 SOL`) | 833,120 lamports (`0.000833120 SOL`) |
| `ProgramData` rent (`ELF + 45` B) | 1,770,770,160 lamports (`1.770770160 SOL`) | 1,292,499,320 lamports (`1.292499320 SOL`) |
| Total program rent | 1,771,911,600 lamports (`1.771911600 SOL`) | 1,293,332,440 lamports (`1.293332440 SOL`) |
| CLI `--with-compute-unit-price 10000` fee bound | 1,345,000 lamports (`0.001345000 SOL`) | ~1,345,000 lamports (`~0.001345000 SOL`) |
| Actual net deployer spend (deploy) | 1,773,263,814 lamports (`1.773263814 SOL`) | ~1,294,685,000 lamports (`~1.294685000 SOL`) |

CLI dry balance check output on localnet (`scripts/deploy.sh --cu-price 10000`):

```text
Error: Account DN6PrnUHm9Kb7jni3zUftbJTVXf1LCcw7UteqSfT3Na6 has insufficient funds for spend (1.77077016 SOL) + fee (0.001345 SOL)
```

Note: The Solana CLI balance check covers buffer rent (returned into `ProgramData` on finalization) plus write/deploy fees. At `--cu-price 10000`, mainnet `solana program deploy` requires `~1.2947 SOL` net spend.

## Init Accounts Rent Breakdown (`scripts/init.sh`)

| Account / Step | Count | Data Bytes (each) | Localnet Rent (6,960/B) | Mainnet Rent (5,080/B) |
|---|---:|---:|---:|---:|
| `Config` PDA (`[b"config"]`) | 1 | 77 B | 1,426,800 (`0.001426800 SOL`) | 1,041,400 (`0.001041400 SOL`) |
| `stage_pda` reserve (`[b"stage"]`) | 1 | 0 B | 1,000,000 (`0.001000000 SOL`) | 1,000,000 (`0.001000000 SOL`) |
| `launch_wallet` ATAs (USDC, kUSDC, kSOL, JitoSOL) | 4 | 165 B | 8,157,120 (`0.008157120 SOL`) | 5,953,760 (`0.005953760 SOL`) |
| `stage_pda` ATAs (USDC, kUSDC, kSOL, JitoSOL) | 4 | 165 B | 8,157,120 (`0.008157120 SOL`) | 5,953,760 (`0.005953760 SOL`) |
| `author_fees` ATAs (USDC, kUSDC, kSOL, JitoSOL) | 4 | 165 B | 8,157,120 (`0.008157120 SOL`) | 5,953,760 (`0.005953760 SOL`) |
| SPP SPL interfaces (165 B vault + 48 B registry each) | 4* | 213 B (2 accts) | 13,056,960 (`0.013056960 SOL`) | 9,530,080 (`0.009530080 SOL`) |
| `Hook` PDA: `jupiter.swap` | 1 | 322 B | 3,132,000 (`0.003132000 SOL`) | 2,286,000 (`0.002286000 SOL`) |
| `Hook` PDA: `jito.stake` | 1 | 536 B | 4,621,440 (`0.004621440 SOL`) | 3,373,120 (`0.003373120 SOL`) |
| `Hook` PDA: `jito.unstake` | 1 | 608 B | 5,122,560 (`0.005122560 SOL`) | 3,738,880 (`0.003738880 SOL`) |
| `Hook` PDA: `kamino.supply` | 1 | 626 B | 5,247,840 (`0.005247840 SOL`) | 3,830,320 (`0.003830320 SOL`) |
| `Hook` PDA: `kamino.withdraw` | 1 | 628 B | 5,261,760 (`0.005261760 SOL`) | 3,840,480 (`0.003840480 SOL`) |
| `Hook` PDA: `kamino.repay` | 1 | 597 B | 5,046,000 (`0.005046000 SOL`) | 3,683,000 (`0.003683000 SOL`) |
| `Hook` PDA: `kamino.borrow` | 1 | 703 B | 5,783,760 (`0.005783760 SOL`) | 4,221,480 (`0.004221480 SOL`) |
| `Hook` PDA: `kamino.collateral.deposit` | 1 | 785 B | 6,354,480 (`0.006354480 SOL`) | 4,638,040 (`0.004638040 SOL`) |
| `Hook` PDA: `kamino.collateral.withdraw` | 1 | 786 B | 6,361,440 (`0.006361440 SOL`) | 4,643,120 (`0.004643120 SOL`) |
| **Init rent subtotal** | **27 txs** | — | **86,886,400 (`0.086886400 SOL`)** | **63,687,200 (`0.063687200 SOL`)** |
| Init transaction fees (27 txs × 5,000 base + priority) | — | — | 135,000 (`0.000135000 SOL`) | ~135,000–500,000 (`~0.0005 SOL`) |
| **Total `init.sh` spend** | — | — | **87,021,400 (`0.087021400 SOL`)** | **~64,187,200 (`~0.0642 SOL`)** |

\* Upper bound assuming none of USDC, kUSDC, kSOL, or JitoSOL are yet registered on mainnet SPP and `spl_interface_creation_is_permissionless == true`. Any mint already registered on mainnet SPP is skipped (`0` lamports); if mainnet SPP disables permissionless creation, missing mints are listed in `deploy/mainnet-beta.json` (`missingSplInterfaces`) instead of failing.

## Mainnet Funding Summary

| Bucket | Exact Mainnet Bound | Recommended Funding |
|---|---:|---:|
| Program deploy (`deploy.sh`, `--cu-price 10000`) | `1.2947 SOL` | `1.35 SOL` |
| Post-deploy init (`init.sh`, all accounts + 9 hooks) | `0.0642 SOL` | `0.15 SOL` |
| **Total deployer funding (deploy + init)** | **`1.3589 SOL`** | **`1.50 SOL`** |

Separate from deployer launch funding:
- Fund the **relayer** wallet with operational SOL for transaction fees and refundable seat-rent float (each open Kamino seat temporarily fronts ~`0.0256 SOL` of `Seat` + Kamino `Obligation` rent, returned on `close_seat`, plus ~`0.008 SOL` one-time `UserMetadata` rent).
- Optional: fund the launch wallet (`AFMxmWEUi1oDVA9SHay9BV4jg1GZHfZPZawt8H8Tk4hW`) with ~`0.05 SOL` for crank/buyback gas if it also signs swaps.
