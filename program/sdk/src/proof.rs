//! Xark proving and verifying-key helpers for the Pook circuits.

use std::path::PathBuf;

use anyhow::{anyhow, Context, Result};
use spr_program::{
    proof::{compressed_proof, SolanaVerifyingKey},
    CompressedProof, ProgramProofInputs,
};
use xark_groth16::PkSource;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CircuitKind {
    Run,
    Leave,
    SeatOpen,
    SeatFund,
    SeatAction,
    SeatClose,
}

impl CircuitKind {
    pub const ALL: [Self; 6] = [
        Self::Run,
        Self::Leave,
        Self::SeatOpen,
        Self::SeatFund,
        Self::SeatAction,
        Self::SeatClose,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::Run => "run",
            Self::Leave => "leave",
            Self::SeatOpen => "seat_open",
            Self::SeatFund => "seat_fund",
            Self::SeatAction => "seat_action",
            Self::SeatClose => "seat_close",
        }
    }
}

/// Directory containing compiled Xark artifacts (`circuit.xbc`, `pk.bin`, `vk.bin`).
/// Uses `POOK_KEYS_DIR`, else `../artifacts`, else `$CARGO_TARGET_DIR/zk/pook-program`, else `../target/zk/pook-program`.
pub fn keys_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("POOK_KEYS_DIR") {
        return PathBuf::from(dir);
    }
    let artifacts = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../artifacts");
    if artifacts.join("run/pk.bin").exists() {
        return artifacts;
    }
    if let Some(target) = std::env::var_os("CARGO_TARGET_DIR") {
        return PathBuf::from(target).join("zk/pook-program");
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/zk/pook-program")
}

fn read_artifact(kind: CircuitKind, file: &str) -> Result<Vec<u8>> {
    let path = keys_dir().join(kind.name()).join(file);
    std::fs::read(&path).with_context(|| {
        format!(
            "reading {}: run `scripts/build-all.sh` to build Pook Xark artifacts",
            path.display()
        )
    })
}

pub fn verifying_key(kind: CircuitKind) -> Result<SolanaVerifyingKey> {
    SolanaVerifyingKey::from_xark(&read_artifact(kind, "vk.bin")?).map_err(anyhow::Error::msg)
}

/// Prove `inputs` with Xark from a clean temp copy of `circuit.xbc` + `pk.bin`
/// and locally verify the proof against `vk.bin` before returning.
pub fn prove(kind: CircuitKind, inputs: &ProgramProofInputs) -> Result<CompressedProof> {
    let vk = verifying_key(kind)?;
    let tmp = tempfile::Builder::new().prefix("pook-circuit-").tempdir()?;
    let dir = tmp.path().join(kind.name());
    std::fs::create_dir(&dir)?;
    for file in ["circuit.xbc", "pk.bin"] {
        std::fs::write(dir.join(file), read_artifact(kind, file)?)?;
    }
    if let Ok(sources) = read_artifact(kind, "sources.json") {
        std::fs::write(dir.join("sources.json"), sources)?;
    }
    let circuit = xark::prover::circuit_at(&dir);
    let proven = circuit.prove(inputs.clone())?;
    let proof = compressed_proof(&proven.proof).map_err(anyhow::Error::msg)?;
    let encoded = inputs.encoded();
    let hash_str = encoded.get("public_hash").context("missing public_hash")?;
    let hash = spr_program::from_decimal(hash_str).map_err(|e| anyhow!("public_hash: {e:?}"))?;
    spr_program::verifier::verify_groth16(&proof, spr_program::to_bytes(&hash), &vk.as_key())
        .map_err(|e| anyhow!("local verify failed for {}: {e:?}", kind.name()))?;
    Ok(proof)
}

pub fn constraint_count(kind: CircuitKind) -> Result<usize> {
    let pk = read_artifact(kind, "pk.bin")?;
    let key = xark_groth16::SerializedPk::from_bytes(&pk)?;
    let rows = xark::prover::rows_for_key(&read_artifact(kind, "circuit.xbc")?, key.header().a_len, None)
        .map_err(anyhow::Error::msg)?;
    Ok(rows.num_constraints())
}
