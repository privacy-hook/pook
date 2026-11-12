use spr_program::{
    circuit::{
        CheckedTransaction, ConfidentialTransaction, DataUtxo, NewAddress, PublicInputs, Utxo,
        UtxoTrait,
    },
    input, require, require_eq, CircuitError, ClientInputs, Field, ShieldedAddress, TxContext,
    ZkProgram,
};

use super::shared::{assert_pook_note_owner, spend_two_pook_notes, SeatNote};

/// Opens a new Seat by reserving its unique commitment address and minting the
/// initial `DataUtxo<SeatNote>` owned by Pook's authority PDA + holder's one-time key.
#[input]
#[derive(ZkProgram)]
pub struct SeatOpen {
    pub private: SeatOpenPrivateInputs,
    pub public: SeatOpenPublicInputs,
}

#[input]
#[derive(ClientInputs)]
pub struct SeatOpenPrivateInputs {
    pub tx_context: TxContext,
    pub seat_secret: [u8; 32],
    /// Authority PDA under zero nullifier key, required by SPP `NewAddress`.
    pub pda_address_owner: ShieldedAddress,
    /// Holder's one-time owner under Pook's authority PDA receiving the initial seat note.
    pub seat_owner: ShieldedAddress,
}

#[input]
#[derive(PublicInputs)]
pub struct SeatOpenPublicInputs {
    pub authority_identity: Field,
    pub seat_commitment: Field,
    pub expiry: u64,
}

impl SeatOpen {
    pub fn execute(&self) -> Result<CheckedTransaction, CircuitError> {
        let private = &self.private;
        let public = &self.public;

        let note = SeatNote {
            seat_secret: private.seat_secret,
        };
        require_eq(note.commitment()?, public.seat_commitment);
        require_eq(
            private.pda_address_owner.owner().key().identity()?,
            public.authority_identity,
        );
        require_eq(
            private.seat_owner.owner().key().identity()?,
            public.authority_identity,
        );

        let reservation = NewAddress::new(private.pda_address_owner.owner(), &public.seat_commitment)?;
        let mut seat_utxo = DataUtxo::<SeatNote>::new_init(private.seat_owner.owner());
        seat_utxo.seat_secret = private.seat_secret;

        ConfidentialTransaction::new(&private.tx_context, public)
            .with(reservation)
            .with(seat_utxo)
            .check()
    }
}

/// Runs a Seat hook that spends balance notes into the seat (e.g., `kamino.collateral.deposit`,
/// `kamino.repay`): presents and renews the `SeatNote` data UTXO, withdraws `amount_in` from
/// one or two balance notes to `stage_in_account`, and binds hook + resolved call.
#[input]
#[derive(ZkProgram)]
pub struct SeatFund {
    pub private: SeatFundPrivateInputs,
    pub public: SeatFundPublicInputs,
}

#[input]
#[derive(ClientInputs)]
pub struct SeatFundPrivateInputs {
    pub tx_context: TxContext,
    pub seat_input: Utxo,
    pub seat_secret: [u8; 32],
    pub seat_nullifier_secret: Field,
    pub next_seat_owner: ShieldedAddress,
    pub input_0: Utxo,
    pub nullifier_secret_0: Field,
    pub input_1: Utxo,
    pub nullifier_secret_1: Field,
    pub change_owner: ShieldedAddress,
    pub stage_in_account: [u8; 32],
}

#[input]
#[derive(PublicInputs)]
pub struct SeatFundPublicInputs {
    pub authority_identity: Field,
    pub seat_commitment: Field,
    pub hook_hash: Field,
    pub call_hash: Field,
    pub amount_in: u64,
    pub min_out: u64,
    pub output_owner_hash: Field,
    pub relayer_fee: u64,
    pub expiry: u64,
}

