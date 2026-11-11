use pinocchio::{
    address::address_eq,
    cpi::{Seed, Signer},
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView, Address, ProgramResult,
};
use spr_account_checks::AccountIterator;
use spr_hasher::primitives::{hash_bytes, solana_owner_identity};
use spr_interface::{
    instruction::instruction_data::transact::InterfaceTransfer, PROGRAM_ID_PUBKEY,
};
use spr_program::{CompressedProof, PublicTransfer};
use wincode::{SchemaRead, SchemaWrite};

use crate::{
    error::PookError,
    instructions::shared::{
        check_not_expired, check_system_program, check_token_account_mint_and_owner,
        cpi_spp_deposit_sol, cpi_spp_deposit_spl, cpi_spp_transact_with_authority,
        cpi_system_transfer, cpi_token_transfer_checked, derive_authority, derive_stage,
        is_valid_token_program, read_mint_decimals, IxData,
    },
    pda::{find_ata, STAGE_SEED},
    verifier::leave as leave_verifier,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, SchemaRead, SchemaWrite)]
pub struct LeaveArgs {
    pub proof: CompressedProof,
    pub authority_bump: u8,
    pub stage_bump: u8,
    /// `0` = to public Solana address/token account, `1` = to Rings private balance via `deposit`.
    pub leave_kind: u8,
    /// `[0u8; 32]` for native SOL, or the SPL / Token-2022 mint pubkey.
    pub mint: [u8; 32],
    pub amount: u64,
    pub relayer_fee: u64,
    pub expiry: u64,
    /// When `leave_kind == 1`: recipient Rings `owner_hash`. Zeroed when `leave_kind == 0`.
    pub dest_owner_hash: [u8; 32],
    /// When `leave_kind == 1`: recipient Rings `view_tag` (signing pubkey). Zeroed when `leave_kind == 0`.
    pub dest_view_tag: [u8; 32],
    /// Canonical bump of SPP's `spl_interface` PDA (only when `leave_kind == 1` and SPL).
    pub spl_interface_bump: u8,
    /// Number of accounts in the SPP `transact` slice.
    pub spp_account_count: u8,
}

