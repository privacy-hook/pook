//! Holder key derivation, one-time Pook notes (`authority_pda` + one-time `nullifier_secret`),
//! multi-key SPP `ProofAuthority`, and note scanning via Photon.

use anyhow::{anyhow, Result};
use pook_program::{
    circuits::{SeatNote, SEAT_DOMAIN},
    pda::find_authority_pda,
};
use sha2::{Digest, Sha256};
use solana_address::Address;
use spr_client::{ClientError, ProofAuthority, Rpc, TransferInput, UtxoScan};
use spr_hasher::{primitives::solana_owner_identity, Hasher, Poseidon};
use spr_keypair::{NullifierKey, ShieldedAddress, ViewingKey};
use spr_program::{DataUtxo, Field, ProgramOwner, ShieldedPda};
use spr_transaction::{decrypt, AssetRegistry, DecryptionResult, LocalShieldedKeys, WalletUtxo};

const VIEW_DOMAIN: &[u8] = b"POOK/view/v1";
const NF_DOMAIN: &[u8] = b"POOK/nf/v1";
const SEAT_SECRET_DOMAIN: &[u8] = b"POOK/seat/v1";

/// Deterministic Pook holder keys derived from a single 64-byte wallet signature.
#[derive(Clone)]
pub struct HolderKeys {
    seed: [u8; 64],
    authority_pda: Address,
    viewing_key: ViewingKey,
}

impl HolderKeys {
    pub fn from_wallet_signature(signature: [u8; 64]) -> Result<Self> {
        let (authority_pda, _) = find_authority_pda();
        let mut h = Sha256::new();
        h.update(VIEW_DOMAIN);
        h.update(signature);
        let view_secret: [u8; 32] = h.finalize().into();
        let viewing_key = ViewingKey::from_bytes(&view_secret);
        Ok(Self {
            seed: signature,
            authority_pda,
            viewing_key,
        })
    }

    pub fn authority_pda(&self) -> Address {
        self.authority_pda
    }

    pub fn viewing_key(&self) -> &ViewingKey {
        &self.viewing_key
    }