impl SeatFund {
    pub fn execute(&self) -> Result<CheckedTransaction, CircuitError> {
        let private = &self.private;
        let public = &self.public;

        require(public.amount_in != 0);

        let state = SeatNote {
            seat_secret: private.seat_secret,
        };
        require_eq(state.commitment()?, public.seat_commitment);

        let spent_seat = DataUtxo::<SeatNote>::new_mut(&private.seat_input, &state)?.close();
        assert_pook_note_owner(
            &spent_seat.owner(),
            public.authority_identity,
            private.seat_nullifier_secret,
        )?;
        require_eq(
            private.next_seat_owner.owner().key().identity()?,
            public.authority_identity,
        );
        let mut renewed_seat = DataUtxo::<SeatNote>::new_init(private.next_seat_owner.owner());
        renewed_seat.seat_secret = private.seat_secret;

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
            .with(spent_seat)
            .with(tokens_0)
            .with(tokens_1)
            .with(renewed_seat)
            .with(pool)
            .check()
    }
}

/// Runs a Seat hook with no input token spend (e.g., `kamino.borrow`, `kamino.collateral.withdraw`):
/// presents and renews the `SeatNote` data UTXO and binds hook, resolved call, `min_out`,
/// `output_owner_hash`, `relayer_fee`, and `expiry`.
#[input]
#[derive(ZkProgram)]
pub struct SeatAction {
    pub private: SeatActionPrivateInputs,
    pub public: SeatActionPublicInputs,
}

#[input]
#[derive(ClientInputs)]
pub struct SeatActionPrivateInputs {
    pub tx_context: TxContext,
    pub seat_input: Utxo,
    pub seat_secret: [u8; 32],
    pub seat_nullifier_secret: Field,
    pub next_seat_owner: ShieldedAddress,
}

#[input]
#[derive(PublicInputs)]
pub struct SeatActionPublicInputs {
    pub authority_identity: Field,
    pub seat_commitment: Field,
    pub hook_hash: Field,
    pub call_hash: Field,
    pub min_out: u64,
    pub output_owner_hash: Field,
    pub relayer_fee: u64,
    pub expiry: u64,
}

impl SeatAction {
    pub fn execute(&self) -> Result<CheckedTransaction, CircuitError> {
        let private = &self.private;
        let public = &self.public;

        let state = SeatNote {
            seat_secret: private.seat_secret,
        };
        require_eq(state.commitment()?, public.seat_commitment);

        let spent_seat = DataUtxo::<SeatNote>::new_mut(&private.seat_input, &state)?.close();
        assert_pook_note_owner(
            &spent_seat.owner(),
            public.authority_identity,
            private.seat_nullifier_secret,
        )?;
        require_eq(
            private.next_seat_owner.owner().key().identity()?,
            public.authority_identity,
        );
        let mut renewed_seat = DataUtxo::<SeatNote>::new_init(private.next_seat_owner.owner());
        renewed_seat.seat_secret = private.seat_secret;

        ConfidentialTransaction::new(&private.tx_context, public)
            .with(spent_seat)
            .with(renewed_seat)
            .check()
    }
}

/// Closes an empty Seat by consuming and burning its `SeatNote` data UTXO.
#[input]
#[derive(ZkProgram)]
pub struct SeatClose {
    pub private: SeatClosePrivateInputs,
    pub public: SeatClosePublicInputs,
}

#[input]
#[derive(ClientInputs)]
pub struct SeatClosePrivateInputs {
    pub tx_context: TxContext,
    pub seat_input: Utxo,
    pub seat_secret: [u8; 32],
    pub seat_nullifier_secret: Field,
}

#[input]
#[derive(PublicInputs)]
pub struct SeatClosePublicInputs {
    pub authority_identity: Field,
    pub seat_commitment: Field,
    pub expiry: u64,
}

impl SeatClose {
    pub fn execute(&self) -> Result<CheckedTransaction, CircuitError> {
        let private = &self.private;
        let public = &self.public;

        let state = SeatNote {
            seat_secret: private.seat_secret,
        };
        require_eq(state.commitment()?, public.seat_commitment);

        let spent_seat = DataUtxo::<SeatNote>::new_mut(&private.seat_input, &state)?.close();
        assert_pook_note_owner(
            &spent_seat.owner(),
            public.authority_identity,
            private.seat_nullifier_secret,
        )?;

        ConfidentialTransaction::new(&private.tx_context, public)
            .with(spent_seat)
            .check()
    }
}
