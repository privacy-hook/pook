use alloc::{string::String, vec::Vec};
use borsh::{BorshDeserialize, BorshSerialize};
use pinocchio::{address::address_eq, cpi::Seed, AccountView, ProgramResult};
use spr_account_checks::AccountIterator;
use spr_interface::{BPF_LOADER_UPGRADEABLE_ID, SHIELDED_POOL_PROGRAM_ID};

use crate::{
    error::PookError,
    instructions::shared::create_pda_account,
    pda::{find_hook_pda, hook_id_hash, HOOK_SEED, SYSTEM_PROGRAM_ID},
    state::{
        disc, AccountSlot, AccountSlotKind, CompanionRequirement, DataSlot, Hook, HookKind,
        MintConstraint, MAX_ACCOUNT_SLOTS, MAX_COMPANIONS, MAX_DATA_SLOTS, MAX_DATA_TEMPLATE_LEN,
        MAX_HOOK_ID_LEN,
    },
};

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct PublishHookArgs {
    pub hook_id: String,
    pub target_program: [u8; 32],
    pub kind: HookKind,
    pub mint_in: MintConstraint,
    pub mint_out: MintConstraint,
    pub wrap_sol_in: bool,
    pub unwrap_sol_out: bool,
    pub data_template: Vec<u8>,
    pub data_slots: Vec<DataSlot>,
    pub account_slots: Vec<AccountSlot>,
    pub companions: Vec<CompanionRequirement>,
}

/// Accounts:
/// 0. `author` (signer, writable — pays rent, recorded as hook author)
/// 1. `hook` (writable PDA `[b"hook", hook_id_hash]`)
/// 2. `system_program`
pub fn process_publish_hook(accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let args = borsh::from_slice::<PublishHookArgs>(data)
        .map_err(|_| PookError::InvalidInstructionData)?;

    validate_hook_args(&args)?;

    let mut iter = AccountIterator::new(accounts);
    let author = iter.next_signer_mut("author")?;
    let hook_account = iter.next_mut("hook")?;
    let system_program = iter.next_account("system_program")?;

    let id_hash = hook_id_hash(&args.hook_id)?;
    let (expected_hook, bump) = find_hook_pda(&id_hash);
    if !address_eq(hook_account.address(), &expected_hook) {
        return Err(PookError::InvalidHookAccount.into());
    }
    if hook_account.lamports() > 0 || !hook_account.is_data_empty() {
        return Err(PookError::HookAlreadyPublished.into());
    }

    let hook = Hook {
        discriminator: disc::HOOK,
        hook_id_hash: id_hash,
        hook_id: args.hook_id,
        author: *author.address().as_array(),
        target_program: args.target_program,
        kind: args.kind,
        mint_in: args.mint_in,
        mint_out: args.mint_out,
        wrap_sol_in: args.wrap_sol_in,
        unwrap_sol_out: args.unwrap_sol_out,
        data_template: args.data_template,
        data_slots: args.data_slots,
        account_slots: args.account_slots,
        companions: args.companions,
        bump,
    };
    let bytes = borsh::to_vec(&hook).map_err(|_| PookError::InvalidInstructionData)?;

    let bump_slice = [bump];
    let seeds = [
        Seed::from(HOOK_SEED),
        Seed::from(id_hash.as_slice()),
        Seed::from(&bump_slice),
    ];
    create_pda_account(
        author,
        hook_account,
        system_program,
        bytes.len(),
        &crate::ID,
        &seeds,
    )?;

    let mut dst = hook_account.try_borrow_mut()?;
    dst[..bytes.len()].copy_from_slice(&bytes);
    Ok(())
}

fn validate_hook_args(args: &PublishHookArgs) -> ProgramResult {
    if args.hook_id.is_empty() || args.hook_id.len() > MAX_HOOK_ID_LEN {
        return Err(PookError::InvalidHookDefinition.into());
    }
    if args.data_template.len() > MAX_DATA_TEMPLATE_LEN
        || args.data_slots.len() > MAX_DATA_SLOTS
        || args.account_slots.len() > MAX_ACCOUNT_SLOTS
        || args.companions.len() > MAX_COMPANIONS
    {
        return Err(PookError::InvalidHookDefinition.into());
    }
    // Never allow a hook to target Pook itself, SPP, SystemProgram, or BPF Loader.
    if args.target_program == *crate::ID.as_array()
        || args.target_program == SHIELDED_POOL_PROGRAM_ID
        || args.target_program == SYSTEM_PROGRAM_ID
        || args.target_program == BPF_LOADER_UPGRADEABLE_ID
    {
        return Err(PookError::InvalidHookDefinition.into());
    }

    // Flow hooks must have an input asset (they spend balance notes via `Run`).
    if args.kind == HookKind::Flow && args.mint_in == MintConstraint::None {
        return Err(PookError::InvalidHookDefinition.into());
    }

    let mut seen_caller_remaining = false;
    for slot in &args.account_slots {
        match slot.kind {
            AccountSlotKind::StagePda => {}
            AccountSlotKind::SeatPda | AccountSlotKind::Payer => {
                if args.kind != HookKind::Seat {
                    return Err(PookError::InvalidHookDefinition.into());
                }
            }
            AccountSlotKind::CallerRemaining => {
                if slot.is_signer || seen_caller_remaining {
                    return Err(PookError::InvalidHookDefinition.into());
                }
                seen_caller_remaining = true;
            }
            AccountSlotKind::Fixed
            | AccountSlotKind::StageIn
            | AccountSlotKind::StageOut
            | AccountSlotKind::Caller => {
                if slot.is_signer {
                    return Err(PookError::InvalidHookDefinition.into());
                }
            }
        }
    }

    for companion in &args.companions {
        if companion.disc_len as usize > 8 {
            return Err(PookError::InvalidHookDefinition.into());
        }
    }
    Ok(())
}

pub fn load_hook(hook_account: &AccountView) -> Result<Hook, pinocchio::error::ProgramError> {
    if !address_eq(hook_account.owner(), &crate::ID) {
        return Err(PookError::InvalidHookAccount.into());
    }
    let data = hook_account.try_borrow()?;
    if data.len() < 8 || data[0..8] != disc::HOOK {
        return Err(PookError::InvalidHookAccount.into());
    }
    borsh::from_slice::<Hook>(&data).map_err(|_| PookError::InvalidHookAccount.into())
}
