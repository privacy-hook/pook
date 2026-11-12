#[rustfmt::skip]
use spr_program::{verifier::{groth16_solana, public_hash, verify_groth16, Field, VerifyError}, transaction_hash, CompressedProof, PublicTransfer};

include!("seat_fund.vk.rs");

pub struct PublicInputs {
    pub authority_identity: [u8; 32],
    pub seat_commitment: [u8; 32],
    pub hook_hash: [u8; 32],
    pub call_hash: [u8; 32],
    pub amount_in: u64,
    pub min_out: u64,
    pub output_owner_hash: [u8; 32],
    pub relayer_fee: u64,
    pub expiry: u64,
}

#[rustfmt::skip]
impl PublicInputs {
    pub fn hash(&self, transaction_hash: &[u8; 32]) -> Result<[u8; 32], VerifyError> {
        public_hash(&[Field::Hash(&self.authority_identity), Field::Hash(&self.seat_commitment), Field::Hash(&self.hook_hash), Field::Hash(&self.call_hash), Field::Integer(u128::from(self.amount_in)), Field::Integer(u128::from(self.min_out)), Field::Hash(&self.output_owner_hash), Field::Integer(u128::from(self.relayer_fee)), Field::Integer(u128::from(self.expiry))], transaction_hash)
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