/// Accounts:
/// 0. `payer` (signer, writable — relayer)
/// 1. `stage_pda` (writable PDA `[b"stage"]`)
/// 2. `system_program`
/// 3. If `leave_kind == 0 && mint == SOL`:
///    - `dest_wallet` (writable)
/// 4. If `leave_kind == 0 && mint != SOL`:
///    - `token_program`, `mint`, `stage_ata` (W), `dest_ata` (W), `relayer_fee_ata` (W)
/// 5. If `leave_kind == 1 && mint == SOL`:
///    - `output_tree` (W), `spp_program`, `sol_interface` (W)
/// 6. If `leave_kind == 1 && mint != SOL`:
///    - `output_tree` (W), `spp_program`, `token_program`, `mint`, `stage_ata` (W), `spl_interface` (W), `relayer_fee_ata` (W)
/// Followed by `spp_account_count` verbatim SPP `transact` accounts.
pub fn process_leave(accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let IxData {
        args,
        transact,
        transact_bytes,
    } = IxData::<LeaveArgs>::parse(data)?;

    if args.leave_kind > 1 {
        return Err(PookError::InvalidLeaveKind.into());
    }
    if args.amount == 0 || args.relayer_fee >= args.amount {
        return Err(PookError::InvalidRelayerFee.into());
    }

    let clock = Clock::get()?;
    check_not_expired(clock.unix_timestamp, args.expiry)?;
    if transact.expiry_unix_ts != args.expiry {
        return Err(PookError::InvalidInstructionData.into());
    }

    let authority_pda = derive_authority(args.authority_bump)?;
    let stage_pda = derive_stage(args.stage_bump)?;

    let mut iter = AccountIterator::new(accounts);
    let payer = iter.next_signer_mut("payer")?;
    let stage_pda_acct = iter.next_mut("stage_pda")?;
    let system_program = iter.next_account("system_program")?;

    check_system_program(system_program)?;
    if !address_eq(stage_pda_acct.address(), &stage_pda) {
        return Err(PookError::InvalidStagePda.into());
    }

    let is_sol = args.mint == [0u8; 32];
    let net_out = args.amount - args.relayer_fee;

    // Parse destination & stage accounts by `(leave_kind, is_sol)`.
    let mut dest_public_acct: Option<&AccountView> = None;
    let mut output_tree_acct: Option<&AccountView> = None;
    let mut spp_program_acct: Option<&AccountView> = None;
    let mut sol_interface_acct: Option<&AccountView> = None;
    let mut token_program_acct: Option<&AccountView> = None;
    let mut mint_acct: Option<&AccountView> = None;
    let mut stage_ata_acct: Option<&AccountView> = None;
    let mut spl_interface_acct: Option<&AccountView> = None;
    let mut relayer_fee_ata_acct: Option<&AccountView> = None;

    let stage_in_for_spp: Address;
    let dest_hash: [u8; 32];
    let dest_view_tag_hash: [u8; 32];

    match (args.leave_kind, is_sol) {
        (0, true) => {
            let dest = iter.next_mut("dest_wallet")?;
            dest_public_acct = Some(dest);
            stage_in_for_spp = stage_pda;
            dest_hash = hash_bytes(dest.address().as_array())?;
            dest_view_tag_hash = [0u8; 32];
        }
        (0, false) => {
            let tp = iter.next_account("token_program")?;
            let m = iter.next_account("mint")?;
            let st_ata = iter.next_mut("stage_ata")?;
            let d_ata = iter.next_mut("dest_ata")?;
            let rel_ata = iter.next_mut("relayer_fee_ata")?;
            validate_spl_stage(tp, m, st_ata, &stage_pda, &args.mint)?;
            token_program_acct = Some(tp);
            mint_acct = Some(m);
            stage_ata_acct = Some(st_ata);
            dest_public_acct = Some(d_ata);
            relayer_fee_ata_acct = Some(rel_ata);
            stage_in_for_spp = *st_ata.address();
            dest_hash = hash_bytes(d_ata.address().as_array())?;
            dest_view_tag_hash = [0u8; 32];
        }
        (1, true) => {
            let tree = iter.next_mut("output_tree")?;
            let spp = iter.next_account("spp_program")?;
            let sol_if = iter.next_mut("sol_interface")?;
            if !address_eq(spp.address(), &PROGRAM_ID_PUBKEY) {
                return Err(PookError::InvalidShieldedPoolProgram.into());
            }
            output_tree_acct = Some(tree);
            spp_program_acct = Some(spp);
            sol_interface_acct = Some(sol_if);
            stage_in_for_spp = stage_pda;
            dest_hash = args.dest_owner_hash;
            dest_view_tag_hash = hash_bytes(&args.dest_view_tag)?;
        }
        (1, false) => {
            let tree = iter.next_mut("output_tree")?;
            let spp = iter.next_account("spp_program")?;
            let tp = iter.next_account("token_program")?;
            let m = iter.next_account("mint")?;
            let st_ata = iter.next_mut("stage_ata")?;
            let spl_if = iter.next_mut("spl_interface")?;
            let rel_ata = iter.next_mut("relayer_fee_ata")?;
            if !address_eq(spp.address(), &PROGRAM_ID_PUBKEY) {
                return Err(PookError::InvalidShieldedPoolProgram.into());
            }
            validate_spl_stage(tp, m, st_ata, &stage_pda, &args.mint)?;
            output_tree_acct = Some(tree);
            spp_program_acct = Some(spp);
            token_program_acct = Some(tp);
            mint_acct = Some(m);
            stage_ata_acct = Some(st_ata);
            spl_interface_acct = Some(spl_if);
            relayer_fee_ata_acct = Some(rel_ata);
            stage_in_for_spp = *st_ata.address();
            dest_hash = args.dest_owner_hash;
            dest_view_tag_hash = hash_bytes(&args.dest_view_tag)?;
        }
        _ => return Err(PookError::InvalidLeaveKind.into()),
    }

    let spp_accounts = iter.remaining()?;
    if spp_accounts.len() != usize::from(args.spp_account_count) {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    // Verify transact withdrawal leg matches `(is_sol, args.amount)`.
    if transact.interface_transfers.len() != 1 {
        return Err(PookError::InvalidInstructionData.into());
    }
    match transact.interface_transfers[0] {
        InterfaceTransfer::SolWithdrawal { amount } if is_sol && amount == args.amount => {}
        InterfaceTransfer::SplWithdrawal { amount, .. } if !is_sol && amount == args.amount => {}
        _ => return Err(PookError::InvalidInstructionData.into()),
    }

    // Verify Leave ZK proof.
    let authority_identity = solana_owner_identity(authority_pda.as_array())?;
    let transfers = [PublicTransfer {
        mint: Address::new_from_array(args.mint),
        is_deposit: false,
        amount: args.amount,
        account: stage_in_for_spp,
    }];
    leave_verifier::Verifier {
        proof: &args.proof,
        public_inputs: leave_verifier::PublicInputs {
            authority_identity,
            leave_kind: args.leave_kind,
            dest_hash,
            dest_view_tag_hash,
            amount: args.amount,
            relayer_fee: args.relayer_fee,
            expiry: args.expiry,
        },
        private_tx_hash: transact.private_tx_hash,
        transfers: &transfers,
    }
    .verify()
    .map_err(PookError::from)?;

    // CPI SPP transact signed by authority_pda -> withdraws `args.amount` to stage.
    cpi_spp_transact_with_authority(&authority_pda, args.authority_bump, spp_accounts, transact_bytes)?;

    let stage_bump_slice = [args.stage_bump];
    let stage_seeds = [Seed::from(STAGE_SEED), Seed::from(&stage_bump_slice)];

    // Pay relayer and deliver `net_out` to public address or Rings private balance.
    match (args.leave_kind, is_sol) {
        (0, true) => {
            let dest = dest_public_acct.ok_or(PookError::InvalidInstructionData)?;
            cpi_system_transfer(
                stage_pda_acct,
                payer,
                system_program,
                args.relayer_fee,
                &[Signer::from(&stage_seeds)],
            )?;
            cpi_system_transfer(
                stage_pda_acct,
                dest,
                system_program,
                net_out,
                &[Signer::from(&stage_seeds)],
            )?;
        }
        (0, false) => {
            let tp = token_program_acct.ok_or(PookError::InvalidTokenProgram)?;
            let m = mint_acct.ok_or(PookError::InvalidStageTokenAccount)?;
            let st_ata = stage_ata_acct.ok_or(PookError::InvalidStageTokenAccount)?;
            let d_ata = dest_public_acct.ok_or(PookError::InvalidInstructionData)?;
            let rel_ata = relayer_fee_ata_acct.ok_or(PookError::InvalidInstructionData)?;
            let decimals = read_mint_decimals(m)?;
            cpi_token_transfer_checked(
                tp,
                st_ata,
                m,
                rel_ata,
                stage_pda_acct,
                args.relayer_fee,
                decimals,
                &[Signer::from(&stage_seeds)],
            )?;
            cpi_token_transfer_checked(
                tp,
                st_ata,
                m,
                d_ata,
                stage_pda_acct,
                net_out,
                decimals,
                &[Signer::from(&stage_seeds)],
            )?;
        }
        (1, true) => {
            let tree = output_tree_acct.ok_or(PookError::InvalidInstructionData)?;
            let spp = spp_program_acct.ok_or(PookError::InvalidShieldedPoolProgram)?;
            let sol_if = sol_interface_acct.ok_or(PookError::InvalidInstructionData)?;
            cpi_system_transfer(
                stage_pda_acct,
                payer,
                system_program,
                args.relayer_fee,
                &[Signer::from(&stage_seeds)],
            )?;
            cpi_spp_deposit_sol(
                tree,
                stage_pda_acct,
                spp,
                system_program,
                sol_if,
                args.dest_view_tag,
                args.dest_owner_hash,
                net_out,
                &[Signer::from(&stage_seeds)],
            )?;
        }
        (1, false) => {
            let tree = output_tree_acct.ok_or(PookError::InvalidInstructionData)?;
            let spp = spp_program_acct.ok_or(PookError::InvalidShieldedPoolProgram)?;
            let tp = token_program_acct.ok_or(PookError::InvalidTokenProgram)?;
            let m = mint_acct.ok_or(PookError::InvalidStageTokenAccount)?;
            let st_ata = stage_ata_acct.ok_or(PookError::InvalidStageTokenAccount)?;
            let spl_if = spl_interface_acct.ok_or(PookError::InvalidInstructionData)?;
            let rel_ata = relayer_fee_ata_acct.ok_or(PookError::InvalidInstructionData)?;
            let decimals = read_mint_decimals(m)?;
            cpi_token_transfer_checked(
                tp,
                st_ata,
                m,
                rel_ata,
                stage_pda_acct,
                args.relayer_fee,
                decimals,
                &[Signer::from(&stage_seeds)],
            )?;
            cpi_spp_deposit_spl(
                tree,
                stage_pda_acct,
                spp,
                tp,
                m,
                st_ata,
                spl_if,
                args.spl_interface_bump,
                args.dest_view_tag,
                args.dest_owner_hash,
                net_out,
                &[Signer::from(&stage_seeds)],
            )?;
        }
        _ => return Err(PookError::InvalidLeaveKind.into()),
    }

    Ok(())
}

fn validate_spl_stage(
    tp: &AccountView,
    mint_acct: &AccountView,
    stage_ata: &AccountView,
    stage_pda: &Address,
    mint: &[u8; 32],
) -> ProgramResult {
    if !is_valid_token_program(tp.address()) {
        return Err(PookError::InvalidTokenProgram.into());
    }
    if mint_acct.address().as_array() != mint {
        return Err(PookError::InvalidStageTokenAccount.into());
    }
    let (expected_ata, _) = find_ata(stage_pda.as_array(), mint, tp.address().as_array());
    if !address_eq(stage_ata.address(), &expected_ata) {
        return Err(PookError::InvalidStageTokenAccount.into());
    }
    check_token_account_mint_and_owner(stage_ata, mint, stage_pda.as_array())?;
    Ok(())
}
