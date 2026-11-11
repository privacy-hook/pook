use borsh::{BorshDeserialize, BorshSerialize};
use spr_program::{
    circuit::{hash_bytes, TokenUtxos, Utxo, UtxoTrait},
    input, poseidon, require, require_eq, CircuitError, ClientInputs, Field, UtxoOwner, UtxoState,
};
use spr_interface::DUMMY_DOMAIN;

/// Domain tag for seat commitments: `Poseidon(SEAT_DOMAIN, hash_bytes(seat_secret))`.
pub const SEAT_DOMAIN: u32 = u32::from_be_bytes(*b"PKST");

/// Private state carried in a seat data UTXO (`DataUtxo<SeatNote>`).
/// Proves the holder knows the secret behind `seat_commitment` and therefore
/// has the right to command `seat_pda = [b"seat", seat_commitment]`.
#[input]
#[derive(Default, PartialEq, Eq, BorshSerialize, BorshDeserialize, UtxoState, ClientInputs)]
pub struct SeatNote {
    pub seat_secret: [u8; 32],
}

impl SeatNote {
    pub fn commitment(&self) -> Result<Field, CircuitError> {
        poseidon(&[Field::from(SEAT_DOMAIN), hash_bytes(&self.seat_secret)?])
    }
}

/// Assert that `owner` is owned by Pook's `authority_pda` (`authority_identity`)
/// and that the prover knows the one-time `nullifier_secret` whose Poseidon hash
/// equals `owner.nullifier_pk()`.
pub fn assert_pook_note_owner(
    owner: &UtxoOwner,
    authority_identity: Field,
    nullifier_secret: Field,
) -> Result<(), CircuitError> {
    require_eq(owner.key().identity()?, authority_identity);
    require_eq(poseidon(&[nullifier_secret])?, owner.nullifier_pk());
    Ok(())
}

/// Spend `input_0` (required real Pook note) and `input_1` (optional second Pook
/// note, possibly with a different one-time nullifier key, or `Utxo::dummy()`),
/// transferring both balances into `pool` (whose owner is `change_owner` under
/// `authority_pda`).
pub fn spend_two_pook_notes(
    input_0: &Utxo,
    nullifier_secret_0: Field,
    input_1: &Utxo,
    nullifier_secret_1: Field,
    authority_identity: Field,
    change_owner: &UtxoOwner,
) -> Result<(TokenUtxos, TokenUtxos, TokenUtxos), CircuitError> {
    let mut tokens_0 = TokenUtxos::new_mut(core::array::from_ref(input_0))?.close();
    let owner_0 = tokens_0.owner();
    assert_pook_note_owner(&owner_0, authority_identity, nullifier_secret_0)?;

    let asset = tokens_0.asset();
    let is_input_1_dummy = input_1.domain == DUMMY_DOMAIN;
    let mut tokens_1 = TokenUtxos::new_mut(core::array::from_ref(input_1))?
        .with_optional(&input_1.owner, &asset)
        .close();

    // Branchless check for input_1 when real: must also be owned by authority_pda
    // and holder must know nullifier_secret_1.
    let id_1_ok = input_1.owner.key().identity()? == authority_identity;
    let nf_1_ok = poseidon(&[nullifier_secret_1])? == input_1.owner.nullifier_pk();
    require(is_input_1_dummy || (id_1_ok && nf_1_ok));

    // Change must stay under Pook's authority_pda so every Pook note shares the same public tag.
    require_eq(change_owner.key().identity()?, authority_identity);

    let mut pool = TokenUtxos::new_init(change_owner, &asset);
    tokens_0.transfer_all(&mut pool)?;
    tokens_1.transfer_all(&mut pool)?;
    Ok((tokens_0, tokens_1, pool))
}
