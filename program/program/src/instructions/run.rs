use alloc::vec::Vec;
use pinocchio::{
    address::address_eq,
    cpi::{invoke_signed_with_bounds, Seed, Signer},
    error::ProgramError,
    instruction::{InstructionAccount, InstructionView},
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    AccountView, Address, ProgramResult,
};
use spr_account_checks::AccountIterator;
use spr_hasher::primitives::{hash_bytes, solana_owner_identity};
use spr_interface::{
    instruction::{instruction_data::transact::InterfaceTransfer, settlement_accounts},
    PROGRAM_ID_PUBKEY,
};
use spr_program::{CompressedProof, PublicTransfer};
use wincode::{containers, len::FixIntLen, SchemaRead, SchemaWrite};

use crate::{
    error::PookError,
    instructions::{
        hook::load_hook,
        shared::{
            check_not_expired, check_system_program, check_token_account_mint_and_owner,
            compute_call_hash, compute_fee_split, cpi_close_token_account, cpi_spp_deposit_batch,
            cpi_spp_transact_with_authority, cpi_sync_native, cpi_system_transfer,
            cpi_token_transfer_checked, create_pda_account, derive_authority, derive_stage,
            is_valid_token_program, load_config, read_mint_decimals, read_token_amount, IxData,
            SppDepositLeg,
        },
    },
    pda::{
        find_ata, find_author_fees_pda, find_config_pda, find_seat_pda, find_seat_state_pda,
        AUTHOR_FEES_SEED, INSTRUCTIONS_SYSVAR_ID, SEAT_SEED, STAGE_SEED, WSOL_MINT,
    },
    state::{
        disc, AccountSlotKind, AuthorFees, CompanionRequirement, DataSlotKind, Hook, HookKind, Seat,
    },
    verifier::{run as run_verifier, seat_action, seat_fund},
};

/// Selects which ZK proof verifies the `run` instruction.
#[derive(Clone, Copy, Debug, PartialEq, Eq, SchemaRead, SchemaWrite)]
#[wincode(tag_encoding = "u8")]
pub enum RunKind {
    /// Flow hook (`HookKind::Flow`, `amount_in > 0`): uses `run` verifier.
    Flow,
    /// Seat hook with input tokens (`HookKind::Seat`, `amount_in > 0`): uses `seat_fund` verifier.
    SeatFund,
    /// Seat hook without input tokens (`HookKind::Seat`, `amount_in == 0`): uses `seat_action` verifier.
    SeatAction,
}

/// Wincode-encoded arguments ahead of raw SPP `TransactIxData` bytes.
#[derive(Clone, Debug, PartialEq, Eq, SchemaRead, SchemaWrite)]
pub struct RunArgs {
    pub kind: RunKind,
    pub proof: CompressedProof,
    pub authority_bump: u8,
    pub stage_bump: u8,
    pub amount_in: u64,
    pub min_out: u64,
    /// One-time `owner_hash` receiving the net output note (`[0; 32]` when hook has `MintConstraint::None` out).
    pub output_owner_hash: [u8; 32],
    pub relayer_fee: u64,
    pub expiry: u64,
    /// Seat commitment (`[0; 32]` for `RunKind::Flow`).
    pub seat_commitment: [u8; 32],
    /// Runtime input mint (`[0; 32]` for native SOL or when `amount_in == 0`).
    pub mint_in: [u8; 32],
    /// Runtime output mint (`[0; 32]` for native SOL or when `has_mint_out == false`).
    pub mint_out: [u8; 32],
    pub has_mint_out: bool,
    /// Canonical bump of SPP's `spl_interface` PDA for `mint_out` (ignored for SOL or no output).
    pub out_spl_interface_bump: u8,
    /// Number of accounts belonging to the SPP `transact` CPI slice.
    pub spp_account_count: u8,
    /// Caller-supplied instruction data bytes substituted into `CallerSlice` / `CallerTail` data slots.
    #[wincode(with = "containers::Vec<u8, FixIntLen<u16>>")]
    pub caller_data: Vec<u8>,
    /// Per-account writable flags for `CallerRemaining` accounts (0 = readonly, 1 = writable).
    #[wincode(with = "containers::Vec<u8, FixIntLen<u8>>")]
    pub caller_remaining_writable: Vec<u8>,
}

