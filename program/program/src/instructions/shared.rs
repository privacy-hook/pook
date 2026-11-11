use alloc::{vec, vec::Vec};
use pinocchio::{
    address::address_eq,
    cpi::{invoke_signed_with_bounds, Seed, Signer},
    error::ProgramError,
    instruction::{InstructionAccount, InstructionView},
    sysvars::{rent::Rent, Sysvar},
    AccountView, Address, ProgramResult,
};
use spr_hasher::{sha256::Sha256BE, Hasher};
use spr_interface::{
    instruction::{
        instruction_data::transact::TransactIxDataRef, tag as spp_tag, DepositAssetKind,
        DepositEntry, DepositIxData,
    },
    PROGRAM_ID_PUBKEY, SPL_TOKEN_2022_PROGRAM_ID, SPL_TOKEN_ACCOUNT_AMOUNT_END,
    SPL_TOKEN_ACCOUNT_AMOUNT_OFFSET, SPL_TOKEN_ACCOUNT_LEN, SPL_TOKEN_PROGRAM_ID,
    SPL_TOKEN_TRANSFER_CHECKED_DISCRIMINATOR,
};
use spr_program::cpi::{SppTransactAccounts, TransactAccountsError};
use wincode::{config::DefaultConfig, SchemaReadOwned};

use crate::{
    error::PookError,
    pda::{AUTHORITY_SEED, STAGE_SEED, SYSTEM_PROGRAM_ID},
    state::{disc, Config},
};

pub const CALL_HASH_DOMAIN: &[u8] = b"PKCALL01";
pub const SPL_TOKEN_CLOSE_ACCOUNT_DISC: u8 = 9;
pub const SPL_TOKEN_SYNC_NATIVE_DISC: u8 = 17;

/// Instruction data: wincode-encoded `args`, followed by raw SPP `TransactIxData` bytes
/// forwarded verbatim to SPP.
pub struct IxData<'a, A> {
    pub args: A,
    pub transact: TransactIxDataRef<'a>,
    pub transact_bytes: &'a [u8],
}

impl<'a, A: SchemaReadOwned<DefaultConfig, Dst = A>> IxData<'a, A> {
    pub fn parse(data: &'a [u8]) -> Result<Self, ProgramError> {
        let mut transact_bytes = data;
        let args = wincode::deserialize_from(&mut transact_bytes)
            .map_err(|_| PookError::InvalidInstructionData)?;
        let transact = TransactIxDataRef::from_bytes(transact_bytes)
            .map_err(|_| PookError::InvalidInstructionData)?;
        Ok(Self {
            args,
            transact,
            transact_bytes,
        })
    }
}

pub fn check_not_expired(now: i64, expiry_unix_ts: u64) -> ProgramResult {
    if now >= 0 && (now as u64) <= expiry_unix_ts {
        Ok(())
    } else {
        Err(PookError::Expired.into())
    }
}

pub fn is_valid_token_program(addr: &Address) -> bool {
    addr.as_array() == &SPL_TOKEN_PROGRAM_ID || addr.as_array() == &SPL_TOKEN_2022_PROGRAM_ID
}

pub fn check_system_program(account: &AccountView) -> ProgramResult {
    if account.address().as_array() != &SYSTEM_PROGRAM_ID {
        return Err(PookError::InvalidSystemProgram.into());
    }
    Ok(())
}

/// Read the token balance (u64 LE at bytes 64..72) of an SPL / Token-2022 token account.
pub fn read_token_amount(account: &AccountView) -> Result<u64, ProgramError> {
    let data = account.try_borrow()?;
    if data.len() < SPL_TOKEN_ACCOUNT_LEN {
        return Err(PookError::InvalidStageTokenAccount.into());
    }
    let bytes: [u8; 8] = data[SPL_TOKEN_ACCOUNT_AMOUNT_OFFSET..SPL_TOKEN_ACCOUNT_AMOUNT_END]
        .try_into()
        .map_err(|_| PookError::InvalidStageTokenAccount)?;
    Ok(u64::from_le_bytes(bytes))
}

