use alloc::{string::String, vec::Vec};
use borsh::{BorshDeserialize, BorshSerialize};

pub const MAX_HOOK_ID_LEN: usize = 48;
pub const MAX_DATA_TEMPLATE_LEN: usize = 256;
pub const MAX_DATA_SLOTS: usize = 16;
pub const MAX_ACCOUNT_SLOTS: usize = 48;
pub const MAX_COMPANIONS: usize = 8;

/// 8-byte account discriminators (first 8 bytes of SHA-256("pook:<Name>")).
pub mod disc {
    pub const CONFIG: [u8; 8] = *b"PKCONFIG";
    pub const HOOK: [u8; 8] = *b"PKHOOK01";
    pub const SEAT: [u8; 8] = *b"PKSEAT01";
    pub const AUTHOR_FEES: [u8; 8] = *b"PKAFEE01";
}

/// Global protocol configuration at PDA `[b"config"]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Config {
    pub discriminator: [u8; 8],
    pub admin: [u8; 32],
    pub fee_recipient: [u8; 32],
    /// Run fee in basis points of the output amount (0..=10_000).
    pub run_fee_bps: u16,
    /// Hook author's share of the run fee in basis points (0..=10_000).
    /// Protocol receives `run_fee - author_fee` (rounded down via `author_fee = ceil` / `protocol_fee = floor`).
    pub author_share_bps: u16,
    pub bump: u8,
}

impl Config {
    pub const LEN: usize = 8 + 32 + 32 + 2 + 2 + 1;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
#[borsh(use_discriminant = true)]
#[repr(u8)]
pub enum HookKind {
    /// Stateless flow hook (swap, supply, withdraw, stake, unstake). Stage PDA signs.
    Flow = 0,
    /// Stateful position hook (Kamino collateral deposit, borrow, repay, withdraw). Seat PDA signs.
    Seat = 1,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum MintConstraint {
    /// No asset moves on this side (e.g., `mint_out` on `kamino.repay` or `mint_in` on `kamino.borrow`).
    None,
    /// Any mint (SOL or SPL) chosen by the caller at run time (e.g., `jupiter.swap`).
    Any,
    /// Native SOL only (`[0u8; 32]`).
    Sol,
    /// Exact SPL / Token-2022 mint pubkey.
    Spl([u8; 32]),
}

impl MintConstraint {
    pub fn matches(&self, is_none: bool, mint: &[u8; 32]) -> bool {
        match self {
            Self::None => is_none,
            Self::Any => !is_none,
            Self::Sol => !is_none && *mint == [0u8; 32],
            Self::Spl(expected) => !is_none && mint == expected,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
#[borsh(use_discriminant = true)]
#[repr(u8)]
pub enum DataSlotKind {
    /// Overwrites 8 bytes at `offset` with `amount_in.to_le_bytes()`.
    AmountInU64Le = 0,
    /// Overwrites 8 bytes at `offset` with `min_out.to_le_bytes()`.
    MinOutU64Le = 1,
    /// Copies `len` bytes from the caller data stream into `cpi_data[offset..offset+len]`.
    CallerSlice = 2,
    /// Appends all remaining bytes from the caller data stream to `cpi_data`.
    CallerTail = 3,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct DataSlot {
    pub offset: u16,
    pub len: u16,
    pub kind: DataSlotKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
#[borsh(use_discriminant = true)]
#[repr(u8)]
pub enum AccountSlotKind {
    /// Fixed pubkey stored in the hook definition.
    Fixed = 0,
    /// Pook's Stage PDA (`[b"stage"]`). May be marked signer.
    StagePda = 1,
    /// Stage input account (stage PDA ATA for SPL / WSOL, or stage PDA for native SOL).
    StageIn = 2,
    /// Stage output account (stage PDA ATA for SPL / WSOL, or stage PDA for native SOL).
    StageOut = 3,
    /// Seat PDA (`[b"seat", commitment]`). Allowed only for `HookKind::Seat`. May be marked signer.
    SeatPda = 4,
    /// Single caller-supplied account. Never a signer.
    Caller = 5,
    /// All remaining caller-supplied accounts (e.g., Jupiter AMM route accounts). Never signers.
    CallerRemaining = 6,
    /// Transaction fee payer (relayer). Allowed only for `HookKind::Seat` (e.g., paying obligation rent).
    Payer = 7,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct AccountSlot {
    pub kind: AccountSlotKind,
    pub is_writable: bool,
    pub is_signer: bool,
    pub pubkey: [u8; 32],
}

/// Permissionless companion instruction required in the same transaction (e.g., Kamino refreshes).
#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct CompanionRequirement {
    pub program_id: [u8; 32],
    pub discriminator: [u8; 8],
    pub disc_len: u8,
    pub must_precede: bool,
}

/// Immutable on-chain Hook record at PDA `[b"hook", hook_id_hash]`.
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Hook {
    pub discriminator: [u8; 8],
    pub hook_id_hash: [u8; 32],
    pub hook_id: String,
    pub author: [u8; 32],
    pub target_program: [u8; 32],
    pub kind: HookKind,
    pub mint_in: MintConstraint,
    pub mint_out: MintConstraint,
    /// If true and runtime `mint_in` is native SOL, wrap into stage WSOL ATA before target CPI.
    pub wrap_sol_in: bool,
    /// If true and runtime `mint_out` is native SOL, unwrap stage WSOL ATA after target CPI and refund ATA rent to payer.
    pub unwrap_sol_out: bool,
    pub data_template: Vec<u8>,
    pub data_slots: Vec<DataSlot>,
    pub account_slots: Vec<AccountSlot>,
    pub companions: Vec<CompanionRequirement>,
    pub bump: u8,
}

/// Per-author, per-mint fee ledger at PDA `[b"author_fees", author, mint]`.
/// For native SOL (`mint == [0u8; 32]`), accrued lamports sit in this PDA above rent exemption.
/// For SPL/Token-2022 mints, accrued tokens sit in the ATA of this PDA for `mint`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct AuthorFees {
    pub discriminator: [u8; 8],
    pub author: [u8; 32],
    pub mint: [u8; 32],
    pub accrued: u64,
    pub bump: u8,
}

impl AuthorFees {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 1;
}

/// Seat state account at PDA `[b"seat_state", commitment]`.
/// The companion signer PDA `[b"seat", commitment]` owns positions at target protocols (e.g. Kamino obligation).
#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Seat {
    pub discriminator: [u8; 8],
    pub commitment: [u8; 32],
    pub opener_relayer: [u8; 32],
    pub opened_at: i64,
    pub seat_pda_bump: u8,
    pub bump: u8,
}

impl Seat {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 1 + 1;
}
