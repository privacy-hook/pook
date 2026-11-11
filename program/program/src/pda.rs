use pinocchio::Address;

pub const AUTHORITY_SEED: &[u8] = b"authority";
pub const STAGE_SEED: &[u8] = b"stage";
pub const CONFIG_SEED: &[u8] = b"config";
pub const HOOK_SEED: &[u8] = b"hook";
pub const AUTHOR_FEES_SEED: &[u8] = b"author_fees";
pub const SEAT_SEED: &[u8] = b"seat";
pub const SEAT_STATE_SEED: &[u8] = b"seat_state";

/// Wrapped SOL mint (`So11111111111111111111111111111111111111112`).
pub const WSOL_MINT: [u8; 32] =
    *Address::from_str_const("So11111111111111111111111111111111111111112").as_array();

/// Instructions sysvar (`Sysvar1nstructions1111111111111111111111111`).
pub const INSTRUCTIONS_SYSVAR_ID: [u8; 32] =
    *Address::from_str_const("Sysvar1nstructions1111111111111111111111111").as_array();

/// System program ID (`11111111111111111111111111111111`).
pub const SYSTEM_PROGRAM_ID: [u8; 32] = [0u8; 32];

pub fn find_authority_pda() -> (Address, u8) {
    Address::find_program_address(&[AUTHORITY_SEED], &crate::ID)
}

pub fn find_stage_pda() -> (Address, u8) {
    Address::find_program_address(&[STAGE_SEED], &crate::ID)
}

pub fn find_config_pda() -> (Address, u8) {
    Address::find_program_address(&[CONFIG_SEED], &crate::ID)
}

pub fn find_hook_pda(hook_id_hash: &[u8; 32]) -> (Address, u8) {
    Address::find_program_address(&[HOOK_SEED, hook_id_hash], &crate::ID)
}

pub fn find_author_fees_pda(author: &[u8; 32], mint: &[u8; 32]) -> (Address, u8) {
    Address::find_program_address(&[AUTHOR_FEES_SEED, author, mint], &crate::ID)
}

pub fn find_seat_pda(commitment: &[u8; 32]) -> (Address, u8) {
    Address::find_program_address(&[SEAT_SEED, commitment], &crate::ID)
}

pub fn find_seat_state_pda(commitment: &[u8; 32]) -> (Address, u8) {
    Address::find_program_address(&[SEAT_STATE_SEED, commitment], &crate::ID)
}

pub fn find_ata(owner: &[u8; 32], mint: &[u8; 32], token_program: &[u8; 32]) -> (Address, u8) {
    let ata_prog = Address::new_from_array(spr_interface::ASSOCIATED_TOKEN_PROGRAM_ID);
    Address::find_program_address(&[owner, token_program, mint], &ata_prog)
}

/// Deterministic 32-byte hash of a hook id UTF-8 string (`Sha256BE(hook_id)`).
#[cfg(not(xark))]
pub fn hook_id_hash(hook_id: &str) -> Result<[u8; 32], crate::error::PookError> {
    use spr_hasher::{sha256::Sha256BE, Hasher};
    Sha256BE::hashv(&[hook_id.as_bytes()]).map_err(|_| crate::error::PookError::HashingFailed)
}