/// Read the owner (bytes 32..64) and mint (bytes 0..32) of an SPL / Token-2022 token account.
pub fn check_token_account_mint_and_owner(
    account: &AccountView,
    expected_mint: &[u8; 32],
    expected_owner: &[u8; 32],
) -> ProgramResult {
    let data = account.try_borrow()?;
    if data.len() < SPL_TOKEN_ACCOUNT_LEN {
        return Err(PookError::InvalidStageTokenAccount.into());
    }
    if &data[0..32] != expected_mint || &data[32..64] != expected_owner {
        return Err(PookError::InvalidStageTokenAccount.into());
    }
    Ok(())
}

/// Read decimals (byte 44) of an SPL / Token-2022 mint account.
pub fn read_mint_decimals(mint_account: &AccountView) -> Result<u8, ProgramError> {
    let data = mint_account.try_borrow()?;
    if data.len() < spr_interface::SPL_TOKEN_MINT_ACCOUNT_LEN {
        return Err(PookError::InvalidStageTokenAccount.into());
    }
    Ok(data[44])
}

/// Load and validate `Config` from a Pook-owned account.
pub fn load_config(config_account: &AccountView) -> Result<Config, ProgramError> {
    if !address_eq(config_account.owner(), &crate::ID) {
        return Err(PookError::InvalidConfigAccount.into());
    }
    let data = config_account.try_borrow()?;
    if data.len() < Config::LEN || data[0..8] != disc::CONFIG {
        return Err(PookError::InvalidConfigAccount.into());
    }
    borsh::from_slice::<Config>(&data[..Config::LEN])
        .map_err(|_| PookError::InvalidConfigAccount.into())
}

/// Create a PDA account via SystemProgram `CreateAccount`.
pub fn create_pda_account(
    payer: &AccountView,
    target: &AccountView,
    system_program: &AccountView,
    space: usize,
    owner: &Address,
    pda_seeds: &[Seed],
) -> ProgramResult {
    check_system_program(system_program)?;
    let rent = Rent::get()?;
    let lamports = rent.try_minimum_balance(space)?;

    let mut ix_data = [0u8; 52];
    ix_data[0..4].copy_from_slice(&0u32.to_le_bytes());
    ix_data[4..12].copy_from_slice(&lamports.to_le_bytes());
    ix_data[12..20].copy_from_slice(&(space as u64).to_le_bytes());
    ix_data[20..52].copy_from_slice(owner.as_array());

    let metas = [
        InstructionAccount::writable_signer(payer.address()),
        InstructionAccount::writable_signer(target.address()),
    ];
    let ix = InstructionView {
        program_id: system_program.address(),
        accounts: &metas,
        data: &ix_data,
    };
    let signers = [Signer::from(pda_seeds)];
    invoke_signed_with_bounds::<4, _>(&ix, &[payer, target], &signers)
}

/// SystemProgram transfer signed by a PDA (or top-level signer when `signers` is empty).
pub fn cpi_system_transfer(
    from: &AccountView,
    to: &AccountView,
    system_program: &AccountView,
    lamports: u64,
    signers: &[Signer],
) -> ProgramResult {
    if lamports == 0 {
        return Ok(());
    }
    check_system_program(system_program)?;
    let mut ix_data = [0u8; 12];
    ix_data[0..4].copy_from_slice(&2u32.to_le_bytes());
    ix_data[4..12].copy_from_slice(&lamports.to_le_bytes());

    let metas = [
        InstructionAccount::writable_signer(from.address()),
        InstructionAccount::writable(to.address()),
    ];
    let ix = InstructionView {
        program_id: system_program.address(),
        accounts: &metas,
        data: &ix_data,
    };
    invoke_signed_with_bounds::<4, _>(&ix, &[from, to], signers)
}

