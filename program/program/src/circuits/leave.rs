use spr_program::{
    circuit::{CheckedTransaction, ConfidentialTransaction, PublicInputs, Utxo, UtxoTrait},
    input, require, CircuitError, ClientInputs, Field, ShieldedAddress, TxContext, ZkProgram,
};

use super::shared::spend_two_pook_notes;

/// Proves authorization to leave Pook (no hook):
/// - Spends one or two Pook notes, proving knowledge of each one-time `nullifier_secret`.
/// - Withdraws `public.amount` to `private.stage_in_account`.
/// - Returns any change to `private.change_owner` under Pook's authority PDA.
/// - Binds destination (`leave_kind == 0` public address; `leave_kind == 1` Rings owner_hash + view_tag),
///   `relayer_fee`, and `expiry`.
#[input]
#[derive(ZkProgram)]
pub struct Leave {
    pub private: LeavePrivateInputs,
    pub public: LeavePublicInputs,
}

#[input]
#[derive(ClientInputs)]
pub struct LeavePrivateInputs {
    pub tx_context: TxContext,
    pub input_0: Utxo,
    pub nullifier_secret_0: Field,
    pub input_1: Utxo,
    pub nullifier_secret_1: Field,
    pub change_owner: ShieldedAddress,
    /// Stage token account (or stage PDA for native SOL) receiving the SPP withdrawal leg.
    pub stage_in_account: [u8; 32],
}

#[input]
#[derive(PublicInputs)]
pub struct LeavePublicInputs {
    pub authority_identity: Field,
    /// `0` = to public Solana wallet/token account, `1` = to Rings private balance via `deposit`.
    pub leave_kind: u8,
    /// `hash_bytes(dest_account)` when `leave_kind == 0`; `dest_owner_hash` when `leave_kind == 1`.
    pub dest_hash: Field,
    /// `Field::zero()` when `leave_kind == 0`; `hash_bytes(dest_view_tag)` when `leave_kind == 1`.
    pub dest_view_tag_hash: Field,
    pub amount: u64,
    pub relayer_fee: u64,
    pub expiry: u64,
}

impl Leave {
    pub fn execute(&self) -> Result<CheckedTransaction, CircuitError> {
        let private = &self.private;
        let public = &self.public;

        require(public.amount != 0);
        require(public.relayer_fee < public.amount);
        require(public.leave_kind <= 1);

        let (tokens_0, tokens_1, mut pool) = spend_two_pook_notes(
            &private.input_0,
            private.nullifier_secret_0,
            &private.input_1,
            private.nullifier_secret_1,
            public.authority_identity,
            private.change_owner.owner(),
        )?;

        pool.withdraw(&public.amount, &private.stage_in_account)?;

        ConfidentialTransaction::new(&private.tx_context, public)
            .with(tokens_0)
            .with(tokens_1)
            .with(pool)
            .check()
    }
}