    /// 32-byte big-endian canonical BN254 scalar (`bytes[0] == 0`) for note `index`.
    /// The 31-byte SPP `NullifierKey` uses `bytes[1..32]`.
    pub fn nullifier_secret_bytes(&self, index: u64) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(NF_DOMAIN);
        h.update(self.seed);
        h.update(index.to_le_bytes());
        let mut out: [u8; 32] = h.finalize().into();
        out[0] = 0; // canonical BN254 field element (< Fr::MODULUS)
        out
    }

    pub fn nullifier_secret_field(&self, index: u64) -> Result<Field> {
        spr_program::from_bytes(&self.nullifier_secret_bytes(index))
            .map_err(|e| anyhow!("nullifier secret field: {e:?}"))
    }

    pub fn nullifier_key(&self, index: u64) -> Result<NullifierKey> {
        let full = self.nullifier_secret_bytes(index);
        let mut secret31 = [0u8; 31];
        secret31.copy_from_slice(&full[1..32]);
        Ok(NullifierKey::from_secret(secret31))
    }

    /// One-time `ShieldedPda` for note `index`: owned by `authority_pda` with
    /// `nullifier_key(index)` and the holder's `viewing_key`.
    pub fn one_time_pda(&self, index: u64) -> Result<ShieldedPda> {
        Ok(ShieldedPda::with_viewing_key(
            self.authority_pda,
            self.nullifier_key(index)?,
            self.viewing_key.clone(),
        ))
    }

    /// `LocalShieldedKeys` implementing `ShieldedKeys` for `UtxoScan` and `encrypt_with_keys`.
    pub fn one_time_keys(&self, index: u64) -> Result<LocalShieldedKeys> {
        let pda = self.one_time_pda(index)?;
        let addr = pda
            .shielded_address()
            .map_err(|e| anyhow!("one_time_keys address: {e:?}"))?;
        LocalShieldedKeys::new(addr, vec![self.viewing_key.clone()], self.nullifier_key(index)?)
            .map_err(|e| anyhow!("LocalShieldedKeys::new: {e:?}"))
    }

    pub fn one_time_address(&self, index: u64) -> Result<ShieldedAddress> {
        self.one_time_pda(index)?
            .shielded_address()
            .map_err(|e| anyhow!("one_time_address: {e:?}"))
    }

    pub fn one_time_owner_hash(&self, index: u64) -> Result<[u8; 32]> {
        self.one_time_pda(index)?
            .owner_hash()
            .map_err(|e| anyhow!("one_time_owner_hash: {e:?}"))
    }

    /// Derive 32-byte `seat_secret` for `seat_index`.
    pub fn seat_secret_bytes(&self, seat_index: u64) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(SEAT_SECRET_DOMAIN);
        h.update(self.seed);
        h.update(seat_index.to_le_bytes());
        h.finalize().into()
    }

    /// `Poseidon(SEAT_DOMAIN, hash_bytes(seat_secret))`.
    pub fn seat_commitment(&self, seat_index: u64) -> Result<[u8; 32]> {
        let mut domain = [0u8; 32];
        domain[28..32].copy_from_slice(&SEAT_DOMAIN.to_be_bytes());
        let secret = self.seat_secret_bytes(seat_index);
        let secret_hash = spr_hasher::primitives::hash_bytes(&secret)
            .map_err(|e| anyhow!("seat secret hash: {e:?}"))?;
        Poseidon::hashv(&[&domain, &secret_hash]).map_err(|e| anyhow!("seat commitment: {e:?}"))
    }

    /// Scan Photon for all spendable notes (plain balances + data UTXOs) belonging to one-time key `index`.
    pub fn scan_index(
        &self,
        index: u64,
        assets: &AssetRegistry,
        client: &impl Rpc,
    ) -> Result<Vec<WalletUtxo>> {
        let keys = self.one_time_keys(index)?;
        let res = UtxoScan::new(&keys, assets)
            .fetch(client)
            .map_err(|e| anyhow!("scan index {index}: {e:?}"))?;
        let mut out = Vec::new();
        for utxo in res.spendable.utxos() {
            if utxo.utxo.ring_program_id.is_none() {
                out.push(utxo.clone());
            }
        }
        Ok(out)
    }

    /// Scan Photon for spendable `DataUtxo<SeatNote>` notes belonging to one-time key `index`.
    /// Uses `spr_transaction::decrypt` over the fetched transactions and verifies each candidate
    /// commitment with `DataUtxo::<SeatNote>::try_from` (which populates `data_hash`).
    pub fn scan_seat_notes(
        &self,
        index: u64,
        assets: &AssetRegistry,
        client: &impl Rpc,
    ) -> Result<Vec<DataUtxo<SeatNote>>> {
        let keys = self.one_time_keys(index)?;
        let scan = UtxoScan::new(&keys, assets)
            .fetch(client)
            .map_err(|e| anyhow!("scan seat index {index}: {e:?}"))?;
        let DecryptionResult {
            utxos,
            spent_nullifiers,
            ..
        } = decrypt(&keys, &scan.history.transactions, assets)
            .map_err(|e| anyhow!("decrypt seat index {index}: {e:?}"))?;
        let mut out = Vec::new();
        for utxo in utxos {
            if spent_nullifiers.contains(&utxo.nullifier) || utxo.utxo.ring_program_id.is_some() {
                continue;
            }
            if let Ok(decoded) = DataUtxo::<SeatNote>::try_from(utxo) {
                out.push(decoded);
            }
        }
        Ok(out)
    }

    /// Find a spendable note for `mint` with amount >= `min_amount` at `index`.
    pub fn find_note_at(
        &self,
        index: u64,
        mint: Address,
        min_amount: u64,
        assets: &AssetRegistry,
        client: &impl Rpc,
    ) -> Result<Option<WalletUtxo>> {
        let keys = self.one_time_keys(index)?;
        let res = UtxoScan::new(&keys, assets)
            .fetch(client)
            .map_err(|e| anyhow!("scan index {index}: {e:?}"))?;
        Ok(res
            .spendable
            .balances
            .get_balance(mint)
            .and_then(|b| {
                b.utxos
                    .iter()
                    .find(|u| u.utxo.ring_program_id.is_none() && u.utxo.amount >= min_amount)
                    .cloned()
            }))
    }
}

/// Completes SPP `TransferInput` nullifier secrets across multiple one-time keys
/// (plus the PDA zero nullifier key for `NewAddress` reservations).
pub struct MultiKeyProofAuthority {
    keys: Vec<NullifierKey>,
}

impl MultiKeyProofAuthority {
    pub fn new(keys: Vec<NullifierKey>) -> Self {
        Self { keys }
    }
}

impl ProofAuthority for MultiKeyProofAuthority {
    fn complete_inputs(&self, inputs: &mut [TransferInput]) -> Result<(), ClientError> {
        for input in inputs.iter_mut() {
            if input.nullifier_secret.is_some() {
                continue;
            }
            let single = core::slice::from_mut(input);
            let mut matched = false;
            for key in &self.keys {
                if key.complete_inputs(single).is_ok() {
                    matched = true;
                    break;
                }
            }
            if !matched {
                ProgramOwner::nullifier_key().complete_inputs(single)?;
            }
        }
        Ok(())
    }
}

pub fn authority_identity() -> Result<Field> {
    let (authority_pda, _) = find_authority_pda();
    let bytes = solana_owner_identity(authority_pda.as_array())
        .map_err(|e| anyhow!("authority identity: {e:?}"))?;
    spr_program::from_bytes(&bytes).map_err(|e| anyhow!("authority identity field: {e:?}"))
}