/// SPL Token / Token-2022 `TransferChecked` CPI.
pub fn cpi_token_transfer_checked(
    token_program: &AccountView,
    source: &AccountView,
    mint: &AccountView,
    dest: &AccountView,
    authority: &AccountView,
    amount: u64,
    decimals: u8,
    signers: &[Signer],
) -> ProgramResult {
    if amount == 0 {
        return Ok(());
    }
    if !is_valid_token_program(token_program.address()) {
        return Err(PookError::InvalidTokenProgram.into());
    }
    let mut ix_data = [0u8; 10];
    ix_data[0] = SPL_TOKEN_TRANSFER_CHECKED_DISCRIMINATOR;
    ix_data[1..9].copy_from_slice(&amount.to_le_bytes());
    ix_data[9] = decimals;

    let metas = [
        InstructionAccount::writable(source.address()),
        InstructionAccount::readonly(mint.address()),
        InstructionAccount::writable(dest.address()),
        InstructionAccount::readonly_signer(authority.address()),
    ];
    let ix = InstructionView {
        program_id: token_program.address(),
        accounts: &metas,
        data: &ix_data,
    };
    invoke_signed_with_bounds::<6, _>(&ix, &[source, mint, dest, authority], signers)
}

/// Bare SPL Token `SyncNative` CPI (no extra accounts, per p-token mainnet rules).
pub fn cpi_sync_native(token_program: &AccountView, wsol_account: &AccountView) -> ProgramResult {
    if !is_valid_token_program(token_program.address()) {
        return Err(PookError::InvalidTokenProgram.into());
    }
    let ix_data = [SPL_TOKEN_SYNC_NATIVE_DISC];
    let metas = [InstructionAccount::writable(wsol_account.address())];
    let ix = InstructionView {
        program_id: token_program.address(),
        accounts: &metas,
        data: &ix_data,
    };
    invoke_signed_with_bounds::<2, _>(&ix, &[wsol_account], &[])
}

/// SPL Token `CloseAccount` CPI signed by `authority`.
pub fn cpi_close_token_account(
    token_program: &AccountView,
    account: &AccountView,
    dest: &AccountView,
    authority: &AccountView,
    signers: &[Signer],
) -> ProgramResult {
    if !is_valid_token_program(token_program.address()) {
        return Err(PookError::InvalidTokenProgram.into());
    }
    let ix_data = [SPL_TOKEN_CLOSE_ACCOUNT_DISC];
    let metas = [
        InstructionAccount::writable(account.address()),
        InstructionAccount::writable(dest.address()),
        InstructionAccount::readonly_signer(authority.address()),
    ];
    let ix = InstructionView {
        program_id: token_program.address(),
        accounts: &metas,
        data: &ix_data,
    };
    invoke_signed_with_bounds::<4, _>(&ix, &[account, dest, authority], signers)
}

/// Invoke SPP `transact` signed by Pook's `authority_pda`.
#[inline(never)]
pub fn cpi_spp_transact_with_authority(
    authority_pda: &Address,
    authority_bump: u8,
    spp_accounts: &[AccountView],
    transact_bytes: &[u8],
) -> ProgramResult {
    let signer_pdas = [authority_pda];
    let spp = SppTransactAccounts::new(spp_accounts, &signer_pdas).map_err(|e| match e {
        TransactAccountsError::InvalidSppProgram => PookError::InvalidShieldedPoolProgram.into(),
        TransactAccountsError::MissingPdaSigner { .. } => PookError::MissingAuthorityPda.into(),
        TransactAccountsError::NotEnoughAccounts => ProgramError::NotEnoughAccountKeys,
    })?;
    let bump = [authority_bump];
    let seeds = [Seed::from(AUTHORITY_SEED), Seed::from(&bump)];
    spp.invoke::<32>(transact_bytes, &[Signer::from(&seeds)])
}

/// One asset leg for a batched SPP proofless `deposit` (tag 11).
pub enum SppDepositLeg<'a> {
    Sol {
        system_program: &'a AccountView,
        sol_interface: &'a AccountView,
        amount: u64,
    },
    Spl {
        token_program: &'a AccountView,
        mint: &'a AccountView,
        user_token: &'a AccountView,
        spl_interface: &'a AccountView,
        spl_interface_bump: u8,
        amount: u64,
    },
}

