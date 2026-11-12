use alloc::vec::Vec;
use pinocchio::{
    address::address_eq,
    cpi::{invoke_signed_with_bounds, Seed, Signer},
    error::ProgramError,
    instruction::{InstructionAccount, InstructionView},
    sysvars::{clock::Clock, Sysvar},
    AccountView, Address, ProgramResult,
};
use spr_account_checks::AccountIterator;
use spr_hasher::primitives::solana_owner_identity;
use spr_interface::{BPF_LOADER_UPGRADEABLE_ID, PROGRAM_ID_PUBKEY};
use spr_program::CompressedProof;
use wincode::{containers, len::FixIntLen, SchemaRead, SchemaWrite};

use crate::{
    error::PookError,
    instructions::shared::{
        check_not_expired, check_system_program, cpi_spp_transact_with_authority,
        cpi_system_transfer, create_pda_account, derive_authority, IxData,
    },
    pda::{
        find_config_pda, find_seat_pda, find_seat_state_pda, find_stage_pda, SEAT_SEED,
        SEAT_STATE_SEED, SYSTEM_PROGRAM_ID,
    },
    state::{disc, Seat},
    verifier::{seat_close, seat_open},
};

pub const MAX_SETUP_CPIS: usize = 4;

/// Account reference inside an `OpenSeatArgs::setup_cpis` entry.
/// Indices refer to: 0 = `payer`, 1 = `seat_pda`, 2 = `system_program`, 3+ = `setup_accounts[idx - 3]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, SchemaRead, SchemaWrite)]
pub struct SetupCpiAccount {
    pub account_index: u8,
    pub is_writable: bool,
    pub is_signer: bool,
}

/// Optional target-protocol initialization CPI executed inside `open_seat`
/// (e.g., Kamino `init_user_metadata` and `init_obligation`), signed ONLY by `seat_pda` + `payer`.
#[derive(Clone, Debug, PartialEq, Eq, SchemaRead, SchemaWrite)]
pub struct SetupCpi {
    pub target_program: [u8; 32],
    #[wincode(with = "containers::Vec<u8, FixIntLen<u16>>")]
    pub data: Vec<u8>,
    #[wincode(with = "containers::Vec<SetupCpiAccount, FixIntLen<u8>>")]
    pub accounts: Vec<SetupCpiAccount>,
}

#[derive(Clone, Debug, PartialEq, Eq, SchemaRead, SchemaWrite)]
pub struct OpenSeatArgs {
    pub proof: CompressedProof,
    pub authority_bump: u8,
    pub seat_commitment: [u8; 32],
    pub expiry: u64,
    pub spp_account_count: u8,
    #[wincode(with = "containers::Vec<SetupCpi, FixIntLen<u8>>")]
    pub setup_cpis: Vec<SetupCpi>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, SchemaRead, SchemaWrite)]
pub struct CloseSeatArgs {
    pub proof: CompressedProof,
    pub authority_bump: u8,
    pub seat_commitment: [u8; 32],
    pub expiry: u64,
}

