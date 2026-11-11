extern crate alloc;

#[cfg(any(feature = "circuits", feature = "wasm"))]
pub mod circuits;

pub mod error;
#[cfg(not(xark))]
pub mod pda;
pub mod state;

#[cfg(all(not(feature = "build-circuits"), not(feature = "wasm"), not(xark)))]
pub mod instructions;
#[cfg(all(not(feature = "build-circuits"), not(feature = "wasm"), not(xark)))]
#[rustfmt::skip]
pub mod verifier;

#[cfg(all(not(feature = "build-circuits"), not(feature = "wasm"), not(xark)))]
use pinocchio::{address::address_eq, error::ProgramError, AccountView, Address, ProgramResult};

pub mod tag {
    pub const INIT_CONFIG: u8 = 0;
    pub const SET_CONFIG: u8 = 1;
    pub const PUBLISH_HOOK: u8 = 2;
    pub const ENTER: u8 = 3;
    pub const RUN: u8 = 4;
    pub const LEAVE: u8 = 5;
    pub const OPEN_SEAT: u8 = 6;
    pub const CLOSE_SEAT: u8 = 7;
    pub const CLAIM_AUTHOR_FEES: u8 = 8;
}

pinocchio::address::declare_id!("7qvNkZjiikySgCNbr8jbWbUziVka3Rw1NLwcxwmwwRwd");

#[cfg(all(feature = "bpf-entrypoint", not(feature = "build-circuits"), not(feature = "wasm"), not(xark)))]
mod entrypoint {
    pinocchio::entrypoint!(crate::process_instruction);
}

#[cfg(all(not(feature = "build-circuits"), not(feature = "wasm"), not(xark)))]
pub fn process_instruction(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    if !address_eq(program_id, &crate::ID) {
        return Err(ProgramError::IncorrectProgramId);
    }

    let (ix_tag, ix_data) = instruction_data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;

    match *ix_tag {
        tag::INIT_CONFIG => instructions::config::process_init_config(accounts, ix_data),
        tag::SET_CONFIG => instructions::config::process_set_config(accounts, ix_data),
        tag::PUBLISH_HOOK => instructions::hook::process_publish_hook(accounts, ix_data),
        tag::ENTER => instructions::enter::process_enter(accounts, ix_data),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}
