//! Canonical `PublishHookArgs` definitions and JSON codecs for Pook's nine launch hooks.

use std::str::FromStr;

use anyhow::{anyhow, Result};
use pook_program::{
    instructions::hook::PublishHookArgs,
    pda::{INSTRUCTIONS_SYSVAR_ID, SYSTEM_PROGRAM_ID},
    state::{
        AccountSlot, AccountSlotKind, CompanionRequirement, DataSlot, DataSlotKind, HookKind,
        MintConstraint,
    },
};
use serde::{Deserialize, Serialize};
use solana_address::Address;
use spr_interface::SPL_TOKEN_PROGRAM_ID;

pub const JUPITER_V6_ID: Address =
    Address::from_str_const("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
pub const KAMINO_LEND_ID: Address =
    Address::from_str_const("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
pub const KAMINO_FARMS_ID: Address =
    Address::from_str_const("FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr");
pub const KAMINO_MAIN_MARKET_ID: Address =
    Address::from_str_const("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF");
pub const KAMINO_MAIN_MARKET_AUTHORITY_ID: Address =
    Address::from_str_const("9DrvZvyWh1HuAoZxvYWMvkf2XCzryCpGgHqrMjyDWpmo");
pub const KAMINO_USDC_RESERVE_ID: Address =
    Address::from_str_const("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59");
pub const KAMINO_SOL_RESERVE_ID: Address =
    Address::from_str_const("d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q");
pub const KAMINO_KUSDC_MINT_ID: Address =
    Address::from_str_const("B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D");
pub const KAMINO_KSOL_MINT_ID: Address =
    Address::from_str_const("2UywZrUdyqs5vDchy7fKQJKau2RVyuzBev2XKGPDSiX1");
pub const SCOPE_ORACLE_PRICES_ID: Address =
    Address::from_str_const("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH");

pub const JITO_STAKE_POOL_PROGRAM_ID: Address =
    Address::from_str_const("SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy");
pub const JITO_STAKE_POOL_ID: Address =
    Address::from_str_const("Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb");
pub const JITO_WITHDRAW_AUTHORITY_ID: Address =
    Address::from_str_const("6iQKfEyhr3bZMotVkW6beNZz5CPAkiwvgV2CTje9pVSS");
pub const JITO_RESERVE_STAKE_ID: Address =
    Address::from_str_const("BgKUXdS29YcHCFrPm5M8oLHiTzZaMDjsebggjoaQ6KFL");
pub const JITO_MANAGER_FEE_ACCOUNT_ID: Address =
    Address::from_str_const("8yoigZfzZ1nNaadumY9uPVD118225UYHTDpmjpr2nrSa");
pub const JITOSOL_MINT_ID: Address =
    Address::from_str_const("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn");

pub const SYSVAR_CLOCK_ID: Address =
    Address::from_str_const("SysvarC1ock11111111111111111111111111111111");
pub const SYSVAR_RENT_ID: Address =
    Address::from_str_const("SysvarRent111111111111111111111111111111111");
pub const SYSVAR_STAKE_HISTORY_ID: Address =
    Address::from_str_const("SysvarStakeHistory1111111111111111111111111");
pub const STAKE_PROGRAM_ID: Address =
    Address::from_str_const("Stake11111111111111111111111111111111111111");

/// Anchor instruction discriminators (`sha256("global:<name>")[0..8]`) verified against `Kamino-Finance/klend`.
pub mod kamino_disc {
    pub const REFRESH_RESERVE: [u8; 8] = [2, 218, 138, 235, 79, 201, 25, 102];
    pub const REFRESH_OBLIGATION: [u8; 8] = [33, 132, 147, 228, 151, 192, 72, 89];
    pub const INIT_USER_METADATA: [u8; 8] = [117, 169, 176, 69, 197, 23, 15, 162];
    pub const INIT_OBLIGATION: [u8; 8] = [251, 10, 231, 76, 27, 11, 159, 96];
    pub const INIT_OBLIGATION_FARMS_FOR_RESERVE: [u8; 8] = [136, 63, 15, 186, 211, 152, 168, 164];
    pub const DEPOSIT_RESERVE_LIQUIDITY: [u8; 8] = [169, 201, 30, 126, 6, 205, 102, 68];
    pub const REDEEM_RESERVE_COLLATERAL: [u8; 8] = [234, 117, 181, 125, 185, 142, 220, 29];
    pub const DEPOSIT_RESERVE_LIQUIDITY_AND_OBLIGATION_COLLATERAL_V2: [u8; 8] =
        [216, 224, 191, 27, 204, 151, 102, 175];
    pub const BORROW_OBLIGATION_LIQUIDITY_V2: [u8; 8] = [161, 128, 143, 245, 171, 199, 194, 6];
    pub const REPAY_OBLIGATION_LIQUIDITY_V2: [u8; 8] = [116, 174, 213, 76, 180, 53, 210, 144];
    pub const WITHDRAW_OBLIGATION_COLLATERAL_AND_REDEEM_RESERVE_COLLATERAL_V2: [u8; 8] =
        [235, 52, 119, 152, 149, 197, 20, 7];
}

fn slot(kind: AccountSlotKind, is_writable: bool, is_signer: bool, pubkey: [u8; 32]) -> AccountSlot {
    AccountSlot {
        kind,
        is_writable,
        is_signer,
        pubkey,
    }
}

fn fixed(addr: Address, is_writable: bool) -> AccountSlot {
    slot(AccountSlotKind::Fixed, is_writable, false, *addr.as_array())
}

fn fixed_bytes(pubkey: [u8; 32], is_writable: bool) -> AccountSlot {
    slot(AccountSlotKind::Fixed, is_writable, false, pubkey)
}

fn caller(is_writable: bool) -> AccountSlot {
    slot(AccountSlotKind::Caller, is_writable, false, [0u8; 32])
}

fn caller_remaining() -> AccountSlot {
    slot(AccountSlotKind::CallerRemaining, false, false, [0u8; 32])
}

fn kamino_refresh_reserve_companion() -> CompanionRequirement {
    CompanionRequirement {
        program_id: *KAMINO_LEND_ID.as_array(),
        discriminator: kamino_disc::REFRESH_RESERVE,
        disc_len: 8,
        must_precede: true,
    }
}

fn kamino_refresh_obligation_companion() -> CompanionRequirement {
    CompanionRequirement {
        program_id: *KAMINO_LEND_ID.as_array(),
        discriminator: kamino_disc::REFRESH_OBLIGATION,
        disc_len: 8,
        must_precede: true,
    }
}

fn anchor_u64_template(disc: [u8; 8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(16);
    v.extend_from_slice(&disc);
    v.extend_from_slice(&[0u8; 8]);
    v
}

/// 1. `jupiter.swap` — universal flow hook for Jupiter v6 routes (`route_v2`, `route`).
pub fn jupiter_swap_hook() -> PublishHookArgs {
    jupiter_swap_hook_from_positions(1, 2, 3)
}

pub fn jupiter_swap_hook_from_positions(
    stage_pda_idx: usize,
    stage_in_idx: usize,
    stage_out_idx: usize,
) -> PublishHookArgs {
    let max_fixed = stage_pda_idx.max(stage_in_idx).max(stage_out_idx);
    let mut slots = Vec::with_capacity(max_fixed + 2);
    for i in 0..=max_fixed {
        if i == stage_pda_idx {
            slots.push(slot(AccountSlotKind::StagePda, false, true, [0u8; 32]));
        } else if i == stage_in_idx {
            slots.push(slot(AccountSlotKind::StageIn, true, false, [0u8; 32]));
        } else if i == stage_out_idx {
            slots.push(slot(AccountSlotKind::StageOut, true, false, [0u8; 32]));
        } else {
            slots.push(caller(false));
        }
    }
    slots.push(caller_remaining());
    PublishHookArgs {
        hook_id: "jupiter.swap".to_string(),
        target_program: *JUPITER_V6_ID.as_array(),
        kind: HookKind::Flow,
        mint_in: MintConstraint::Any,
        mint_out: MintConstraint::Any,
        wrap_sol_in: true,
        unwrap_sol_out: true,
        data_template: Vec::new(),
        data_slots: vec![DataSlot {
            offset: 0,
            len: 0,
            kind: DataSlotKind::CallerTail,
        }],
        account_slots: slots,
        companions: Vec::new(),
    }
}

/// 2. `kamino.supply` — Kamino Lend `deposit_reserve_liquidity` (liquidity -> cToken).
/// Requires a preceding `refresh_reserve` companion instruction.
pub fn kamino_supply_hook() -> PublishHookArgs {
    PublishHookArgs {
        hook_id: "kamino.supply".to_string(),
        target_program: *KAMINO_LEND_ID.as_array(),
        kind: HookKind::Flow,
        mint_in: MintConstraint::Any,
        mint_out: MintConstraint::Any,
        wrap_sol_in: true,
        unwrap_sol_out: false,
        data_template: anchor_u64_template(kamino_disc::DEPOSIT_RESERVE_LIQUIDITY),
        data_slots: vec![DataSlot {
            offset: 8,
            len: 8,
            kind: DataSlotKind::AmountInU64Le,
        }],
        account_slots: vec![
            slot(AccountSlotKind::StagePda, false, true, [0u8; 32]), // 0: owner
            caller(true),                                            // 1: reserve
            caller(false),                                           // 2: lending_market
            caller(false),                                           // 3: lending_market_authority
            caller(false),                                           // 4: reserve_liquidity_mint
            caller(true),                                            // 5: reserve_liquidity_supply
            caller(true),                                            // 6: reserve_collateral_mint
            slot(AccountSlotKind::StageIn, true, false, [0u8; 32]),  // 7: user_source_liquidity
            slot(AccountSlotKind::StageOut, true, false, [0u8; 32]), // 8: user_destination_collateral
            fixed_bytes(SPL_TOKEN_PROGRAM_ID, false),                // 9: collateral_token_program
            caller(false),                                           // 10: liquidity_token_program
            fixed_bytes(INSTRUCTIONS_SYSVAR_ID, false),              // 11: instruction_sysvar_account
        ],
        companions: vec![kamino_refresh_reserve_companion()],
    }
}

/// 3. `kamino.withdraw` — Kamino Lend `redeem_reserve_collateral` (cToken -> liquidity).
/// Requires a preceding `refresh_reserve` companion instruction.
pub fn kamino_withdraw_hook() -> PublishHookArgs {
    PublishHookArgs {
        hook_id: "kamino.withdraw".to_string(),
        target_program: *KAMINO_LEND_ID.as_array(),
        kind: HookKind::Flow,
        mint_in: MintConstraint::Any,
        mint_out: MintConstraint::Any,
        wrap_sol_in: false,
        unwrap_sol_out: true,
        data_template: anchor_u64_template(kamino_disc::REDEEM_RESERVE_COLLATERAL),
        data_slots: vec![DataSlot {
            offset: 8,
            len: 8,
            kind: DataSlotKind::AmountInU64Le,
        }],
        account_slots: vec![
            slot(AccountSlotKind::StagePda, false, true, [0u8; 32]), // 0: owner
            caller(false),                                           // 1: lending_market
            caller(true),                                            // 2: reserve
            caller(false),                                           // 3: lending_market_authority
            caller(false),                                           // 4: reserve_liquidity_mint
            caller(true),                                            // 5: reserve_collateral_mint
            caller(true),                                            // 6: reserve_liquidity_supply
            slot(AccountSlotKind::StageIn, true, false, [0u8; 32]),  // 7: user_source_collateral
            slot(AccountSlotKind::StageOut, true, false, [0u8; 32]), // 8: user_destination_liquidity
            fixed_bytes(SPL_TOKEN_PROGRAM_ID, false),                // 9: collateral_token_program
            caller(false),                                           // 10: liquidity_token_program
            fixed_bytes(INSTRUCTIONS_SYSVAR_ID, false),              // 11: instruction_sysvar_account
        ],
        companions: vec![kamino_refresh_reserve_companion()],
    }
}

/// 4. `jito.stake` — SPL Stake Pool `DepositSol` (opcode 14) on Jito Stake Pool (SOL -> JitoSOL).
pub fn jito_stake_hook() -> PublishHookArgs {
    let mut tpl = vec![0u8; 9];
    tpl[0] = 14; // StakePoolInstruction::DepositSol(u64)
    PublishHookArgs {
        hook_id: "jito.stake".to_string(),
        target_program: *JITO_STAKE_POOL_PROGRAM_ID.as_array(),
        kind: HookKind::Flow,
        mint_in: MintConstraint::Sol,
        mint_out: MintConstraint::Spl(*JITOSOL_MINT_ID.as_array()),
        wrap_sol_in: false,
        unwrap_sol_out: false,
        data_template: tpl,
        data_slots: vec![DataSlot {
            offset: 1,
            len: 8,
            kind: DataSlotKind::AmountInU64Le,
        }],
        account_slots: vec![
            fixed(JITO_STAKE_POOL_ID, true),                          // 0: stake_pool
            fixed(JITO_WITHDRAW_AUTHORITY_ID, false),                 // 1: stake_pool_withdraw_authority
            fixed(JITO_RESERVE_STAKE_ID, true),                       // 2: reserve_stake_account
            slot(AccountSlotKind::StagePda, true, true, [0u8; 32]),   // 3: lamports_from
            slot(AccountSlotKind::StageOut, true, false, [0u8; 32]),  // 4: pool_tokens_to
            fixed(JITO_MANAGER_FEE_ACCOUNT_ID, true),                 // 5: manager_fee_account
            fixed(JITO_MANAGER_FEE_ACCOUNT_ID, true),                 // 6: referrer_pool_tokens_account
            fixed(JITOSOL_MINT_ID, true),                             // 7: pool_mint
            fixed_bytes(SYSTEM_PROGRAM_ID, false),                    // 8: system_program
            fixed_bytes(SPL_TOKEN_PROGRAM_ID, false),                 // 9: token_program
        ],
        companions: Vec::new(),
    }
}

/// 5. `jito.unstake` — SPL Stake Pool `WithdrawSol` (opcode 16) on Jito Stake Pool (JitoSOL -> SOL).
pub fn jito_unstake_hook() -> PublishHookArgs {
    let mut tpl = vec![0u8; 9];
    tpl[0] = 16; // StakePoolInstruction::WithdrawSol(u64)
    PublishHookArgs {
        hook_id: "jito.unstake".to_string(),
        target_program: *JITO_STAKE_POOL_PROGRAM_ID.as_array(),
        kind: HookKind::Flow,
        mint_in: MintConstraint::Spl(*JITOSOL_MINT_ID.as_array()),
        mint_out: MintConstraint::Sol,
        wrap_sol_in: false,
        unwrap_sol_out: false,
        data_template: tpl,
        data_slots: vec![DataSlot {
            offset: 1,
            len: 8,
            kind: DataSlotKind::AmountInU64Le,
        }],
        account_slots: vec![
            fixed(JITO_STAKE_POOL_ID, true),                          // 0: stake_pool
            fixed(JITO_WITHDRAW_AUTHORITY_ID, false),                 // 1: stake_pool_withdraw_authority
            slot(AccountSlotKind::StagePda, false, true, [0u8; 32]),  // 2: user_transfer_authority
            slot(AccountSlotKind::StageIn, true, false, [0u8; 32]),   // 3: pool_tokens_from
            fixed(JITO_RESERVE_STAKE_ID, true),                       // 4: reserve_stake_account
            slot(AccountSlotKind::StageOut, true, false, [0u8; 32]),  // 5: lamports_to
            fixed(JITO_MANAGER_FEE_ACCOUNT_ID, true),                 // 6: manager_fee_account
            fixed(JITOSOL_MINT_ID, true),                             // 7: pool_mint
            fixed(SYSVAR_CLOCK_ID, false),                            // 8: sysvar_clock
            fixed(SYSVAR_STAKE_HISTORY_ID, false),                    // 9: sysvar_stake_history
            fixed(STAKE_PROGRAM_ID, false),                           // 10: stake_program
            fixed_bytes(SPL_TOKEN_PROGRAM_ID, false),                 // 11: token_program
        ],
        companions: Vec::new(),
    }
}

/// 6. `kamino.collateral.deposit` — Kamino Lend `deposit_reserve_liquidity_and_obligation_collateral_v2`.
/// Seat hook (`RunKind::SeatFund`). Trailing `CallerRemaining`: `[obligation_farm_user_state, reserve_farm_state, farms_program]`.
pub fn kamino_collateral_deposit_hook() -> PublishHookArgs {
    PublishHookArgs {
        hook_id: "kamino.collateral.deposit".to_string(),
        target_program: *KAMINO_LEND_ID.as_array(),
        kind: HookKind::Seat,
        mint_in: MintConstraint::Any,
        mint_out: MintConstraint::None,
        wrap_sol_in: true,
        unwrap_sol_out: false,
        data_template: anchor_u64_template(
            kamino_disc::DEPOSIT_RESERVE_LIQUIDITY_AND_OBLIGATION_COLLATERAL_V2,
        ),
        data_slots: vec![DataSlot {
            offset: 8,
            len: 8,
            kind: DataSlotKind::AmountInU64Le,
        }],
        account_slots: vec![
            slot(AccountSlotKind::SeatPda, true, true, [0u8; 32]), // 0: owner
            caller(true),                                          // 1: obligation
            caller(false),                                         // 2: lending_market
            caller(false),                                         // 3: lending_market_authority
            caller(true),                                          // 4: reserve
            caller(false),                                         // 5: reserve_liquidity_mint
            caller(true),                                          // 6: reserve_liquidity_supply
            caller(true),                                          // 7: reserve_collateral_mint
            caller(true),                                          // 8: reserve_destination_deposit_collateral
            slot(AccountSlotKind::StageIn, true, false, [0u8; 32]), // 9: user_source_liquidity (seat ATA)
            fixed(KAMINO_LEND_ID, false),                          // 10: placeholder_user_destination_collateral (None)
            fixed_bytes(SPL_TOKEN_PROGRAM_ID, false),              // 11: collateral_token_program
            caller(false),                                         // 12: liquidity_token_program
            fixed_bytes(INSTRUCTIONS_SYSVAR_ID, false),            // 13: instruction_sysvar_account
            caller_remaining(),                                    // 14..: [obligation_farm, reserve_farm, farms_program]
        ],
        companions: vec![
            kamino_refresh_reserve_companion(),
            kamino_refresh_obligation_companion(),
        ],
    }
}

/// 7. `kamino.borrow` — Kamino Lend `borrow_obligation_liquidity_v2`.
/// Seat hook (`RunKind::SeatAction`). Caller passes `liquidity_amount: u64` LE in `caller_data`.
/// Trailing `CallerRemaining`: `[obligation_farm_user_state, reserve_farm_state, farms_program, ..deposit_reserves]`.
pub fn kamino_borrow_hook() -> PublishHookArgs {
    PublishHookArgs {
        hook_id: "kamino.borrow".to_string(),
        target_program: *KAMINO_LEND_ID.as_array(),
        kind: HookKind::Seat,
        mint_in: MintConstraint::None,
        mint_out: MintConstraint::Any,
        wrap_sol_in: false,
        unwrap_sol_out: true,
        data_template: anchor_u64_template(kamino_disc::BORROW_OBLIGATION_LIQUIDITY_V2),
        data_slots: vec![DataSlot {
            offset: 8,
            len: 8,
            kind: DataSlotKind::CallerSlice,
        }],
        account_slots: vec![
            slot(AccountSlotKind::SeatPda, false, true, [0u8; 32]), // 0: owner
            caller(true),                                           // 1: obligation
            caller(false),                                          // 2: lending_market
            caller(false),                                          // 3: lending_market_authority
            caller(true),                                           // 4: borrow_reserve
            caller(false),                                          // 5: borrow_reserve_liquidity_mint
            caller(true),                                           // 6: reserve_source_liquidity
            caller(true),                                           // 7: borrow_reserve_liquidity_fee_receiver
            slot(AccountSlotKind::StageOut, true, false, [0u8; 32]), // 8: user_destination_liquidity (seat ATA)
            fixed(KAMINO_LEND_ID, false),                           // 9: referrer_token_state (None)
            caller(false),                                          // 10: token_program
            fixed_bytes(INSTRUCTIONS_SYSVAR_ID, false),             // 11: instruction_sysvar_account
            caller_remaining(), // 12..: [obligation_farm, reserve_farm, farms_program, ..deposit_reserves]
        ],
        companions: vec![
            kamino_refresh_reserve_companion(),
            kamino_refresh_obligation_companion(),
        ],
    }
}

/// 8. `kamino.repay` — Kamino Lend `repay_obligation_liquidity_v2`.
/// Seat hook (`RunKind::SeatFund`).
/// Trailing `CallerRemaining`: `[obligation_farm_user_state, reserve_farm_state, lending_market_authority, farms_program, ..deposit_reserves]`.
pub fn kamino_repay_hook() -> PublishHookArgs {
    PublishHookArgs {
        hook_id: "kamino.repay".to_string(),
        target_program: *KAMINO_LEND_ID.as_array(),
        kind: HookKind::Seat,
        mint_in: MintConstraint::Any,
        mint_out: MintConstraint::None,
        wrap_sol_in: true,
        unwrap_sol_out: false,
        data_template: anchor_u64_template(kamino_disc::REPAY_OBLIGATION_LIQUIDITY_V2),
        data_slots: vec![DataSlot {
            offset: 8,
            len: 8,
            kind: DataSlotKind::AmountInU64Le,
        }],
        account_slots: vec![
            slot(AccountSlotKind::SeatPda, false, true, [0u8; 32]), // 0: owner
            caller(true),                                           // 1: obligation
            caller(false),                                          // 2: lending_market
            caller(true),                                           // 3: repay_reserve
            caller(false),                                          // 4: reserve_liquidity_mint
            caller(true),                                           // 5: reserve_destination_liquidity
            slot(AccountSlotKind::StageIn, true, false, [0u8; 32]), // 6: user_source_liquidity (seat ATA)
            caller(false),                                          // 7: token_program
            fixed_bytes(INSTRUCTIONS_SYSVAR_ID, false),             // 8: instruction_sysvar_account
            caller_remaining(), // 9..: [obligation_farm, reserve_farm, lma, farms_program, ..deposit_reserves]
        ],
        companions: vec![
            kamino_refresh_reserve_companion(),
            kamino_refresh_obligation_companion(),
        ],
    }
}

/// 9. `kamino.collateral.withdraw` — Kamino Lend `withdraw_obligation_collateral_and_redeem_reserve_collateral_v2`.
/// Seat hook (`RunKind::SeatAction`). Caller passes `collateral_amount: u64` LE in `caller_data` (`u64::MAX` withdraws all and closes obligation).
/// Trailing `CallerRemaining`: `[obligation_farm_user_state, reserve_farm_state, farms_program]`.
pub fn kamino_collateral_withdraw_hook() -> PublishHookArgs {
    PublishHookArgs {
        hook_id: "kamino.collateral.withdraw".to_string(),
        target_program: *KAMINO_LEND_ID.as_array(),
        kind: HookKind::Seat,
        mint_in: MintConstraint::None,
        mint_out: MintConstraint::Any,
        wrap_sol_in: false,
        unwrap_sol_out: true,
        data_template: anchor_u64_template(
            kamino_disc::WITHDRAW_OBLIGATION_COLLATERAL_AND_REDEEM_RESERVE_COLLATERAL_V2,
        ),
        data_slots: vec![DataSlot {
            offset: 8,
            len: 8,
            kind: DataSlotKind::CallerSlice,
        }],
        account_slots: vec![
            slot(AccountSlotKind::SeatPda, true, true, [0u8; 32]), // 0: owner (receives obligation rent if closed)
            caller(true),                                          // 1: obligation
            caller(false),                                         // 2: lending_market
            caller(false),                                         // 3: lending_market_authority
            caller(true),                                          // 4: withdraw_reserve
            caller(false),                                         // 5: reserve_liquidity_mint
            caller(true),                                          // 6: reserve_source_collateral
            caller(true),                                          // 7: reserve_collateral_mint
            caller(true),                                          // 8: reserve_liquidity_supply
            slot(AccountSlotKind::StageOut, true, false, [0u8; 32]), // 9: user_destination_liquidity (seat ATA)
            fixed(KAMINO_LEND_ID, false),                          // 10: placeholder_user_destination_collateral (None)
            fixed_bytes(SPL_TOKEN_PROGRAM_ID, false),              // 11: collateral_token_program
            caller(false),                                         // 12: liquidity_token_program
            fixed_bytes(INSTRUCTIONS_SYSVAR_ID, false),            // 13: instruction_sysvar_account
            caller_remaining(),                                    // 14..: [obligation_farm, reserve_farm, farms_program]
        ],
        companions: vec![
            kamino_refresh_reserve_companion(),
            kamino_refresh_obligation_companion(),
        ],
    }
}

/// All nine canonical launch hooks in publication order.
pub fn launch_hooks() -> Vec<PublishHookArgs> {
    vec![
        jupiter_swap_hook(),
        kamino_supply_hook(),
        kamino_withdraw_hook(),
        jito_stake_hook(),
        jito_unstake_hook(),
        kamino_collateral_deposit_hook(),
        kamino_borrow_hook(),
        kamino_repay_hook(),
        kamino_collateral_withdraw_hook(),
    ]
}

// ============================================================================
// JSON schema for `program/hooks/<id>.json` (exact `PublishHookArgs` fields, base58 pubkeys)
// ============================================================================

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "mint")]
pub enum MintConstraintJson {
    None,
    Any,
    Sol,
    Spl(String),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DataSlotJson {
    pub offset: u16,
    pub len: u16,
    pub kind: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountSlotJson {
    pub kind: String,
    pub is_writable: bool,
    pub is_signer: bool,
    pub pubkey: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompanionRequirementJson {
    pub program_id: String,
    pub discriminator: Vec<u8>,
    pub disc_len: u8,
    pub must_precede: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublishHookJson {
    pub hook_id: String,
    pub target_program: String,
    pub kind: String,
    pub mint_in: MintConstraintJson,
    pub mint_out: MintConstraintJson,
    pub wrap_sol_in: bool,
    pub unwrap_sol_out: bool,
    pub data_template: Vec<u8>,
    pub data_slots: Vec<DataSlotJson>,
    pub account_slots: Vec<AccountSlotJson>,
    pub companions: Vec<CompanionRequirementJson>,
}

fn b58(bytes: [u8; 32]) -> String {
    Address::new_from_array(bytes).to_string()
}

fn from_b58(s: &str) -> Result<[u8; 32]> {
    let addr = Address::from_str(s).map_err(|e| anyhow!("invalid base58 pubkey {s}: {e}"))?;
    Ok(*addr.as_array())
}

pub fn to_hook_json(args: &PublishHookArgs) -> PublishHookJson {
    let mint_to_json = |m: MintConstraint| match m {
        MintConstraint::None => MintConstraintJson::None,
        MintConstraint::Any => MintConstraintJson::Any,
        MintConstraint::Sol => MintConstraintJson::Sol,
        MintConstraint::Spl(p) => MintConstraintJson::Spl(b58(p)),
    };
    PublishHookJson {
        hook_id: args.hook_id.clone(),
        target_program: b58(args.target_program),
        kind: match args.kind {
            HookKind::Flow => "Flow".to_string(),
            HookKind::Seat => "Seat".to_string(),
        },
        mint_in: mint_to_json(args.mint_in),
        mint_out: mint_to_json(args.mint_out),
        wrap_sol_in: args.wrap_sol_in,
        unwrap_sol_out: args.unwrap_sol_out,
        data_template: args.data_template.clone(),
        data_slots: args
            .data_slots
            .iter()
            .map(|s| DataSlotJson {
                offset: s.offset,
                len: s.len,
                kind: match s.kind {
                    DataSlotKind::AmountInU64Le => "AmountInU64Le",
                    DataSlotKind::MinOutU64Le => "MinOutU64Le",
                    DataSlotKind::CallerSlice => "CallerSlice",
                    DataSlotKind::CallerTail => "CallerTail",
                }
                .to_string(),
            })
            .collect(),
        account_slots: args
            .account_slots
            .iter()
            .map(|s| AccountSlotJson {
                kind: match s.kind {
                    AccountSlotKind::Fixed => "Fixed",
                    AccountSlotKind::StagePda => "StagePda",
                    AccountSlotKind::StageIn => "StageIn",
                    AccountSlotKind::StageOut => "StageOut",
                    AccountSlotKind::SeatPda => "SeatPda",
                    AccountSlotKind::Caller => "Caller",
                    AccountSlotKind::CallerRemaining => "CallerRemaining",
                    AccountSlotKind::Payer => "Payer",
                }
                .to_string(),
                is_writable: s.is_writable,
                is_signer: s.is_signer,
                pubkey: b58(s.pubkey),
            })
            .collect(),
        companions: args
            .companions
            .iter()
            .map(|c| CompanionRequirementJson {
                program_id: b58(c.program_id),
                discriminator: c.discriminator.to_vec(),
                disc_len: c.disc_len,
                must_precede: c.must_precede,
            })
            .collect(),
    }
}

pub fn from_hook_json(json: &PublishHookJson) -> Result<PublishHookArgs> {
    let parse_mint = |m: &MintConstraintJson| -> Result<MintConstraint> {
        Ok(match m {
            MintConstraintJson::None => MintConstraint::None,
            MintConstraintJson::Any => MintConstraint::Any,
            MintConstraintJson::Sol => MintConstraint::Sol,
            MintConstraintJson::Spl(s) => MintConstraint::Spl(from_b58(s)?),
        })
    };
    let kind = match json.kind.as_str() {
        "Flow" => HookKind::Flow,
        "Seat" => HookKind::Seat,
        other => return Err(anyhow!("unknown HookKind: {other}")),
    };
    let data_slots = json
        .data_slots
        .iter()
        .map(|s| {
            let k = match s.kind.as_str() {
                "AmountInU64Le" => DataSlotKind::AmountInU64Le,
                "MinOutU64Le" => DataSlotKind::MinOutU64Le,
                "CallerSlice" => DataSlotKind::CallerSlice,
                "CallerTail" => DataSlotKind::CallerTail,
                other => return Err(anyhow!("unknown DataSlotKind: {other}")),
            };
            Ok(DataSlot {
                offset: s.offset,
                len: s.len,
                kind: k,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let account_slots = json
        .account_slots
        .iter()
        .map(|s| {
            let k = match s.kind.as_str() {
                "Fixed" => AccountSlotKind::Fixed,
                "StagePda" => AccountSlotKind::StagePda,
                "StageIn" => AccountSlotKind::StageIn,
                "StageOut" => AccountSlotKind::StageOut,
                "SeatPda" => AccountSlotKind::SeatPda,
                "Caller" => AccountSlotKind::Caller,
                "CallerRemaining" => AccountSlotKind::CallerRemaining,
                "Payer" => AccountSlotKind::Payer,
                other => return Err(anyhow!("unknown AccountSlotKind: {other}")),
            };
            Ok(AccountSlot {
                kind: k,
                is_writable: s.is_writable,
                is_signer: s.is_signer,
                pubkey: from_b58(&s.pubkey)?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let companions = json
        .companions
        .iter()
        .map(|c| {
            let disc: [u8; 8] = c
                .discriminator
                .as_slice()
                .try_into()
                .map_err(|_| anyhow!("companion discriminator must be 8 bytes"))?;
            Ok(CompanionRequirement {
                program_id: from_b58(&c.program_id)?,
                discriminator: disc,
                disc_len: c.disc_len,
                must_precede: c.must_precede,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(PublishHookArgs {
        hook_id: json.hook_id.clone(),
        target_program: from_b58(&json.target_program)?,
        kind,
        mint_in: parse_mint(&json.mint_in)?,
        mint_out: parse_mint(&json.mint_out)?,
        wrap_sol_in: json.wrap_sol_in,
        unwrap_sol_out: json.unwrap_sol_out,
        data_template: json.data_template.clone(),
        data_slots,
        account_slots,
        companions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_hooks_json_roundtrip_and_export() -> Result<()> {
        let hooks = launch_hooks();
        assert_eq!(hooks.len(), 9);
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../hooks");
        std::fs::create_dir_all(&dir)?;
        for h in &hooks {
            let j = to_hook_json(h);
            let serialized = serde_json::to_string_pretty(&j)?;
            let parsed: PublishHookJson = serde_json::from_str(&serialized)?;
            let back = from_hook_json(&parsed)?;
            assert_eq!(h, &back, "JSON roundtrip mismatch for {}", h.hook_id);
            let path = dir.join(format!("{}.json", h.hook_id));
            if std::env::var_os("POOK_WRITE_HOOK_JSONS").is_some() || !path.exists() {
                std::fs::write(&path, format!("{serialized}\n"))?;
            } else {
                let on_disk: PublishHookJson = serde_json::from_str(&std::fs::read_to_string(&path)?)?;
                assert_eq!(j, on_disk, "on-disk hook JSON out of sync for {}", h.hook_id);
            }
        }
        Ok(())
    }
}