/// Accounts:
/// 0. `payer` (signer, writable — relayer that opens the seat and pays its rent)
/// 1. `seat_state` (writable PDA `[b"seat_state", commitment]`)
/// 2. `seat_pda` (writable PDA `[b"seat", commitment]`)
/// 3. `system_program`
/// Followed by `args.spp_account_count` verbatim SPP `transact` accounts,
/// followed by trailing `setup_accounts` referenced by `args.setup_cpis`.
pub fn process_open_seat(accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let IxData {
        args,
        transact,
        transact_bytes,
    } = IxData::<OpenSeatArgs>::parse(data)?;

    let clock = Clock::get()?;
    check_not_expired(clock.unix_timestamp, args.expiry)?;
    if transact.expiry_unix_ts != args.expiry || !transact.interface_transfers.is_empty() {
        return Err(PookError::InvalidInstructionData.into());
    }
    if args.setup_cpis.len() > MAX_SETUP_CPIS {
        return Err(PookError::InvalidInstructionData.into());
    }

    let mut iter = AccountIterator::new(accounts);
    let payer = iter.next_signer_mut("payer")?;
    let seat_state_acct = iter.next_mut("seat_state")?;
    let seat_pda_acct = iter.next_mut("seat_pda")?;
    let system_program = iter.next_account("system_program")?;
    let remaining = iter.remaining()?;

    let spp_count = usize::from(args.spp_account_count);
    if remaining.len() < spp_count || spp_count < 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let (spp_accounts, setup_accounts) = remaining.split_at(spp_count);

    check_system_program(system_program)?;
    let authority_pda = derive_authority(args.authority_bump)?;

    let (expected_ss, bump) = find_seat_state_pda(&args.seat_commitment);
    if !address_eq(seat_state_acct.address(), &expected_ss) {
        return Err(PookError::InvalidSeatAccount.into());
    }
    if seat_state_acct.lamports() > 0 || !seat_state_acct.is_data_empty() {
        return Err(PookError::SeatAlreadyOpen.into());
    }
    let (expected_sp, seat_pda_bump) = find_seat_pda(&args.seat_commitment);
    if !address_eq(seat_pda_acct.address(), &expected_sp) {
        return Err(PookError::InvalidSeatAccount.into());
    }

    // Verify SeatOpen ZK proof.
    verify_seat_open_proof(&args, &authority_pda, transact.private_tx_hash)?;

    // Create Seat state account.
    let bump_slice = [bump];
    let seeds = [
        Seed::from(SEAT_STATE_SEED),
        Seed::from(args.seat_commitment.as_slice()),
        Seed::from(&bump_slice),
    ];
    create_pda_account(
        payer,
        seat_state_acct,
        system_program,
        Seat::LEN,
        &crate::ID,
        &seeds,
    )?;

    let seat = Seat {
        discriminator: disc::SEAT,
        commitment: args.seat_commitment,
        opener_relayer: *payer.address().as_array(),
        opened_at: clock.unix_timestamp,
        seat_pda_bump,
        bump,
    };
    let bytes = borsh::to_vec(&seat).map_err(|_| PookError::InvalidInstructionData)?;
    {
        let mut dst = seat_state_acct.try_borrow_mut()?;
        dst[..bytes.len()].copy_from_slice(&bytes);
    }

    // CPI SPP transact signed by authority_pda (reserves commitment address & mints initial SeatNote).
    cpi_spp_transact_with_authority(&authority_pda, args.authority_bump, spp_accounts, transact_bytes)?;

    // Execute any optional protocol setup CPIs (e.g. Kamino init_user_metadata + init_obligation),
    // signed ONLY by seat_pda + payer (never authority_pda).
    if !args.setup_cpis.is_empty() {
        let output_tree = spp_accounts[1].address();
        invoke_seat_setup_cpis(
            &args.setup_cpis,
            payer,
            seat_pda_acct,
            system_program,
            setup_accounts,
            &args.seat_commitment,
            seat_pda_bump,
            &authority_pda,
            seat_state_acct.address(),
            output_tree,
        )?;
    }

    Ok(())
}

#[inline(never)]
fn verify_seat_open_proof(
    args: &OpenSeatArgs,
    authority_pda: &Address,
    private_tx_hash: &[u8; 32],
) -> ProgramResult {
    let authority_identity = solana_owner_identity(authority_pda.as_array())?;
    seat_open::Verifier {
        proof: &args.proof,
        public_inputs: seat_open::PublicInputs {
            authority_identity,
            seat_commitment: args.seat_commitment,
            expiry: args.expiry,
        },
        private_tx_hash,
        transfers: &[],
    }
    .verify()
    .map_err(PookError::from)?;
    Ok(())
}

#[inline(never)]
#[allow(clippy::too_many_arguments)]
fn invoke_seat_setup_cpis(
    setup_cpis: &[SetupCpi],
    payer: &AccountView,
    seat_pda_acct: &AccountView,
    system_program: &AccountView,
    setup_accounts: &[AccountView],
    seat_commitment: &[u8; 32],
    seat_pda_bump: u8,
    authority_pda: &Address,
    seat_state_addr: &Address,
    output_tree_addr: &Address,
) -> ProgramResult {
    let (config_pda, _) = find_config_pda();
    let (stage_pda, _) = find_stage_pda();
    let seat_bump_slice = [seat_pda_bump];
    let seat_seeds = [
        Seed::from(SEAT_SEED),
        Seed::from(seat_commitment.as_slice()),
        Seed::from(&seat_bump_slice),
    ];

    for cpi in setup_cpis {
        if cpi.target_program == *crate::ID.as_array()
            || cpi.target_program == *PROGRAM_ID_PUBKEY.as_array()
            || cpi.target_program == SYSTEM_PROGRAM_ID
            || cpi.target_program == BPF_LOADER_UPGRADEABLE_ID
        {
            return Err(PookError::ForbiddenHookAccount.into());
        }
        if cpi.accounts.len() > 16 {
            return Err(PookError::InvalidInstructionData.into());
        }

        let mut views: Vec<&AccountView> = Vec::with_capacity(cpi.accounts.len());
        let mut metas: Vec<InstructionAccount> = Vec::with_capacity(cpi.accounts.len());

        for acc in &cpi.accounts {
            let view: &AccountView = match acc.account_index {
                0 => payer,
                1 => seat_pda_acct,
                2 => system_program,
                idx => setup_accounts
                    .get(usize::from(idx - 3))
                    .ok_or(PookError::CallerAccountsMismatch)?,
            };
            if acc.is_signer && acc.account_index > 1 {
                return Err(PookError::ForbiddenHookAccount.into());
            }
            let addr = view.address();
            if address_eq(addr, &crate::ID)
                || address_eq(addr, &PROGRAM_ID_PUBKEY)
                || address_eq(addr, authority_pda)
                || address_eq(addr, &config_pda)
                || address_eq(addr, &stage_pda)
                || address_eq(addr, seat_state_addr)
                || address_eq(addr, output_tree_addr)
            {
                return Err(PookError::ForbiddenHookAccount.into());
            }
            views.push(view);
            metas.push(InstructionAccount::new(addr, acc.is_writable, acc.is_signer));
        }

        let target_addr = Address::new_from_array(cpi.target_program);
        let ix = InstructionView {
            program_id: &target_addr,
            accounts: &metas,
            data: &cpi.data,
        };
        invoke_signed_with_bounds::<16, _>(&ix, &views, &[Signer::from(&seat_seeds)])?;
    }

    Ok(())
}

