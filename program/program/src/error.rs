use pinocchio::error::ProgramError;
use thiserror::Error;

/// Custom error codes for the `pook` program (starting at 7500).
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
#[repr(u32)]
pub enum PookError {
    #[error("invalid instruction data")]
    InvalidInstructionData = 7500,
    #[error("config already initialized")]
    ConfigAlreadyInitialized = 7501,
    #[error("invalid config account")]
    InvalidConfigAccount = 7502,
    #[error("unauthorized admin")]
    UnauthorizedAdmin = 7503,
    #[error("invalid fee rate (exceeds 10000 bps)")]
    InvalidFeeRate = 7504,
    #[error("invalid hook account")]
    InvalidHookAccount = 7505,
    #[error("hook already published")]
    HookAlreadyPublished = 7506,
    #[error("invalid hook definition")]
    InvalidHookDefinition = 7507,
    #[error("invalid authority PDA or bump")]
    InvalidAuthorityPda = 7508,
    #[error("invalid stage PDA or bump")]
    InvalidStagePda = 7509,
    #[error("invalid stage token account")]
    InvalidStageTokenAccount = 7510,
    #[error("stage account must be empty before run")]
    StageNotEmpty = 7511,
    #[error("proof verification failed")]
    ProofVerificationFailed = 7512,
    #[error("public inputs hashing failed")]
    HashingFailed = 7513,
    #[error("proof expired")]
    Expired = 7514,
    #[error("invalid shielded pool program account")]
    InvalidShieldedPoolProgram = 7515,
    #[error("missing authority PDA in transact accounts")]
    MissingAuthorityPda = 7516,
    #[error("forbidden account passed to hook CPI")]
    ForbiddenHookAccount = 7517,
    #[error("target program mismatch")]
    TargetProgramMismatch = 7518,
    #[error("hook output below minimum out")]
    SlippageExceeded = 7519,
    #[error("output insufficient to cover fees")]
    OutputBelowFees = 7520,
    #[error("mint does not match hook constraint")]
    MintConstraintViolated = 7521,
    #[error("required companion instruction missing")]
    MissingCompanionInstruction = 7522,
    #[error("invalid fee recipient or ATA")]
    InvalidFeeRecipient = 7523,
    #[error("invalid author fees account")]
    InvalidAuthorFeesAccount = 7524,
    #[error("unauthorized author")]
    UnauthorizedAuthor = 7525,
    #[error("no accrued author fees to claim")]
    NothingToClaim = 7526,
    #[error("invalid seat account or commitment")]
    InvalidSeatAccount = 7527,
    #[error("seat already open")]
    SeatAlreadyOpen = 7528,
    #[error("seat is not empty or still active")]
    SeatNotClosable = 7529,
    #[error("wrong hook kind for instruction")]
    WrongHookKind = 7530,
    #[error("stage SOL balance drained by target CPI")]
    StageLamportsDrained = 7531,
    #[error("invalid token program")]
    InvalidTokenProgram = 7532,
    #[error("invalid system program")]
    InvalidSystemProgram = 7533,
    #[error("invalid instructions sysvar")]
    InvalidInstructionsSysvar = 7534,
    #[error("arithmetic overflow")]
    Overflow = 7535,
    #[error("relayer fee must be less than amount")]
    InvalidRelayerFee = 7536,
    #[error("invalid leave kind")]
    InvalidLeaveKind = 7537,
    #[error("invalid enter output owner tag")]
    InvalidEnterOwnerTag = 7538,
    #[error("caller accounts mismatch hook template")]
    CallerAccountsMismatch = 7539,
    #[error("hook data slot out of bounds")]
    DataSlotOutOfBounds = 7540,
}

impl From<PookError> for ProgramError {
    fn from(e: PookError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

#[cfg(not(xark))]
impl From<spr_program::verifier::VerifyError> for PookError {
    fn from(e: spr_program::verifier::VerifyError) -> Self {
        match e {
            spr_program::verifier::VerifyError::PublicInputs => Self::HashingFailed,
            spr_program::verifier::VerifyError::Proof => Self::ProofVerificationFailed,
        }
    }
}

#[cfg(not(xark))]
impl From<spr_hasher::HasherError> for PookError {
    fn from(_: spr_hasher::HasherError) -> Self {
        Self::HashingFailed
    }
}