/// Invoke SPP proofless `deposit` (tag 11) for up to 2 asset legs to `(view_tag, owner)`.
///
/// Matches SPP's required account parse order: the SOL settlement group (if present) is
/// always asset index 0, followed by distinct SPL mints in order. Legs of the same mint
/// are summed into a single `DepositEntry`; zero-amount legs are ignored.
#[inline(never)]
pub fn cpi_spp_deposit_batch(
    tree: &AccountView,
    depositor: &AccountView,
    spp_program: &AccountView,
    view_tag: [u8; 32],
    owner: [u8; 32],
    legs: &[SppDepositLeg<'_>],
    signers: &[Signer],
) -> ProgramResult {
    if !address_eq(spp_program.address(), &PROGRAM_ID_PUBKEY) {
        return Err(PookError::InvalidShieldedPoolProgram.into());
    }

    let mut sol_sys: Option<&AccountView> = None;
    let mut sol_if: Option<&AccountView> = None;
    let mut sol_amount: u64 = 0;

    let mut spl_groups: Vec<(&AccountView, &AccountView, &AccountView, &AccountView, u8, u64)> =
        Vec::with_capacity(legs.len());

    for leg in legs {
        match *leg {
            SppDepositLeg::Sol {
                system_program,
                sol_interface,
                amount,
            } => {
                if amount == 0 {
                    continue;
                }
                sol_sys = Some(system_program);
                sol_if = Some(sol_interface);
                sol_amount = sol_amount.checked_add(amount).ok_or(PookError::Overflow)?;
            }
            SppDepositLeg::Spl {
                token_program,
                mint,
                user_token,
                spl_interface,
                spl_interface_bump,
                amount,
            } => {
                if amount == 0 {
                    continue;
                }
                if let Some(existing) = spl_groups
                    .iter_mut()
                    .find(|g| address_eq(g.1.address(), mint.address()))
                {
                    existing.5 = existing.5.checked_add(amount).ok_or(PookError::Overflow)?;
                } else {
                    spl_groups.push((
                        token_program,
                        mint,
                        user_token,
                        spl_interface,
                        spl_interface_bump,
                        amount,
                    ));
                }
            }
        }
    }

    let has_sol = sol_amount > 0;
    let asset_count = usize::from(has_sol) + spl_groups.len();
    if asset_count == 0 {
        return Err(PookError::InvalidInstructionData.into());
    }

    let mut assets = Vec::with_capacity(asset_count);
    let mut deposits = Vec::with_capacity(asset_count);
    let mut metas: Vec<InstructionAccount> = Vec::with_capacity(3 + 2 * usize::from(has_sol) + 4 * spl_groups.len());
    let mut views: Vec<&AccountView> = Vec::with_capacity(3 + 2 * usize::from(has_sol) + 4 * spl_groups.len());

    metas.push(InstructionAccount::writable(tree.address()));
    metas.push(InstructionAccount::writable_signer(depositor.address()));
    metas.push(InstructionAccount::readonly(spp_program.address()));
    views.push(tree);
    views.push(depositor);
    views.push(spp_program);

    if has_sol {
        let sys = sol_sys.ok_or(PookError::InvalidSystemProgram)?;
        let sif = sol_if.ok_or(PookError::InvalidInstructionData)?;
        assets.push(DepositAssetKind::Sol);
        deposits.push(DepositEntry {
            asset_index: 0,
            view_tag,
            owner,
            amount: sol_amount,
            memo: None,
        });
        metas.push(InstructionAccount::readonly(sys.address()));
        metas.push(InstructionAccount::writable(sif.address()));
        views.push(sys);
        views.push(sif);
    }

    let spl_base = u8::from(has_sol);
    for (idx, (tp, mint, user_token, spl_if, bump, amount)) in spl_groups.into_iter().enumerate() {
        let asset_index = spl_base
            .checked_add(u8::try_from(idx).map_err(|_| PookError::Overflow)?)
            .ok_or(PookError::Overflow)?;
        assets.push(DepositAssetKind::Spl {
            spl_interface_bump: bump,
        });
        deposits.push(DepositEntry {
            asset_index,
            view_tag,
            owner,
            amount,
            memo: None,
        });
        metas.push(InstructionAccount::readonly(tp.address()));
        metas.push(InstructionAccount::readonly(mint.address()));
        metas.push(InstructionAccount::writable(user_token.address()));
        metas.push(InstructionAccount::writable(spl_if.address()));
        views.push(tp);
        views.push(mint);
        views.push(user_token);
        views.push(spl_if);
    }

    let ix_struct = DepositIxData { assets, deposits };
    let payload = ix_struct
        .serialize()
        .map_err(|_| PookError::InvalidInstructionData)?;
    let mut data = Vec::with_capacity(1 + payload.len());
    data.push(spp_tag::DEPOSIT);
    data.extend_from_slice(&payload);

    let ix = InstructionView {
        program_id: &PROGRAM_ID_PUBKEY,
        accounts: &metas,
        data: &data,
    };
    invoke_signed_with_bounds::<12, _>(&ix, &views, signers)
}

/// Invoke SPP proofless `deposit` (tag 11) for one native SOL output.
/// `depositor` must be writable and either already a signer or signed by `signers`.
pub fn cpi_spp_deposit_sol(
    tree: &AccountView,
    depositor: &AccountView,
    spp_program: &AccountView,
    system_program: &AccountView,
    sol_interface: &AccountView,
    view_tag: [u8; 32],
    owner: [u8; 32],
    amount: u64,
    signers: &[Signer],
) -> ProgramResult {
    if !address_eq(spp_program.address(), &PROGRAM_ID_PUBKEY) {
        return Err(PookError::InvalidShieldedPoolProgram.into());
    }
    let ix_struct = DepositIxData {
        assets: vec![DepositAssetKind::Sol],
        deposits: vec![DepositEntry {
            asset_index: 0,
            view_tag,
            owner,
            amount,
            memo: None,
        }],
    };
    let payload = ix_struct
        .serialize()
        .map_err(|_| PookError::InvalidInstructionData)?;
    let mut data = Vec::with_capacity(1 + payload.len());
    data.push(spp_tag::DEPOSIT);
    data.extend_from_slice(&payload);

    let metas = [
        InstructionAccount::writable(tree.address()),
        InstructionAccount::writable_signer(depositor.address()),
        InstructionAccount::readonly(spp_program.address()),
        InstructionAccount::readonly(system_program.address()),
        InstructionAccount::writable(sol_interface.address()),
    ];
    let ix = InstructionView {
        program_id: &PROGRAM_ID_PUBKEY,
        accounts: &metas,
        data: &data,
    };
    invoke_signed_with_bounds::<8, _>(
        &ix,
        &[tree, depositor, spp_program, system_program, sol_interface],
        signers,
    )
}

/// Invoke SPP proofless `deposit` (tag 11) for one SPL / Token-2022 output.
pub fn cpi_spp_deposit_spl(
    tree: &AccountView,
    depositor: &AccountView,
    spp_program: &AccountView,
    token_program: &AccountView,
    mint: &AccountView,
    user_token: &AccountView,
    spl_interface: &AccountView,
    spl_interface_bump: u8,
    view_tag: [u8; 32],
    owner: [u8; 32],
    amount: u64,
    signers: &[Signer],
) -> ProgramResult {
    if !address_eq(spp_program.address(), &PROGRAM_ID_PUBKEY) {
        return Err(PookError::InvalidShieldedPoolProgram.into());
    }
    let ix_struct = DepositIxData {
        assets: vec![DepositAssetKind::Spl { spl_interface_bump }],
        deposits: vec![DepositEntry {
            asset_index: 0,
            view_tag,
            owner,
            amount,
            memo: None,
        }],
    };
    let payload = ix_struct
        .serialize()
        .map_err(|_| PookError::InvalidInstructionData)?;
    let mut data = Vec::with_capacity(1 + payload.len());
    data.push(spp_tag::DEPOSIT);
    data.extend_from_slice(&payload);

    let metas = [
        InstructionAccount::writable(tree.address()),
        InstructionAccount::writable_signer(depositor.address()),
        InstructionAccount::readonly(spp_program.address()),
        InstructionAccount::readonly(token_program.address()),
        InstructionAccount::readonly(mint.address()),
        InstructionAccount::writable(user_token.address()),
        InstructionAccount::writable(spl_interface.address()),
    ];
    let ix = InstructionView {
        program_id: &PROGRAM_ID_PUBKEY,
        accounts: &metas,
        data: &data,
    };
    invoke_signed_with_bounds::<10, _>(
        &ix,
        &[
            tree,
            depositor,
            spp_program,
            token_program,
            mint,
            user_token,
            spl_interface,
        ],
        signers,
    )
}

/// Compute the canonical BN254 `call_hash` binding the exact target program,
/// output mint, resolved CPI data, and resolved CPI account metas.
pub fn compute_call_hash(
    target_program: &[u8; 32],
    has_mint_out: bool,
    mint_out: &[u8; 32],
    cpi_data: &[u8],
    cpi_metas: &[(Address, bool, bool)],
) -> Result<[u8; 32], PookError> {
    let mut buf = Vec::with_capacity(
        CALL_HASH_DOMAIN.len() + 32 + 1 + 32 + 4 + cpi_data.len() + 2 + cpi_metas.len() * 34,
    );
    buf.extend_from_slice(CALL_HASH_DOMAIN);
    buf.extend_from_slice(target_program);
    buf.push(u8::from(has_mint_out));
    buf.extend_from_slice(mint_out);
    buf.extend_from_slice(&(cpi_data.len() as u32).to_le_bytes());
    buf.extend_from_slice(cpi_data);
    buf.extend_from_slice(&(cpi_metas.len() as u16).to_le_bytes());
    for (key, is_writable, is_signer) in cpi_metas {
        buf.extend_from_slice(key.as_array());
        buf.push(u8::from(*is_writable));
        buf.push(u8::from(*is_signer));
    }
    Sha256BE::hashv(&[&buf]).map_err(|_| PookError::HashingFailed)
}

/// Compute `(run_fee, protocol_fee, author_fee)` from `delta_out` and `Config`.
/// Protocol share is rounded DOWN so the hook author keeps any rounding remainder.
pub fn compute_fee_split(delta_out: u64, config: &Config) -> Result<(u64, u64, u64), PookError> {
    let run_fee = ((delta_out as u128)
        .checked_mul(config.run_fee_bps as u128)
        .ok_or(PookError::Overflow)?
        / 10_000) as u64;
    let protocol_bps = 10_000u128
        .checked_sub(config.author_share_bps as u128)
        .ok_or(PookError::InvalidFeeRate)?;
    let protocol_fee = ((run_fee as u128)
        .checked_mul(protocol_bps)
        .ok_or(PookError::Overflow)?
        / 10_000) as u64;
    let author_fee = run_fee
        .checked_sub(protocol_fee)
        .ok_or(PookError::Overflow)?;
    Ok((run_fee, protocol_fee, author_fee))
}

/// Derive `authority_pda` from its bump and validate.
pub fn derive_authority(bump: u8) -> Result<Address, PookError> {
    Address::create_program_address(&[AUTHORITY_SEED, &[bump]], &crate::ID)
        .map_err(|_| PookError::InvalidAuthorityPda)
}

/// Derive `stage_pda` from its bump and validate.
pub fn derive_stage(bump: u8) -> Result<Address, PookError> {
    Address::create_program_address(&[STAGE_SEED, &[bump]], &crate::ID)
        .map_err(|_| PookError::InvalidStagePda)
}
