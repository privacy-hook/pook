use spr_program::{
    circuit::{CheckedTransaction, ConfidentialTransaction, PublicInputs, Utxo, UtxoTrait},
    input, require, CircuitError, ClientInputs, Field, ShieldedAddress, TxContext, ZkProgram,
};

use super::shared::spend_two_pook_notes;

/// Proves authorization to run a flow hook from one or two Pook notes:
/// - Spends `input_0` (and optional `input_1`), verifying both are owned by Pook's
///   authority PDA and proving knowledge of each note's one-time `nullifier_secret`.
/// - Withdraws `public.amount_in` to `private.stage_in_account` (bound via
///   `transaction_hash`'s `PublicTransfer` list on chain).
/// - Returns any change to `private.change_owner` (under Pook's authority PDA).
/// - Binds hook, resolved target call hash, minimum out, output owner, relayer fee,
///   and expiry into the single public hash.
#[input]
#[derive(ZkProgram)]
pub struct Run {
    pub private: RunPrivateInputs,
    pub public: RunPublicInputs,
}

#[input]
#[derive(ClientInputs)]
pub struct RunPrivateInputs {
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
pub struct RunPublicInputs {
    /// `solana_owner_identity(authority_pda)`, recomputed on chain.
    pub authority_identity: Field,
    /// `hash_bytes(hook_pda)`, recomputed on chain.
    pub hook_hash: Field,
    /// `Sha256BE` digest of resolved target CPI accounts, writable flags, CPI data, and out mint.
    pub call_hash: Field,
    /// Exact input amount withdrawn to stage.
    pub amount_in: u64,
    /// Minimum output tokens/lamports the target CPI must deliver to stage_out.
    pub min_out: u64,
    /// One-time `owner_hash` receiving the net output note via SPP `deposit`.
    pub output_owner_hash: Field,
    /// Relayer fee taken from the output in the out asset.
    pub relayer_fee: u64,
    /// Unix timestamp deadline checked against `Clock` and `transact.expiry_unix_ts`.
    pub expiry: u64,
}

impl Run {
    pub fn execute(&self) -> Result<CheckedTransaction, CircuitError> {
        let private = &self.private;
        let public = &self.public;

        require(public.amount_in != 0);

        let (tokens_0, tokens_1, mut pool) = spend_two_pook_notes(
            &private.input_0,
            private.nullifier_secret_0,
            &private.input_1,
            private.nullifier_secret_1,
            public.authority_identity,
            private.change_owner.owner(),
        )?;

        pool.withdraw(&public.amount_in, &private.stage_in_account)?;

        ConfidentialTransaction::new(&private.tx_context, public)
            .with(tokens_0)
            .with(tokens_1)
            .with(pool)
            .check()
    }
}