/// Accounts:
/// 0. `payer` (signer, writable)
/// 1. `seat_state` (writable PDA `[b"seat_state", commitment]`)
/// 2. `seat_pda` (writable PDA `[b"seat", commitment]`)
/// 3. `opener_relayer` (writable — receives closed seat rent, checked against `seat_state.opener_relayer`)
/// 4. `system_program`
/// Followed by verbatim SPP `transact` accounts.
pub fn process_close_seat(accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let IxData {
        args,
        transact,
        transact_bytes,
    } = IxData::<CloseSeatArgs>::parse(data)?;

    let clock = Clock::get()?;
    check_not_expired(clock.unix_timestamp, args.expiry)?;
    if transact.expiry_unix_ts != args.expiry || !transact.interface_transfers.is_empty() {
        return Err(PookError::InvalidInstructionData.into());
    }

    let mut iter = AccountIterator::new(accounts);
    let _payer = iter.next_signer_mut("payer")?;
    let seat_state_acct = iter.next_mut("seat_state")?;
    let seat_pda_acct = iter.next_mut("seat_pda")?;
    let opener_relayer = iter.next_mut("opener_relayer")?;
    let system_program = iter.next_account("system_program")?;
    let spp_accounts = iter.remaining()?;

    check_system_program(system_program)?;
    let authority_pda = derive_authority(args.authority_bump)?;

    let (expected_ss, _) = find_seat_state_pda(&args.seat_commitment);
    if !address_eq(seat_state_acct.address(), &expected_ss)
        || !address_eq(seat_state_acct.owner(), &crate::ID)
    {
        return Err(PookError::InvalidSeatAccount.into());
    }
    let seat = {
        let raw = seat_state_acct.try_borrow()?;
        if raw.len() < Seat::LEN || raw[0..8] != disc::SEAT {
            return Err(PookError::InvalidSeatAccount.into());
        }
        borsh::from_slice::<Seat>(&raw[..Seat::LEN]).map_err(|_| PookError::InvalidSeatAccount)?
    };
    if seat.commitment != args.seat_commitment {
        return Err(PookError::InvalidSeatAccount.into());
    }
    if opener_relayer.address().as_array() != &seat.opener_relayer {
        return Err(PookError::InvalidSeatAccount.into());
    }
    let (expected_sp, sp_bump) = find_seat_pda(&args.seat_commitment);
    if !address_eq(seat_pda_acct.address(), &expected_sp) {
        return Err(PookError::InvalidSeatAccount.into());
    }

    // Verify SeatClose ZK proof.
    let authority_identity = solana_owner_identity(authority_pda.as_array())?;
    seat_close::Verifier {
        proof: &args.proof,
        public_inputs: seat_close::PublicInputs {
            authority_identity,
            seat_commitment: args.seat_commitment,
            expiry: args.expiry,
        },
        private_tx_hash: transact.private_tx_hash,
        transfers: &[],
    }
    .verify()
    .map_err(PookError::from)?;

    // CPI SPP transact signed by authority_pda (burns the SeatNote).
    cpi_spp_transact_with_authority(&authority_pda, args.authority_bump, spp_accounts, transact_bytes)?;

    // Return any stray lamports on seat_pda to opener_relayer.
    let seat_pda_lamports = seat_pda_acct.lamports();
    if seat_pda_lamports > 0 {
        let sp_bump_slice = [sp_bump];
        let seat_seeds = [
            Seed::from(SEAT_SEED),
            Seed::from(args.seat_commitment.as_slice()),
            Seed::from(&sp_bump_slice),
        ];
        cpi_system_transfer(
            seat_pda_acct,
            opener_relayer,
            system_program,
            seat_pda_lamports,
            &[Signer::from(&seat_seeds)],
        )?;
    }

    // Close seat_state and return its rent to opener_relayer.
    let state_lamports = seat_state_acct.lamports();
    seat_state_acct.set_lamports(0);
    opener_relayer.set_lamports(
        opener_relayer
            .lamports()
            .checked_add(state_lamports)
            .ok_or(PookError::Overflow)?,
    );
    {
        let mut dst = seat_state_acct.try_borrow_mut()?;
        dst.fill(0);
    }
    Ok(())
}
