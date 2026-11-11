use borsh::{BorshDeserialize, BorshSerialize};
use pinocchio::{
    address::address_eq,
    cpi::{invoke_signed_with_bounds, Signer},
    instruction::{InstructionAccount, InstructionView},
    AccountView, ProgramResult,
};
use spr_account_checks::AccountIterator;
use spr_interface::{
    instruction::{
        instruction_data::transact::{OwnerTag, TransactIxDataRef},
        tag as spp_tag,
    },
    PROGRAM_ID_PUBKEY,
};

use crate::{
    error::PookError,
    instructions::shared::{cpi_spp_deposit_sol, cpi_spp_deposit_spl, derive_authority},
};

/// `enter` needs no ZK circuit:
/// - `PublicSol` / `PublicSpl`: proofless SPP `deposit` from the holder's public wallet
///   directly to their one-time `owner_hash` with `view_tag = authority_pda`.
/// - `PrivateRings`: forwards an SPP `transact` signed by the holder's Rings wallet whose
///   target output carries `owner_tag = Inline(authority_pda)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum EnterPublicKind {
    Sol,
    Spl { spl_interface_bump: u8 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct EnterPublicArgs {
    pub kind: EnterPublicKind,
    pub authority_bump: u8,
    pub owner_hash: [u8; 32],
    pub amount: u64,
}

/// First byte of `enter` instruction data selects mode:
/// - `0` = public wallet deposit (`EnterPublicArgs`, Borsh)
/// - `1` = from Rings private balance (`authority_bump: u8` + raw `TransactIxData` bytes)
pub fn process_enter(accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let (mode, rest) = data
        .split_first()
        .ok_or(PookError::InvalidInstructionData)?;
    match *mode {
        0 => process_enter_public(accounts, rest),
        1 => process_enter_private(accounts, rest),
        _ => Err(PookError::InvalidInstructionData.into()),
    }
}

/// Accounts (Public SOL):
/// 0. `depositor` (signer, writable)
/// 1. `tree` (writable)
/// 2. `spp_program`
/// 3. `system_program`
/// 4. `sol_interface` (writable)
///
/// Accounts (Public SPL):
/// 0. `depositor` (signer, writable)
/// 1. `tree` (writable)
/// 2. `spp_program`
/// 3. `token_program`
/// 4. `mint`
/// 5. `user_token` (writable)
/// 6. `spl_interface` (writable)
fn process_enter_public(accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let args = borsh::from_slice::<EnterPublicArgs>(data)
        .map_err(|_| PookError::InvalidInstructionData)?;
    if args.amount == 0 {
        return Err(PookError::InvalidInstructionData.into());
    }
    let authority_pda = derive_authority(args.authority_bump)?;
    let view_tag = *authority_pda.as_array();

    let mut iter = AccountIterator::new(accounts);
    let depositor = iter.next_signer_mut("depositor")?;
    let tree = iter.next_mut("tree")?;
    let spp_program = iter.next_account("spp_program")?;

    match args.kind {
        EnterPublicKind::Sol => {
            let system_program = iter.next_account("system_program")?;
            let sol_interface = iter.next_mut("sol_interface")?;
            cpi_spp_deposit_sol(
                tree,
                depositor,
                spp_program,
                system_program,
                sol_interface,
                view_tag,
                args.owner_hash,
                args.amount,
                &[],
            )
        }
        EnterPublicKind::Spl { spl_interface_bump } => {
            let token_program = iter.next_account("token_program")?;
            let mint = iter.next_account("mint")?;
            let user_token = iter.next_mut("user_token")?;
            let spl_interface = iter.next_mut("spl_interface")?;
            cpi_spp_deposit_spl(
                tree,
                depositor,
                spp_program,
                token_program,
                mint,
                user_token,
                spl_interface,
                spl_interface_bump,
                view_tag,
                args.owner_hash,
                args.amount,
                &[],
            )
        }
    }
}

/// Forward a holder-signed SPP `transact` moving balance from a Rings private
/// wallet into a Pook one-time note, asserting at least one output carries
/// `owner_tag = Inline(authority_pda)`.
///
/// Accounts: verbatim SPP `transact` accounts.
fn process_enter_private(accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let (authority_bump, transact_bytes) = data
        .split_first()
        .ok_or(PookError::InvalidInstructionData)?;
    let authority_pda = derive_authority(*authority_bump)?;
    let transact = TransactIxDataRef::from_bytes(transact_bytes)
        .map_err(|_| PookError::InvalidInstructionData)?;

    let has_pook_tag = transact.outputs.iter().any(|out| {
        matches!(out.owner_tag, OwnerTag::Inline(tag) if tag == *authority_pda.as_array())
    });
    if !has_pook_tag {
        return Err(PookError::InvalidEnterOwnerTag.into());
    }

    let spp_program = accounts
        .get(2)
        .ok_or(PookError::InvalidShieldedPoolProgram)?;
    if !address_eq(spp_program.address(), &PROGRAM_ID_PUBKEY) {
        return Err(PookError::InvalidShieldedPoolProgram.into());
    }

    let metas: alloc::vec::Vec<InstructionAccount> = accounts
        .iter()
        .map(|a| InstructionAccount::new(a.address(), a.is_writable(), a.is_signer()))
        .collect();
    let mut ix_data = alloc::vec::Vec::with_capacity(1 + transact_bytes.len());
    ix_data.push(spp_tag::TRANSACT);
    ix_data.extend_from_slice(transact_bytes);
    let ix = InstructionView {
        program_id: &PROGRAM_ID_PUBKEY,
        accounts: &metas,
        data: &ix_data,
    };
    let signers: [Signer; 0] = [];
    invoke_signed_with_bounds::<32, _>(&ix, accounts, &signers)
}
