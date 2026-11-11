use borsh::{BorshDeserialize, BorshSerialize};
use pinocchio::{
    address::address_eq,
    cpi::Seed,
    AccountView, ProgramResult,
};
use spr_account_checks::AccountIterator;

use crate::{
    error::PookError,
    instructions::shared::{create_pda_account, load_config},
    pda::{find_config_pda, CONFIG_SEED},
    state::{disc, Config},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct InitConfigArgs {
    pub fee_recipient: [u8; 32],
    pub run_fee_bps: u16,
    pub author_share_bps: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct SetConfigArgs {
    pub admin: [u8; 32],
    pub fee_recipient: [u8; 32],
    pub run_fee_bps: u16,
    pub author_share_bps: u16,
}

/// Accounts:
/// 0. `admin` (signer, writable — pays rent)
/// 1. `config` (writable PDA `[b"config"]`)
/// 2. `system_program`
pub fn process_init_config(accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let args = borsh::from_slice::<InitConfigArgs>(data)
        .map_err(|_| PookError::InvalidInstructionData)?;
    if args.run_fee_bps > 10_000 || args.author_share_bps > 10_000 {
        return Err(PookError::InvalidFeeRate.into());
    }

    let mut iter = AccountIterator::new(accounts);
    let admin = iter.next_signer_mut("admin")?;
    let config_account = iter.next_mut("config")?;
    let system_program = iter.next_account("system_program")?;

    let (expected_config, bump) = find_config_pda();
    if !address_eq(config_account.address(), &expected_config) {
        return Err(PookError::InvalidConfigAccount.into());
    }
    if config_account.lamports() > 0 || !config_account.is_data_empty() {
        return Err(PookError::ConfigAlreadyInitialized.into());
    }

    let bump_slice = [bump];
    let seeds = [Seed::from(CONFIG_SEED), Seed::from(&bump_slice)];
    create_pda_account(
        admin,
        config_account,
        system_program,
        Config::LEN,
        &crate::ID,
        &seeds,
    )?;

    let config = Config {
        discriminator: disc::CONFIG,
        admin: *admin.address().as_array(),
        fee_recipient: args.fee_recipient,
        run_fee_bps: args.run_fee_bps,
        author_share_bps: args.author_share_bps,
        bump,
    };
    let bytes = borsh::to_vec(&config).map_err(|_| PookError::InvalidInstructionData)?;
    let mut dst = config_account.try_borrow_mut()?;
    dst[..bytes.len()].copy_from_slice(&bytes);
    Ok(())
}

/// Accounts:
/// 0. `admin` (signer)
/// 1. `config` (writable PDA `[b"config"]`)
pub fn process_set_config(accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let args = borsh::from_slice::<SetConfigArgs>(data)
        .map_err(|_| PookError::InvalidInstructionData)?;
    if args.run_fee_bps > 10_000 || args.author_share_bps > 10_000 {
        return Err(PookError::InvalidFeeRate.into());
    }

    let mut iter = AccountIterator::new(accounts);
    let admin = iter.next_signer_non_mut("admin")?;
    let config_account = iter.next_mut("config")?;

    let (expected_config, _) = find_config_pda();
    if !address_eq(config_account.address(), &expected_config) {
        return Err(PookError::InvalidConfigAccount.into());
    }
    let mut config = load_config(config_account)?;
    if admin.address().as_array() != &config.admin {
        return Err(PookError::UnauthorizedAdmin.into());
    }

    config.admin = args.admin;
    config.fee_recipient = args.fee_recipient;
    config.run_fee_bps = args.run_fee_bps;
    config.author_share_bps = args.author_share_bps;

    let bytes = borsh::to_vec(&config).map_err(|_| PookError::InvalidInstructionData)?;
    let mut dst = config_account.try_borrow_mut()?;
    dst[..bytes.len()].copy_from_slice(&bytes);
    Ok(())
}