pub fn process_run(accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let IxData {
        args,
        transact,
        transact_bytes,
    } = IxData::<RunArgs>::parse(data)?;

    // 1. Check expiry against Clock and transact.expiry_unix_ts.
    let clock = Clock::get()?;
    check_not_expired(clock.unix_timestamp, args.expiry)?;
    if transact.expiry_unix_ts != args.expiry {
        return Err(PookError::InvalidInstructionData.into());
    }

    // 2. Parse fixed header accounts.
    let mut iter = AccountIterator::new(accounts);
    let payer = iter.next_signer_mut("payer")?;
    let config_acct = iter.next_account("config")?;
    let hook_acct = iter.next_account("hook")?;
    let stage_pda_acct = iter.next_mut("stage_pda")?;
    let target_program_acct = iter.next_account("target_program")?;
    let system_program = iter.next_account("system_program")?;
    let output_tree = iter.next_mut("output_tree")?;
    let spp_program = iter.next_account("spp_program")?;

    check_system_program(system_program)?;
    if !address_eq(spp_program.address(), &PROGRAM_ID_PUBKEY) {
        return Err(PookError::InvalidShieldedPoolProgram.into());
    }

    let (expected_config, _) = find_config_pda();
    if !address_eq(config_acct.address(), &expected_config) {
        return Err(PookError::InvalidConfigAccount.into());
    }
    let config = load_config(config_acct)?;
    let hook = load_hook(hook_acct)?;

    if target_program_acct.address().as_array() != &hook.target_program {
        return Err(PookError::TargetProgramMismatch.into());
    }

    let authority_pda = derive_authority(args.authority_bump)?;
    let stage_pda = derive_stage(args.stage_bump)?;
    if !address_eq(stage_pda_acct.address(), &stage_pda) {
        return Err(PookError::InvalidStagePda.into());
    }

    // Validate hook kind vs RunKind and mint constraints.
    match (hook.kind, args.kind) {
        (HookKind::Flow, RunKind::Flow) => {
            if args.amount_in == 0 {
                return Err(PookError::InvalidInstructionData.into());
            }
        }
        (HookKind::Seat, RunKind::SeatFund) => {
            if args.amount_in == 0 {
                return Err(PookError::InvalidInstructionData.into());
            }
        }
        (HookKind::Seat, RunKind::SeatAction) => {
            if args.amount_in != 0 {
                return Err(PookError::InvalidInstructionData.into());
            }
        }
        _ => return Err(PookError::WrongHookKind.into()),
    }

    let has_mint_in = args.amount_in > 0;
    if !hook.mint_in.matches(!has_mint_in, &args.mint_in) {
        return Err(PookError::MintConstraintViolated.into());
    }
    if !hook.mint_out.matches(!args.has_mint_out, &args.mint_out) {
        return Err(PookError::MintConstraintViolated.into());
    }

    let in_is_sol = has_mint_in && args.mint_in == [0u8; 32];
    let out_is_sol = args.has_mint_out && args.mint_out == [0u8; 32];

    // For Seat hooks, stage token accounts are ATAs owned by `seat_pda` so target protocols
    // that enforce `token::authority == obligation.owner` (e.g. Kamino Lend) work directly.
    // For Flow hooks, stage token accounts are ATAs owned by `stage_pda`.
    let (expected_seat_pda, _) = if hook.kind == HookKind::Seat {
        find_seat_pda(&args.seat_commitment)
    } else {
        (Address::default(), 0u8)
    };
    let token_stage_owner = if hook.kind == HookKind::Seat {
        expected_seat_pda
    } else {
        stage_pda
    };

    // 3. Parse input stage settlement accounts.
    let mut token_program_in: Option<&AccountView> = None;
    let mut mint_in_acct: Option<&AccountView> = None;
    let mut stage_in_token_acct: Option<&AccountView> = None;
    let mut wsol_in_lamports_before: u64 = 0;
    let stage_in_for_spp: Address;
    let stage_in_for_hook: Option<&AccountView>;

    if !has_mint_in {
        stage_in_for_spp = stage_pda;
        stage_in_for_hook = None;
    } else if in_is_sol && !hook.wrap_sol_in {
        stage_in_for_spp = stage_pda;
        stage_in_for_hook = Some(stage_pda_acct);
    } else if in_is_sol && hook.wrap_sol_in {
        let tp = iter.next_account("token_program_in")?;
        let wsol_ata = iter.next_mut("stage_in_wsol_ata")?;
        if !is_valid_token_program(tp.address()) {
            return Err(PookError::InvalidTokenProgram.into());
        }
        let (expected_wsol, _) = find_ata(
            token_stage_owner.as_array(),
            &WSOL_MINT,
            tp.address().as_array(),
        );
        if !address_eq(wsol_ata.address(), &expected_wsol) {
            return Err(PookError::InvalidStageTokenAccount.into());
        }
        check_token_account_mint_and_owner(wsol_ata, &WSOL_MINT, token_stage_owner.as_array())?;
        wsol_in_lamports_before = wsol_ata.lamports();
        token_program_in = Some(tp);
        stage_in_token_acct = Some(wsol_ata);
        stage_in_for_spp = stage_pda;
        stage_in_for_hook = Some(wsol_ata);
    } else {
        let tp = iter.next_account("token_program_in")?;
        let mint_in_view = iter.next_account("mint_in")?;
        let stage_ata = iter.next_mut("stage_in_ata")?;
        if !is_valid_token_program(tp.address()) {
            return Err(PookError::InvalidTokenProgram.into());
        }
        if mint_in_view.address().as_array() != &args.mint_in {
            return Err(PookError::InvalidStageTokenAccount.into());
        }
        let (expected_ata, _) = find_ata(
            token_stage_owner.as_array(),
            &args.mint_in,
            tp.address().as_array(),
        );
        if !address_eq(stage_ata.address(), &expected_ata) {
            return Err(PookError::InvalidStageTokenAccount.into());
        }
        check_token_account_mint_and_owner(stage_ata, &args.mint_in, token_stage_owner.as_array())?;
        token_program_in = Some(tp);
        mint_in_acct = Some(mint_in_view);
        stage_in_token_acct = Some(stage_ata);
        stage_in_for_spp = *stage_ata.address();
        stage_in_for_hook = Some(stage_ata);
    }

    // 4. Parse output stage & fee settlement accounts.
    let mut sol_interface_out: Option<&AccountView> = None;
    let mut fee_recipient_acct: Option<&AccountView> = None;
    let mut author_fees_acct: Option<&mut AccountView> = None;
    let mut author_fees_ata_acct: Option<&AccountView> = None;
    let mut token_program_out: Option<&AccountView> = None;
    let mut mint_out_acct: Option<&AccountView> = None;
    let mut stage_out_token_acct: Option<&AccountView> = None;
    let mut spl_interface_out: Option<&AccountView> = None;
    let mut relayer_fee_ata: Option<&AccountView> = None;
    let mut stage_out_for_hook: Option<&AccountView> = None;
    let mut wsol_out_lamports_before: u64 = 0;

    if args.has_mint_out {
        if out_is_sol {
            let sol_if = iter.next_mut("sol_interface_out")?;
            let fee_rec = iter.next_mut("fee_recipient")?;
            let auth_fees = iter.next_mut("author_fees")?;
            if fee_rec.address().as_array() != &config.fee_recipient {
                return Err(PookError::InvalidFeeRecipient.into());
            }
            let (expected_af, _) = find_author_fees_pda(&hook.author, &[0u8; 32]);
            if !address_eq(auth_fees.address(), &expected_af) {
                return Err(PookError::InvalidAuthorFeesAccount.into());
            }
            sol_interface_out = Some(sol_if);
            fee_recipient_acct = Some(fee_rec);
            author_fees_acct = Some(auth_fees);

            if hook.unwrap_sol_out {
                let tp = iter.next_account("token_program_out")?;
                let wsol_ata = iter.next_mut("stage_out_wsol_ata")?;
                if !is_valid_token_program(tp.address()) {
                    return Err(PookError::InvalidTokenProgram.into());
                }
                let (expected_wsol, _) = find_ata(
                    token_stage_owner.as_array(),
                    &WSOL_MINT,
                    tp.address().as_array(),
                );
                if !address_eq(wsol_ata.address(), &expected_wsol) {
                    return Err(PookError::InvalidStageTokenAccount.into());
                }
                check_token_account_mint_and_owner(
                    wsol_ata,
                    &WSOL_MINT,
                    token_stage_owner.as_array(),
                )?;
                wsol_out_lamports_before = wsol_ata.lamports();
                token_program_out = Some(tp);
                stage_out_token_acct = Some(wsol_ata);
                stage_out_for_hook = Some(wsol_ata);
            } else {
                stage_out_for_hook = Some(stage_pda_acct);
            }
        } else {
            let tp = iter.next_account("token_program_out")?;
            let mint_o = iter.next_account("mint_out")?;
            let stage_ata = iter.next_mut("stage_out_ata")?;
            let spl_if = iter.next_mut("spl_interface_out")?;
            let fee_rec_ata = iter.next_mut("fee_recipient_ata")?;
            let auth_fees = iter.next_mut("author_fees")?;
            let auth_fees_ata = iter.next_mut("author_fees_ata")?;
            let rel_ata = iter.next_mut("relayer_fee_ata")?;

            if !is_valid_token_program(tp.address()) {
                return Err(PookError::InvalidTokenProgram.into());
            }
            if mint_o.address().as_array() != &args.mint_out {
                return Err(PookError::InvalidStageTokenAccount.into());
            }
            let (expected_stage_out, _) = find_ata(
                token_stage_owner.as_array(),
                &args.mint_out,
                tp.address().as_array(),
            );
            if !address_eq(stage_ata.address(), &expected_stage_out) {
                return Err(PookError::InvalidStageTokenAccount.into());
            }
            check_token_account_mint_and_owner(
                stage_ata,
                &args.mint_out,
                token_stage_owner.as_array(),
            )?;
            let (expected_fee_ata, _) = find_ata(
                &config.fee_recipient,
                &args.mint_out,
                tp.address().as_array(),
            );
            if !address_eq(fee_rec_ata.address(), &expected_fee_ata) {
                return Err(PookError::InvalidFeeRecipient.into());
            }
            let (expected_af, _) = find_author_fees_pda(&hook.author, &args.mint_out);
            if !address_eq(auth_fees.address(), &expected_af) {
                return Err(PookError::InvalidAuthorFeesAccount.into());
            }
            let (expected_af_ata, _) =
                find_ata(auth_fees.address().as_array(), &args.mint_out, tp.address().as_array());
            if !address_eq(auth_fees_ata.address(), &expected_af_ata) {
                return Err(PookError::InvalidAuthorFeesAccount.into());
            }

            token_program_out = Some(tp);
            mint_out_acct = Some(mint_o);
            stage_out_token_acct = Some(stage_ata);
            spl_interface_out = Some(spl_if);
            fee_recipient_acct = Some(fee_rec_ata);
            author_fees_acct = Some(auth_fees);
            author_fees_ata_acct = Some(auth_fees_ata);
            relayer_fee_ata = Some(rel_ata);
            stage_out_for_hook = Some(stage_ata);
        }
    }

    // 5. Parse optional Seat accounts (when HookKind::Seat).
    let mut seat_state_acct: Option<&AccountView> = None;
    let mut seat_pda_acct: Option<&AccountView> = None;
    let mut seat_pda_bump: u8 = 0;

    if hook.kind == HookKind::Seat {
        let ss = iter.next_account("seat_state")?;
        let sp = iter.next_mut("seat_pda")?;
        let (expected_ss, _) = find_seat_state_pda(&args.seat_commitment);
        if !address_eq(ss.address(), &expected_ss) || !address_eq(ss.owner(), &crate::ID) {
            return Err(PookError::InvalidSeatAccount.into());
        }
        let seat_state = {
            let raw = ss.try_borrow()?;
            if raw.len() < Seat::LEN || raw[0..8] != disc::SEAT {
                return Err(PookError::InvalidSeatAccount.into());
            }
            borsh::from_slice::<Seat>(&raw[..Seat::LEN])
                .map_err(|_| PookError::InvalidSeatAccount)?
        };
        if seat_state.commitment != args.seat_commitment {
            return Err(PookError::InvalidSeatAccount.into());
        }
        let (expected_sp, sp_bump) = find_seat_pda(&args.seat_commitment);
        if !address_eq(sp.address(), &expected_sp) {
            return Err(PookError::InvalidSeatAccount.into());
        }
        seat_state_acct = Some(ss);
        seat_pda_acct = Some(sp);
        seat_pda_bump = sp_bump;
    }

    // 6. Check required companion instructions via Instructions sysvar (if hook specifies any).
    if !hook.companions.is_empty() {
        let ix_sysvar = iter.next_account("instructions_sysvar")?;
        if ix_sysvar.address().as_array() != &INSTRUCTIONS_SYSVAR_ID {
            return Err(PookError::InvalidInstructionsSysvar.into());
        }
        verify_companions(ix_sysvar, &hook.companions)?;
    }

    // 7. Split remaining accounts into SPP transact slice + caller hook accounts slice.
    let remaining = iter.remaining()?;
    let spp_count = usize::from(args.spp_account_count);
    if remaining.len() < spp_count {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let (spp_accounts, caller_accounts) = remaining.split_at(spp_count);

    // Output tree must match SPP transact's output tree (spp_accounts[1]).
    if spp_accounts.len() < 4 || !address_eq(spp_accounts[1].address(), output_tree.address()) {
        return Err(PookError::InvalidInstructionData.into());
    }

    // Validate the SPP withdrawal leg and capture its interface account + bump so any
    // leftover input in stage-in can be deposited back to the holder in the same `deposit` CPI.
    let mut sol_interface_in: Option<&AccountView> = None;
    let mut spl_interface_in: Option<&AccountView> = None;
    let mut in_spl_interface_bump: u8 = 0;
    let public_transfer_storage;
    let transfers: &[PublicTransfer] = if has_mint_in {
        if transact.interface_transfers.len() != 1 {
            return Err(PookError::InvalidInstructionData.into());
        }
        let settlement = settlement_accounts(
            &transact.interface_transfers,
            transact.circuit,
            spp_accounts,
        )
        .ok_or(PookError::InvalidInstructionData)?;
        match transact.interface_transfers[0] {
            InterfaceTransfer::SolWithdrawal { amount } if in_is_sol && amount == args.amount_in => {
                // SolWithdrawal group: [sol_interface, recipient]
                if settlement.len() != 2 {
                    return Err(PookError::InvalidInstructionData.into());
                }
                sol_interface_in = Some(&settlement[0]);
            }
            InterfaceTransfer::SplWithdrawal {
                amount,
                spl_interface_bump,
            } if !in_is_sol && amount == args.amount_in => {
                // SplWithdrawal group: [cpi_authority, mint, spl_interface, user_token, token_program]
                if settlement.len() != 5 {
                    return Err(PookError::InvalidInstructionData.into());
                }
                spl_interface_in = Some(&settlement[2]);
                in_spl_interface_bump = spl_interface_bump;
            }
            _ => return Err(PookError::InvalidInstructionData.into()),
        }
        public_transfer_storage = [PublicTransfer {
            mint: Address::new_from_array(args.mint_in),
            is_deposit: false,
            amount: args.amount_in,
            account: stage_in_for_spp,
        }];
        &public_transfer_storage
    } else {
        if !transact.interface_transfers.is_empty() {
            return Err(PookError::InvalidInstructionData.into());
        }
        &[]
    };

    // 8. Build resolved target CPI instruction data & accounts, enforcing strict Pook account isolation.
    let cpi_data = resolve_cpi_data(&hook, args.amount_in, args.min_out, &args.caller_data)?;
    let author_fees_addr = author_fees_acct.as_deref().map(|a| *a.address());
    let (cpi_views, cpi_metas, cpi_meta_tuples) = resolve_cpi_accounts(
        &hook,
        stage_pda_acct,
        stage_in_for_hook,
        stage_out_for_hook,
        seat_pda_acct,
        payer,
        caller_accounts,
        &args.caller_remaining_writable,
        &authority_pda,
        config_acct.address(),
        hook_acct.address(),
        output_tree.address(),
        author_fees_addr.as_ref(),
        author_fees_ata_acct.map(|a| a.address()),
        fee_recipient_acct.map(|a| a.address()),
        seat_state_acct.map(|a| a.address()),
        spl_interface_out.map(|a| a.address()),
        spl_interface_in.map(|a| a.address()),
        sol_interface_in.map(|a| a.address()),
    )?;

    // 9. Compute public inputs and verify the ZK proof BEFORE moving any funds.
    let authority_identity = solana_owner_identity(authority_pda.as_array())?;
    let hook_hash = hash_bytes(hook_acct.address().as_array())?;
    let call_hash = compute_call_hash(
        &hook.target_program,
        args.has_mint_out,
        &args.mint_out,
        &cpi_data,
        &cpi_meta_tuples,
    )?;

    verify_run_proof(
        &args,
        authority_identity,
        hook_hash,
        call_hash,
        transact.private_tx_hash,
        transfers,
    )?;

    // Snapshot stage balances BEFORE the SPP withdrawal leg so pre-existing balances
    // neither block the run nor count toward its output or leftover input.
    let stage_lamports_before_withdraw = stage_pda_acct.lamports();
    let stage_in_token_before = match stage_in_token_acct {
        Some(tok) => read_token_amount(tok)?,
        None => 0,
    };
    let stage_out_token_before = match stage_out_token_acct {
        Some(tok) => read_token_amount(tok)?,
        None => 0,
    };

    // 10. CPI SPP `transact` signed by `authority_pda` (spends holder notes, withdraws `amount_in` to stage).
    cpi_spp_transact_with_authority(&authority_pda, args.authority_bump, spp_accounts, transact_bytes)?;

    let stage_bump_slice = [args.stage_bump];
    let stage_seeds = [Seed::from(STAGE_SEED), Seed::from(&stage_bump_slice)];

    // 11. If native SOL input needs WSOL wrapping for the hook, wrap into `stage_in_wsol_ata`.
    if in_is_sol && hook.wrap_sol_in {
        let tp = token_program_in.ok_or(PookError::InvalidTokenProgram)?;
        let wsol_ata = stage_in_token_acct.ok_or(PookError::InvalidStageTokenAccount)?;
        cpi_system_transfer(
            stage_pda_acct,
            wsol_ata,
            system_program,
            args.amount_in,
            &[Signer::from(&stage_seeds)],
        )?;
        cpi_sync_native(tp, wsol_ata)?;
    }

    // 12. CPI the target program (stage_pda / seat_pda signing; NEVER authority_pda).
    invoke_target_cpi(
        target_program_acct.address(),
        &cpi_metas,
        &cpi_data,
        &cpi_views,
        hook.kind,
        args.stage_bump,
        &args.seat_commitment,
        seat_pda_bump,
    )?;

    // Guard against target draining stage_pda rent or pre-existing lamports.
    let stage_lamports_after_cpi = stage_pda_acct.lamports();
    if stage_lamports_after_cpi < stage_lamports_before_withdraw {
        return Err(PookError::StageLamportsDrained.into());
    }

    // Compute unused portion of this run's input left in stage-in (capped at `amount_in`).
    // When stage-in and stage-out are the same account, any unused input is already part of `delta_out`.
    let same_stage_account = match (stage_in_for_hook, stage_out_for_hook) {
        (Some(a), Some(b)) => address_eq(a.address(), b.address()),
        _ => false,
    };
    let leftover_in = if !has_mint_in || same_stage_account {
        0
    } else if in_is_sol && !hook.wrap_sol_in {
        stage_lamports_after_cpi
            .saturating_sub(stage_lamports_before_withdraw)
            .min(args.amount_in)
    } else {
        let stage_in_tok = stage_in_token_acct.ok_or(PookError::InvalidStageTokenAccount)?;
        read_token_amount(stage_in_tok)?
            .saturating_sub(stage_in_token_before)
            .min(args.amount_in)
    };

    let view_tag = *authority_pda.as_array();

    // If hook had no output asset (`MintConstraint::None`), return any leftover input
    // (when `output_owner_hash != [0; 32]`) and clean up seat WSOL wrap if used.
    if !args.has_mint_out {
        return settle_no_output(
            hook.kind,
            in_is_sol,
            hook.wrap_sol_in,
            args.stage_bump,
            &args.seat_commitment,
            seat_pda_bump,
            payer,
            stage_pda_acct,
            seat_pda_acct,
            system_program,
            output_tree,
            spp_program,
            token_program_in,
            mint_in_acct,
            stage_in_token_acct,
            sol_interface_in,
            spl_interface_in,
            in_spl_interface_bump,
            wsol_in_lamports_before,
            stage_in_token_before,
            leftover_in,
            view_tag,
            args.output_owner_hash,
        );
    }

    // 13. Measure `delta_out` against pre-withdrawal stage-out balance and enforce `delta_out >= args.min_out`.
    let delta_out = if out_is_sol && !hook.unwrap_sol_out {
        stage_lamports_after_cpi
            .checked_sub(stage_lamports_before_withdraw)
            .ok_or(PookError::SlippageExceeded)?
    } else {
        let stage_out_tok = stage_out_token_acct.ok_or(PookError::InvalidStageTokenAccount)?;
        read_token_amount(stage_out_tok)?
            .checked_sub(stage_out_token_before)
            .ok_or(PookError::SlippageExceeded)?
    };

    if delta_out < args.min_out {
        return Err(PookError::SlippageExceeded.into());
    }

    // 14. Compute fee split (protocol share rounded down) on `delta_out` only, never on `leftover_in`.
    let (run_fee, protocol_fee, author_fee) = compute_fee_split(delta_out, &config)?;
    let total_fees = run_fee
        .checked_add(args.relayer_fee)
        .ok_or(PookError::Overflow)?;
    if total_fees >= delta_out {
        return Err(PookError::OutputBelowFees.into());
    }
    let net_out = delta_out - total_fees;

    // 15. Ensure `AuthorFees` PDA is initialized and accrue `author_fee`.
    let auth_fees = author_fees_acct.ok_or(PookError::InvalidAuthorFeesAccount)?;
    if author_fee > 0 {
        ensure_and_accrue_author_fees(
            payer,
            auth_fees,
            system_program,
            &hook.author,
            &args.mint_out,
            author_fee,
        )?;
    }

    // 16. Settle fees and CPI SPP `deposit` of `net_out` (plus `leftover_in` if > 0)
    // to `args.output_owner_hash` with `view_tag = authority_pda`.
    settle_output_and_leftover(
        hook.kind,
        in_is_sol,
        hook.wrap_sol_in,
        out_is_sol,
        hook.unwrap_sol_out,
        args.stage_bump,
        &args.seat_commitment,
        seat_pda_bump,
        payer,
        stage_pda_acct,
        seat_pda_acct,
        system_program,
        output_tree,
        spp_program,
        token_program_in,
        mint_in_acct,
        stage_in_token_acct,
        sol_interface_in,
        spl_interface_in,
        in_spl_interface_bump,
        wsol_in_lamports_before,
        stage_in_token_before,
        leftover_in,
        sol_interface_out,
        fee_recipient_acct.ok_or(PookError::InvalidFeeRecipient)?,
        auth_fees,
        author_fees_ata_acct,
        token_program_out,
        mint_out_acct,
        stage_out_token_acct,
        spl_interface_out,
        relayer_fee_ata,
        args.out_spl_interface_bump,
        wsol_out_lamports_before,
        stage_out_token_before,
        protocol_fee,
        author_fee,
        args.relayer_fee,
        net_out,
        view_tag,
        args.output_owner_hash,
    )
}

fn compute_wsol_rent_refund(
    wsol_ata: &AccountView,
    wsol_lamports_before: u64,
    wsol_tokens_before: u64,
) -> Result<u64, ProgramError> {
    let min_rent = Rent::get()?.try_minimum_balance(wsol_ata.data_len())?;
    Ok(wsol_lamports_before
        .saturating_sub(wsol_tokens_before)
        .min(min_rent))
}

#[inline(never)]
#[allow(clippy::too_many_arguments)]
fn unwrap_wsol_to_stage_and_refund_rent(
    hook_kind: HookKind,
    stage_bump: u8,
    seat_commitment: &[u8; 32],
    seat_pda_bump: u8,
    payer: &AccountView,
    stage_pda_acct: &AccountView,
    seat_pda_acct: Option<&AccountView>,
    system_program: &AccountView,
    tp: &AccountView,
    wsol_ata: &AccountView,
    wsol_lamports_before: u64,
    wsol_tokens_before: u64,
) -> ProgramResult {
    let stage_bump_slice = [stage_bump];
    let stage_seeds = [Seed::from(STAGE_SEED), Seed::from(&stage_bump_slice)];
    let rent_refund = compute_wsol_rent_refund(wsol_ata, wsol_lamports_before, wsol_tokens_before)?;

    if hook_kind == HookKind::Seat {
        let sp = seat_pda_acct.ok_or(PookError::InvalidSeatAccount)?;
        let seat_bump_slice = [seat_pda_bump];
        let seat_seeds = [
            Seed::from(SEAT_SEED),
            Seed::from(seat_commitment.as_slice()),
            Seed::from(&seat_bump_slice),
        ];
        cpi_close_token_account(tp, wsol_ata, stage_pda_acct, sp, &[Signer::from(&seat_seeds)])?;
    } else {
        cpi_close_token_account(
            tp,
            wsol_ata,
            stage_pda_acct,
            stage_pda_acct,
            &[Signer::from(&stage_seeds)],
        )?;
    }

    cpi_system_transfer(
        stage_pda_acct,
        payer,
        system_program,
        rent_refund,
        &[Signer::from(&stage_seeds)],
    )
}

#[inline(never)]
#[allow(clippy::too_many_arguments)]
fn settle_no_output(
    hook_kind: HookKind,
    in_is_sol: bool,
    wrap_sol_in: bool,
    stage_bump: u8,
    seat_commitment: &[u8; 32],
    seat_pda_bump: u8,
    payer: &AccountView,
    stage_pda_acct: &AccountView,
    seat_pda_acct: Option<&AccountView>,
    system_program: &AccountView,
    output_tree: &AccountView,
    spp_program: &AccountView,
    token_program_in: Option<&AccountView>,
    mint_in_acct: Option<&AccountView>,
    stage_in_token_acct: Option<&AccountView>,
    sol_interface_in: Option<&AccountView>,
    spl_interface_in: Option<&AccountView>,
    in_spl_interface_bump: u8,
    wsol_in_lamports_before: u64,
    stage_in_token_before: u64,
    leftover_in: u64,
    view_tag: [u8; 32],
    output_owner_hash: [u8; 32],
) -> ProgramResult {
    let stage_bump_slice = [stage_bump];
    let stage_seeds = [Seed::from(STAGE_SEED), Seed::from(&stage_bump_slice)];
    let seat_bump_slice = [seat_pda_bump];
    let seat_seeds = [
        Seed::from(SEAT_SEED),
        Seed::from(seat_commitment.as_slice()),
        Seed::from(&seat_bump_slice),
    ];

    if leftover_in > 0 && output_owner_hash != [0u8; 32] {
        if in_is_sol {
            if wrap_sol_in {
                let tp = token_program_in.ok_or(PookError::InvalidTokenProgram)?;
                let wsol_ata = stage_in_token_acct.ok_or(PookError::InvalidStageTokenAccount)?;
                unwrap_wsol_to_stage_and_refund_rent(
                    hook_kind,
                    stage_bump,
                    seat_commitment,
                    seat_pda_bump,
                    payer,
                    stage_pda_acct,
                    seat_pda_acct,
                    system_program,
                    tp,
                    wsol_ata,
                    wsol_in_lamports_before,
                    stage_in_token_before,
                )?;
            }
            let sol_if = sol_interface_in.ok_or(PookError::InvalidInstructionData)?;
            return cpi_spp_deposit_batch(
                output_tree,
                stage_pda_acct,
                spp_program,
                view_tag,
                output_owner_hash,
                &[SppDepositLeg::Sol {
                    system_program,
                    sol_interface: sol_if,
                    amount: leftover_in,
                }],
                &[Signer::from(&stage_seeds)],
            );
        } else {
            let tp = token_program_in.ok_or(PookError::InvalidTokenProgram)?;
            let mint_i = mint_in_acct.ok_or(PookError::InvalidStageTokenAccount)?;
            let stage_in = stage_in_token_acct.ok_or(PookError::InvalidStageTokenAccount)?;
            let spl_if = spl_interface_in.ok_or(PookError::InvalidInstructionData)?;
            let (depositor, signer) = if hook_kind == HookKind::Seat {
                (
                    seat_pda_acct.ok_or(PookError::InvalidSeatAccount)?,
                    Signer::from(&seat_seeds),
                )
            } else {
                (stage_pda_acct, Signer::from(&stage_seeds))
            };
            return cpi_spp_deposit_batch(
                output_tree,
                depositor,
                spp_program,
                view_tag,
                output_owner_hash,
                &[SppDepositLeg::Spl {
                    token_program: tp,
                    mint: mint_i,
                    user_token: stage_in,
                    spl_interface: spl_if,
                    spl_interface_bump: in_spl_interface_bump,
                    amount: leftover_in,
                }],
                &[signer],
            );
        }
    }

    if hook_kind == HookKind::Seat && in_is_sol && wrap_sol_in {
        let tp = token_program_in.ok_or(PookError::InvalidTokenProgram)?;
        let wsol_ata = stage_in_token_acct.ok_or(PookError::InvalidStageTokenAccount)?;
        let sp = seat_pda_acct.ok_or(PookError::InvalidSeatAccount)?;
        cpi_close_token_account(tp, wsol_ata, payer, sp, &[Signer::from(&seat_seeds)])?;
    }
    Ok(())
}

#[inline(never)]
#[allow(clippy::too_many_arguments)]
fn settle_output_and_leftover(
    hook_kind: HookKind,
    in_is_sol: bool,
    wrap_sol_in: bool,
    out_is_sol: bool,
    unwrap_sol_out: bool,
    stage_bump: u8,
    seat_commitment: &[u8; 32],
    seat_pda_bump: u8,
    payer: &AccountView,
    stage_pda_acct: &AccountView,
    seat_pda_acct: Option<&AccountView>,
    system_program: &AccountView,
    output_tree: &AccountView,
    spp_program: &AccountView,
    token_program_in: Option<&AccountView>,
    mint_in_acct: Option<&AccountView>,
    stage_in_token_acct: Option<&AccountView>,
    sol_interface_in: Option<&AccountView>,
    spl_interface_in: Option<&AccountView>,
    in_spl_interface_bump: u8,
    wsol_in_lamports_before: u64,
    stage_in_token_before: u64,
    leftover_in: u64,
    sol_interface_out: Option<&AccountView>,
    fee_rec: &AccountView,
    auth_fees: &AccountView,
    author_fees_ata_acct: Option<&AccountView>,
    token_program_out: Option<&AccountView>,
    mint_out_acct: Option<&AccountView>,
    stage_out_token_acct: Option<&AccountView>,
    spl_interface_out: Option<&AccountView>,
    relayer_fee_ata: Option<&AccountView>,
    out_spl_interface_bump: u8,
    wsol_out_lamports_before: u64,
    stage_out_token_before: u64,
    protocol_fee: u64,
    author_fee: u64,
    relayer_fee: u64,
    net_out: u64,
    view_tag: [u8; 32],
    output_owner_hash: [u8; 32],
) -> ProgramResult {
    let stage_bump_slice = [stage_bump];
    let stage_seeds = [Seed::from(STAGE_SEED), Seed::from(&stage_bump_slice)];
    let seat_bump_slice = [seat_pda_bump];
    let seat_seeds = [
        Seed::from(SEAT_SEED),
        Seed::from(seat_commitment.as_slice()),
        Seed::from(&seat_bump_slice),
    ];

    // If wrapped SOL input left unused WSOL in stage-in, unwrap it back to native SOL on stage_pda.
    if leftover_in > 0 && in_is_sol && wrap_sol_in {
        let tp = token_program_in.ok_or(PookError::InvalidTokenProgram)?;
        let wsol_ata = stage_in_token_acct.ok_or(PookError::InvalidStageTokenAccount)?;
        unwrap_wsol_to_stage_and_refund_rent(
            hook_kind,
            stage_bump,
            seat_commitment,
            seat_pda_bump,
            payer,
            stage_pda_acct,
            seat_pda_acct,
            system_program,
            tp,
            wsol_ata,
            wsol_in_lamports_before,
            stage_in_token_before,
        )?;
    }

    // Pay output fees (and unwrap WSOL output if applicable) and build the primary output deposit leg.
    let out_leg = if out_is_sol {
        if unwrap_sol_out {
            let tp = token_program_out.ok_or(PookError::InvalidTokenProgram)?;
            let wsol_ata = stage_out_token_acct.ok_or(PookError::InvalidStageTokenAccount)?;
            unwrap_wsol_to_stage_and_refund_rent(
                hook_kind,
                stage_bump,
                seat_commitment,
                seat_pda_bump,
                payer,
                stage_pda_acct,
                seat_pda_acct,
                system_program,
                tp,
                wsol_ata,
                wsol_out_lamports_before,
                stage_out_token_before,
            )?;
        }
        cpi_system_transfer(
            stage_pda_acct,
            fee_rec,
            system_program,
            protocol_fee,
            &[Signer::from(&stage_seeds)],
        )?;
        cpi_system_transfer(
            stage_pda_acct,
            auth_fees,
            system_program,
            author_fee,
            &[Signer::from(&stage_seeds)],
        )?;
        cpi_system_transfer(
            stage_pda_acct,
            payer,
            system_program,
            relayer_fee,
            &[Signer::from(&stage_seeds)],
        )?;
        SppDepositLeg::Sol {
            system_program,
            sol_interface: sol_interface_out.ok_or(PookError::InvalidInstructionData)?,
            amount: net_out,
        }
    } else {
        let tp = token_program_out.ok_or(PookError::InvalidTokenProgram)?;
        let mint_o = mint_out_acct.ok_or(PookError::InvalidStageTokenAccount)?;
        let stage_out = stage_out_token_acct.ok_or(PookError::InvalidStageTokenAccount)?;
        let spl_if = spl_interface_out.ok_or(PookError::InvalidInstructionData)?;
        let auth_fees_ata = author_fees_ata_acct.ok_or(PookError::InvalidAuthorFeesAccount)?;
        let rel_ata = relayer_fee_ata.ok_or(PookError::InvalidInstructionData)?;
        let decimals = read_mint_decimals(mint_o)?;

        let owner_acct = if hook_kind == HookKind::Seat {
            seat_pda_acct.ok_or(PookError::InvalidSeatAccount)?
        } else {
            stage_pda_acct
        };
        let signers = [if hook_kind == HookKind::Seat {
            Signer::from(&seat_seeds)
        } else {
            Signer::from(&stage_seeds)
        }];

        cpi_token_transfer_checked(
            tp,
            stage_out,
            mint_o,
            fee_rec,
            owner_acct,
            protocol_fee,
            decimals,
            &signers,
        )?;
        cpi_token_transfer_checked(
            tp,
            stage_out,
            mint_o,
            auth_fees_ata,
            owner_acct,
            author_fee,
            decimals,
            &signers,
        )?;
        cpi_token_transfer_checked(
            tp,
            stage_out,
            mint_o,
            rel_ata,
            owner_acct,
            relayer_fee,
            decimals,
            &signers,
        )?;
        SppDepositLeg::Spl {
            token_program: tp,
            mint: mint_o,
            user_token: stage_out,
            spl_interface: spl_if,
            spl_interface_bump: out_spl_interface_bump,
            amount: net_out,
        }
    };

    let leftover_leg = if leftover_in > 0 {
        if in_is_sol {
            Some(SppDepositLeg::Sol {
                system_program,
                sol_interface: sol_interface_in.ok_or(PookError::InvalidInstructionData)?,
                amount: leftover_in,
            })
        } else {
            Some(SppDepositLeg::Spl {
                token_program: token_program_in.ok_or(PookError::InvalidTokenProgram)?,
                mint: mint_in_acct.ok_or(PookError::InvalidStageTokenAccount)?,
                user_token: stage_in_token_acct.ok_or(PookError::InvalidStageTokenAccount)?,
                spl_interface: spl_interface_in.ok_or(PookError::InvalidInstructionData)?,
                spl_interface_bump: in_spl_interface_bump,
                amount: leftover_in,
            })
        }
    } else {
        None
    };

    let out_uses_seat = hook_kind == HookKind::Seat && !out_is_sol;
    let in_uses_seat = hook_kind == HookKind::Seat && !in_is_sol;
    let depositor_out = if out_uses_seat {
        seat_pda_acct.ok_or(PookError::InvalidSeatAccount)?
    } else {
        stage_pda_acct
    };
    let signer_out = if out_uses_seat {
        Signer::from(&seat_seeds)
    } else {
        Signer::from(&stage_seeds)
    };

    match leftover_leg {
        None => cpi_spp_deposit_batch(
            output_tree,
            depositor_out,
            spp_program,
            view_tag,
            output_owner_hash,
            &[out_leg],
            &[signer_out],
        ),
        Some(leftover) if out_uses_seat == in_uses_seat => cpi_spp_deposit_batch(
            output_tree,
            depositor_out,
            spp_program,
            view_tag,
            output_owner_hash,
            &[out_leg, leftover],
            &[signer_out],
        ),
        Some(leftover) => {
            cpi_spp_deposit_batch(
                output_tree,
                depositor_out,
                spp_program,
                view_tag,
                output_owner_hash,
                &[out_leg],
                &[signer_out],
            )?;
            let (depositor_in, signer_in) = if in_uses_seat {
                (
                    seat_pda_acct.ok_or(PookError::InvalidSeatAccount)?,
                    Signer::from(&seat_seeds),
                )
            } else {
                (stage_pda_acct, Signer::from(&stage_seeds))
            };
            cpi_spp_deposit_batch(
                output_tree,
                depositor_in,
                spp_program,
                view_tag,
                output_owner_hash,
                &[leftover],
                &[signer_in],
            )
        }
    }
}

#[inline(never)]
fn verify_run_proof(
    args: &RunArgs,
    authority_identity: [u8; 32],
    hook_hash: [u8; 32],
    call_hash: [u8; 32],
    private_tx_hash: &[u8; 32],
    transfers: &[PublicTransfer],
) -> ProgramResult {
    match args.kind {
        RunKind::Flow => {
            run_verifier::Verifier {
                proof: &args.proof,
                public_inputs: run_verifier::PublicInputs {
                    authority_identity,
                    hook_hash,
                    call_hash,
                    amount_in: args.amount_in,
                    min_out: args.min_out,
                    output_owner_hash: args.output_owner_hash,
                    relayer_fee: args.relayer_fee,
                    expiry: args.expiry,
                },
                private_tx_hash,
                transfers,
            }
            .verify()
            .map_err(PookError::from)?;
        }
        RunKind::SeatFund => {
            seat_fund::Verifier {
                proof: &args.proof,
                public_inputs: seat_fund::PublicInputs {
                    authority_identity,
                    seat_commitment: args.seat_commitment,
                    hook_hash,
                    call_hash,
                    amount_in: args.amount_in,
                    min_out: args.min_out,
                    output_owner_hash: args.output_owner_hash,
                    relayer_fee: args.relayer_fee,
                    expiry: args.expiry,
                },
                private_tx_hash,
                transfers,
            }
            .verify()
            .map_err(PookError::from)?;
        }
        RunKind::SeatAction => {
            seat_action::Verifier {
                proof: &args.proof,
                public_inputs: seat_action::PublicInputs {
                    authority_identity,
                    seat_commitment: args.seat_commitment,
                    hook_hash,
                    call_hash,
                    min_out: args.min_out,
                    output_owner_hash: args.output_owner_hash,
                    relayer_fee: args.relayer_fee,
                    expiry: args.expiry,
                },
                private_tx_hash,
                transfers,
            }
            .verify()
            .map_err(PookError::from)?;
        }
    }
    Ok(())
}

#[inline(never)]
#[allow(clippy::too_many_arguments)]
fn invoke_target_cpi(
    target_program: &Address,
    cpi_metas: &[InstructionAccount],
    cpi_data: &[u8],
    cpi_views: &[&AccountView],
    hook_kind: HookKind,
    stage_bump: u8,
    seat_commitment: &[u8; 32],
    seat_pda_bump: u8,
) -> ProgramResult {
    let target_ix = InstructionView {
        program_id: target_program,
        accounts: cpi_metas,
        data: cpi_data,
    };
    let stage_bump_slice = [stage_bump];
    let stage_seeds = [Seed::from(STAGE_SEED), Seed::from(&stage_bump_slice)];
    if hook_kind == HookKind::Seat {
        let seat_bump_slice = [seat_pda_bump];
        let seat_seeds = [
            Seed::from(SEAT_SEED),
            Seed::from(seat_commitment.as_slice()),
            Seed::from(&seat_bump_slice),
        ];
        invoke_signed_with_bounds::<40, _>(
            &target_ix,
            cpi_views,
            &[Signer::from(&stage_seeds), Signer::from(&seat_seeds)],
        )
    } else {
        invoke_signed_with_bounds::<40, _>(&target_ix, cpi_views, &[Signer::from(&stage_seeds)])
    }
}

#[inline(never)]
fn ensure_and_accrue_author_fees(
    payer: &AccountView,
    author_fees_acct: &mut AccountView,
    system_program: &AccountView,
    author: &[u8; 32],
    mint: &[u8; 32],
    author_fee: u64,
) -> ProgramResult {
    let (expected_pda, bump) = find_author_fees_pda(author, mint);
    if !address_eq(author_fees_acct.address(), &expected_pda) {
        return Err(PookError::InvalidAuthorFeesAccount.into());
    }
    if author_fees_acct.lamports() == 0 || author_fees_acct.is_data_empty() {
        let bump_slice = [bump];
        let seeds = [
            Seed::from(AUTHOR_FEES_SEED),
            Seed::from(author.as_slice()),
            Seed::from(mint.as_slice()),
            Seed::from(&bump_slice),
        ];
        create_pda_account(
            payer,
            author_fees_acct,
            system_program,
            AuthorFees::LEN,
            &crate::ID,
            &seeds,
        )?;
        let state = AuthorFees {
            discriminator: disc::AUTHOR_FEES,
            author: *author,
            mint: *mint,
            accrued: author_fee,
            bump,
        };
        let bytes = borsh::to_vec(&state).map_err(|_| PookError::InvalidInstructionData)?;
        let mut dst = author_fees_acct.try_borrow_mut()?;
        dst[..bytes.len()].copy_from_slice(&bytes);
        return Ok(());
    }

    if !address_eq(author_fees_acct.owner(), &crate::ID) {
        return Err(PookError::InvalidAuthorFeesAccount.into());
    }
    let mut state = {
        let raw = author_fees_acct.try_borrow()?;
        if raw.len() < AuthorFees::LEN || raw[0..8] != disc::AUTHOR_FEES {
            return Err(PookError::InvalidAuthorFeesAccount.into());
        }
        borsh::from_slice::<AuthorFees>(&raw[..AuthorFees::LEN])
            .map_err(|_| PookError::InvalidAuthorFeesAccount)?
    };
    state.accrued = state
        .accrued
        .checked_add(author_fee)
        .ok_or(PookError::Overflow)?;
    let bytes = borsh::to_vec(&state).map_err(|_| PookError::InvalidInstructionData)?;
    let mut dst = author_fees_acct.try_borrow_mut()?;
    dst[..bytes.len()].copy_from_slice(&bytes);
    Ok(())
}

/// Apply `hook.data_slots` onto `hook.data_template` to produce the resolved target CPI data.
pub fn resolve_cpi_data(
    hook: &Hook,
    amount_in: u64,
    min_out: u64,
    caller_data: &[u8],
) -> Result<Vec<u8>, PookError> {
    let mut out = hook.data_template.clone();
    let mut caller_cursor = 0usize;

    for slot in &hook.data_slots {
        let off = usize::from(slot.offset);
        let len = usize::from(slot.len);
        match slot.kind {
            DataSlotKind::AmountInU64Le => {
                let end = off.checked_add(8).ok_or(PookError::DataSlotOutOfBounds)?;
                if end > out.len() {
                    return Err(PookError::DataSlotOutOfBounds);
                }
                out[off..end].copy_from_slice(&amount_in.to_le_bytes());
            }
            DataSlotKind::MinOutU64Le => {
                let end = off.checked_add(8).ok_or(PookError::DataSlotOutOfBounds)?;
                if end > out.len() {
                    return Err(PookError::DataSlotOutOfBounds);
                }
                out[off..end].copy_from_slice(&min_out.to_le_bytes());
            }
            DataSlotKind::CallerSlice => {
                let src_end = caller_cursor
                    .checked_add(len)
                    .ok_or(PookError::DataSlotOutOfBounds)?;
                let dst_end = off.checked_add(len).ok_or(PookError::DataSlotOutOfBounds)?;
                if src_end > caller_data.len() || dst_end > out.len() {
                    return Err(PookError::DataSlotOutOfBounds);
                }
                out[off..dst_end].copy_from_slice(&caller_data[caller_cursor..src_end]);
                caller_cursor = src_end;
            }
            DataSlotKind::CallerTail => {
                let tail = &caller_data[caller_cursor..];
                if len > 0 && tail.len() > len {
                    return Err(PookError::DataSlotOutOfBounds);
                }
                out.extend_from_slice(tail);
                caller_cursor = caller_data.len();
            }
        }
    }

    if caller_cursor != caller_data.len() {
        return Err(PookError::InvalidInstructionData);
    }
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
fn resolve_cpi_accounts<'a>(
    hook: &Hook,
    stage_pda: &'a AccountView,
    stage_in: Option<&'a AccountView>,
    stage_out: Option<&'a AccountView>,
    seat_pda: Option<&'a AccountView>,
    payer: &'a AccountView,
    caller_accounts: &'a [AccountView],
    caller_remaining_writable: &[u8],
    authority_pda: &Address,
    config_pda: &Address,
    hook_pda: &Address,
    output_tree: &Address,
    author_fees: Option<&Address>,
    author_fees_ata: Option<&Address>,
    fee_recipient_ata: Option<&Address>,
    seat_state: Option<&Address>,
    spl_interface_out: Option<&Address>,
    spl_interface_in: Option<&Address>,
    sol_interface_in: Option<&Address>,
) -> Result<(Vec<&'a AccountView>, Vec<InstructionAccount<'a>>, Vec<(Address, bool, bool)>), PookError> {
    let mut views: Vec<&'a AccountView> = Vec::with_capacity(hook.account_slots.len() + caller_accounts.len());
    let mut metas: Vec<InstructionAccount<'a>> = Vec::with_capacity(hook.account_slots.len() + caller_accounts.len());
    let mut tuples: Vec<(Address, bool, bool)> = Vec::with_capacity(hook.account_slots.len() + caller_accounts.len());
    let mut caller_idx = 0usize;

    let check_not_forbidden = |addr: &Address| -> Result<(), PookError> {
        if address_eq(addr, &crate::ID)
            || address_eq(addr, &PROGRAM_ID_PUBKEY)
            || address_eq(addr, authority_pda)
            || address_eq(addr, config_pda)
            || address_eq(addr, hook_pda)
            || address_eq(addr, output_tree)
            || author_fees.is_some_and(|f| address_eq(addr, f))
            || author_fees_ata.is_some_and(|f| address_eq(addr, f))
            || fee_recipient_ata.is_some_and(|f| address_eq(addr, f))
            || seat_state.is_some_and(|f| address_eq(addr, f))
            || spl_interface_out.is_some_and(|f| address_eq(addr, f))
            || spl_interface_in.is_some_and(|f| address_eq(addr, f))
            || sol_interface_in.is_some_and(|f| address_eq(addr, f))
        {
            return Err(PookError::ForbiddenHookAccount);
        }
        Ok(())
    };

    for slot in &hook.account_slots {
        match slot.kind {
            AccountSlotKind::StagePda => {
                views.push(stage_pda);
                metas.push(InstructionAccount::new(
                    stage_pda.address(),
                    slot.is_writable,
                    slot.is_signer,
                ));
                tuples.push((*stage_pda.address(), slot.is_writable, slot.is_signer));
            }
            AccountSlotKind::StageIn => {
                let acct = stage_in.ok_or(PookError::CallerAccountsMismatch)?;
                views.push(acct);
                metas.push(InstructionAccount::new(acct.address(), slot.is_writable, false));
                tuples.push((*acct.address(), slot.is_writable, false));
            }
            AccountSlotKind::StageOut => {
                let acct = stage_out.ok_or(PookError::CallerAccountsMismatch)?;
                views.push(acct);
                metas.push(InstructionAccount::new(acct.address(), slot.is_writable, false));
                tuples.push((*acct.address(), slot.is_writable, false));
            }
            AccountSlotKind::SeatPda => {
                let acct = seat_pda.ok_or(PookError::InvalidSeatAccount)?;
                views.push(acct);
                metas.push(InstructionAccount::new(
                    acct.address(),
                    slot.is_writable,
                    slot.is_signer,
                ));
                tuples.push((*acct.address(), slot.is_writable, slot.is_signer));
            }
            AccountSlotKind::Payer => {
                if hook.kind != HookKind::Seat {
                    return Err(PookError::ForbiddenHookAccount);
                }
                views.push(payer);
                metas.push(InstructionAccount::new(
                    payer.address(),
                    slot.is_writable,
                    slot.is_signer,
                ));
                tuples.push((*payer.address(), slot.is_writable, slot.is_signer));
            }
            AccountSlotKind::Fixed => {
                let acct = caller_accounts
                    .get(caller_idx)
                    .ok_or(PookError::CallerAccountsMismatch)?;
                caller_idx += 1;
                if acct.address().as_array() != &slot.pubkey {
                    return Err(PookError::CallerAccountsMismatch);
                }
                check_not_forbidden(acct.address())?;
                views.push(acct);
                metas.push(InstructionAccount::new(acct.address(), slot.is_writable, false));
                tuples.push((*acct.address(), slot.is_writable, false));
            }
            AccountSlotKind::Caller => {
                let acct = caller_accounts
                    .get(caller_idx)
                    .ok_or(PookError::CallerAccountsMismatch)?;
                caller_idx += 1;
                check_not_forbidden(acct.address())?;
                views.push(acct);
                metas.push(InstructionAccount::new(acct.address(), slot.is_writable, false));
                tuples.push((*acct.address(), slot.is_writable, false));
            }
            AccountSlotKind::CallerRemaining => {
                let rem = &caller_accounts[caller_idx..];
                if rem.len() != caller_remaining_writable.len() {
                    return Err(PookError::CallerAccountsMismatch);
                }
                for (acct, &w) in rem.iter().zip(caller_remaining_writable.iter()) {
                    check_not_forbidden(acct.address())?;
                    let is_w = w != 0;
                    views.push(acct);
                    metas.push(InstructionAccount::new(acct.address(), is_w, false));
                    tuples.push((*acct.address(), is_w, false));
                }
                caller_idx = caller_accounts.len();
            }
        }
    }

    if caller_idx != caller_accounts.len() {
        return Err(PookError::CallerAccountsMismatch);
    }

    Ok((views, metas, tuples))
}

/// Inspect the Instructions sysvar to confirm every required companion instruction
/// sits in the same transaction (and precedes the current instruction if `must_precede`).
fn verify_companions(
    ix_sysvar: &AccountView,
    companions: &[CompanionRequirement],
) -> ProgramResult {
    let data = ix_sysvar.try_borrow()?;
    if data.len() < 4 {
        return Err(PookError::InvalidInstructionsSysvar.into());
    }
    let num_ixs = u16::from_le_bytes([data[0], data[1]]) as usize;
    let current_idx = u16::from_le_bytes([data[data.len() - 2], data[data.len() - 1]]) as usize;

    for req in companions {
        let mut found = false;
        let max_idx = if req.must_precede {
            current_idx.min(num_ixs)
        } else {
            num_ixs
        };
        for idx in 0..max_idx {
            let offset_pos = 2 + idx * 2;
            if offset_pos + 2 > data.len() {
                return Err(PookError::InvalidInstructionsSysvar.into());
            }
            let off = u16::from_le_bytes([data[offset_pos], data[offset_pos + 1]]) as usize;
            if off + 2 > data.len() {
                return Err(PookError::InvalidInstructionsSysvar.into());
            }
            let num_accounts = u16::from_le_bytes([data[off], data[off + 1]]) as usize;
            let prog_pos = off + 2 + num_accounts * 33;
            if prog_pos + 34 > data.len() {
                return Err(PookError::InvalidInstructionsSysvar.into());
            }
            let prog_id = &data[prog_pos..prog_pos + 32];
            let data_len = u16::from_le_bytes([data[prog_pos + 32], data[prog_pos + 33]]) as usize;
            let ix_data_start = prog_pos + 34;
            if ix_data_start + data_len > data.len() {
                return Err(PookError::InvalidInstructionsSysvar.into());
            }
            let ix_data = &data[ix_data_start..ix_data_start + data_len];
            let disc_len = usize::from(req.disc_len);
            if prog_id == req.program_id
                && ix_data.len() >= disc_len
                && ix_data[..disc_len] == req.discriminator[..disc_len]
            {
                found = true;
                break;
            }
        }
        if !found {
            return Err(PookError::MissingCompanionInstruction.into());
        }
    }
    Ok(())
}
