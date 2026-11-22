# Ceremony transcript

The public record of Pook's phase-2 Groth16 ceremony for its six circuits: `run`, `leave`, `seat_open`, `seat_fund`, `seat_action` and `seat_close`.

- Phase 1: `ppot_0080_14.ptau` (sha256 `3ca1149e9349b22b0ee0649399cfb787677129b7b1189d1899fc0d615d9583db`).
- Two contributions per circuit, `contributor-1` and `contributor-2`, then a public beacon: drand default chain round 6664902, randomness `0769095dbc77d2b89e6f2f2d1c299f233a8b23043a49aeddf9ecd7fa1ef549a5`, applied as the third entry. Finalized 2026-11-22 20:11:45 UTC.
- `<circuit>/contribution_000N.json`: each step's delta contribution and its proof of knowledge.
- `<circuit>/metadata.json`: the final key's circuit hash, constraint count and verifying key hash.
- `beacon.json`: the beacon and the phase-1 file it builds on.
- `trusted-keys.sha256`: the hashes of the final `pk.bin`, `vk.bin` and `metadata.json` per circuit. The deployed program's verifiers are checked against it with `zolana vks check --so pook_program.so --expect trusted-keys.sha256`, and the proving keys shipped in `artifacts/` and `@pook/circuits` hash to the same values.

Anyone can recheck the chain of contributions with `04-verify.sh` against these files and the circuits built from this repo.
