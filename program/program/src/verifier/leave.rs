#[rustfmt::skip]
use spr_program::{verifier::{groth16_solana, public_hash, verify_groth16, Field, VerifyError}, transaction_hash, CompressedProof, PublicTransfer};

include!("leave.vk.rs");

pub struct PublicInputs {
    pub authority_identity: [u8; 32],
    pub leave_kind: u8,
    pub dest_hash: [u8; 32],
    pub dest_view_tag_hash: [u8; 32],
    pub amount: u64,
    pub relayer_fee: u64,
    pub expiry: u64,
}

#[rustfmt::skip]
impl PublicInputs {
    pub fn hash(&self, transaction_hash: &[u8; 32]) -> Result<[u8; 32], VerifyError> {
        public_hash(&[Field::Hash(&self.authority_identity), Field::Integer(u128::from(self.leave_kind)), Field::Hash(&self.dest_hash), Field::Hash(&self.dest_view_tag_hash), Field::Integer(u128::from(self.amount)), Field::Integer(u128::from(self.relayer_fee)), Field::Integer(u128::from(self.expiry))], transaction_hash)
    }
}

pub struct Verifier<'a> {
    pub proof: &'a CompressedProof,
    pub public_inputs: PublicInputs,
    pub private_tx_hash: &'a [u8; 32],
    pub transfers: &'a [PublicTransfer],
}

#[rustfmt::skip]
impl Verifier<'_> {
    pub fn verify(&self) -> Result<(), VerifyError> {
        let transaction_hash = transaction_hash(self.private_tx_hash, self.transfers)
            .map_err(|_| VerifyError::PublicInputs)?;
        verify_groth16(self.proof, self.public_inputs.hash(&transaction_hash)?, &VERIFYINGKEY)
    }
}
