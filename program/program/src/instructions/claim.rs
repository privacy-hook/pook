use borsh::{BorshDeserialize, BorshSerialize};
use pinocchio::{
    address::address_eq,
    cpi::{Seed, Signer},
    sysvars::{rent::Rent, Sysvar},
    AccountView, ProgramResult,
};
use spr_account_checks::AccountIterator;

use crate::{
    error::PookError,
    instructions::shared::{cpi_token_transfer_checked, read_mint_decimals},
    pda::{find_ata, find_author_fees_pda, AUTHOR_FEES_SEED},
    state::{disc, AuthorFees},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct ClaimAuthorFeesArgs {
    /// `[0u8; 32]` for native SOL, or the SPL / Token-2022 mint pubkey.
    pub mint: [u8; 32],
}

/// Accounts (SOL, `args.mint == [0u8; 32]`):
/// 0. `author` (signer, writable)
/// 1. `author_fees` (writable PDA `[b"author_fees", author, [0;32]]`)
///
/// Accounts (SPL, `args.mint != [0u8; 32]`):
/// 0. `author` (signer, writable)
/// 1. `author_fees` (writable PDA `[b"author_fees", author, mint]`)
/// 2. `token_program`
/// 3. `mint`
/// 4. `author_fees_ata` (writable, ATA of `author_fees` for `mint`)
/// 5. `author_dest_ata` (writable, token account receiving claimed fees)
pub fn process_claim_author_fees(accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let args = borsh::from_slice::<ClaimAuthorFeesArgs>(data)
        .map_err(|_| PookError::InvalidInstructionData)?;

    let mut iter = AccountIterator::new(accounts);
    let author = iter.next_signer_mut("author")?;
    let author_fees_acct = iter.next_mut("author_fees")?;

    let (expected_pda, bump) = find_author_fees_pda(author.address().as_array(), &args.mint);
    if !address_eq(author_fees_acct.address(), &expected_pda)
        || !address_eq(author_fees_acct.owner(), &crate::ID)
    {
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
    if &state.author != author.address().as_array() {
        return Err(PookError::UnauthorizedAuthor.into());
    }
    let amount = state.accrued;
    if amount == 0 {
        return Err(PookError::NothingToClaim.into());
    }

    state.accrued = 0;
    {
        let bytes = borsh::to_vec(&state).map_err(|_| PookError::InvalidInstructionData)?;
        let mut raw = author_fees_acct.try_borrow_mut()?;
        raw[..bytes.len()].copy_from_slice(&bytes);
    }

    if args.mint == [0u8; 32] {
        // Direct lamport transfer keeping rent-exempt minimum in `author_fees`.
        let rent = Rent::get()?.try_minimum_balance(AuthorFees::LEN)?;
        let current = author_fees_acct.lamports();
        let available = current.saturating_sub(rent);
        let payout = amount.min(available);
        if payout == 0 {
            return Err(PookError::NothingToClaim.into());
        }
        author_fees_acct.set_lamports(current - payout);
        author.set_lamports(author.lamports().checked_add(payout).ok_or(PookError::Overflow)?);
        Ok(())
    } else {
        let token_program = iter.next_account("token_program")?;
        let mint_acct = iter.next_account("mint")?;
        let author_fees_ata = iter.next_mut("author_fees_ata")?;
        let author_dest_ata = iter.next_mut("author_dest_ata")?;

        if mint_acct.address().as_array() != &args.mint {
            return Err(PookError::InvalidAuthorFeesAccount.into());
        }
        let (expected_ata, _) = find_ata(
            author_fees_acct.address().as_array(),
            &args.mint,
            token_program.address().as_array(),
        );
        if !address_eq(author_fees_ata.address(), &expected_ata) {
            return Err(PookError::InvalidAuthorFeesAccount.into());
        }
        let decimals = read_mint_decimals(mint_acct)?;
        let bump_slice = [bump];
        let seeds = [
            Seed::from(AUTHOR_FEES_SEED),
            Seed::from(author.address().as_array().as_slice()),
            Seed::from(args.mint.as_slice()),
            Seed::from(&bump_slice),
        ];
        cpi_token_transfer_checked(
            token_program,
            author_fees_ata,
            mint_acct,
            author_dest_ata,
            author_fees_acct,
            amount,
            decimals,
            &[Signer::from(&seeds)],
        )
    }
}
